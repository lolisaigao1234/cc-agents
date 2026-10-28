// Doc authority (ADR 0007): before an agent changes a file in a traced
// repository, it must have read every related doc in full, itself. Which docs
// are related is decided here, never by the agent; what each agent has read
// is recorded from its own tool results, keyed by its session and agent id.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { fold, real } from './paths.mjs'

/**
 * What an agent has read: lines `from`–`to` of a file whose content had
 * `hash`, or the parts of an issue (see `issueKey`) whose texts have `hashes`.
 *
 * @typedef {{ file: string, hash: string, from: number, to: number } | { issue: string, hashes: string[] }} ReadRecord
 */

/**
 * One agent's reads: `records` is null when the hook input does not say which
 * agent it is; `clear` forgets them all.
 *
 * @typedef {{ records(): ReadRecord[] | null, add(record: ReadRecord): void, clear(): void }} Reads
 */

/** @typedef {{ title: string, body: string, comments: { id: string, author: string, body: string, at?: string }[] }} Issue */

/**
 * The glossary and the ADRs as HEAD has them, by path relative to the root;
 * null when git cannot say.
 *
 * @typedef {Record<string, string> | null} HeadDocs
 */

/** @param {string} s */
const sha = s => createHash('sha256').update(s).digest('hex')

/** @param {string} text @returns {string} the text as Read compares it: no BOM, LF for CRLF */
const lf = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

/** @param {string} text @returns {string} the text with its whitespace collapsed, as printed text is compared */
const flat = text => text.normalize('NFC').replace(/\s+/g, ' ').trim()

/** @param {string} root @param {number} n @returns {string} the key a read of issue `n` is kept under */
const issueKey = (root, n) => `${fold(real(root))}#${n}`

/** @param {Buffer} buf @returns {string | null} a doc's text as Read decodes it, or null for a binary file */
export function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  return buf.includes(0) ? null : buf.toString('utf8')
}

/**
 * @param {string} path
 * @returns {{ text: string } | { missing: true } | { unreadable: true }} the file's text, as Read decodes it
 */
function docText(path) {
  try {
    if (!statSync(path).isFile()) return { missing: true }
  } catch {
    return { missing: true }
  }
  try {
    const text = decode(readFileSync(path))
    return text === null ? { unreadable: true } : { text }
  } catch {
    return { unreadable: true }
  }
}

// --- what is related ------------------------------------------------------------

/** An ADR is a numbered markdown file anywhere under docs/adr/. */
const ADR = /^docs\/adr\/(?:.+\/)?\d+-[^/]*\.md$/i

/** @param {string} name relative to the root @returns {boolean} whether it is the glossary or an ADR */
export const isDocName = name => name === 'GLOSSARY.md' || ADR.test(name)

/** Read returns no file larger than this as lines. */
const MAX_DOC = 4 << 20

const INACTIVE = /^(?:superseded|deprecated|rejected)\b/i

/**
 * Whether an ADR with `text` is related to changing `paths`: it is active,
 * and its `applies-to:` globs, if any, match one of them. A list that cannot
 * be read applies to every path, and so does any ADR when `paths` is null.
 *
 * @param {string} text @param {string[] | null} paths relative to the root
 */
function adrApplies(text, paths) {
  if (INACTIVE.test(/^status:\s*["']?([^"'\n]*)/m.exec(frontmatter(text))?.[1]?.trim() ?? '')) return false
  const globs = appliesTo(text)
  return !globs || !paths || paths.some(p => globs.some(g => globRe(g).test(p)))
}

/** @param {string} text @returns {string} an ADR's frontmatter, without its fences */
const frontmatter = text => /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(lf(text))?.[1] ?? ''

/** @param {string} text an ADR @returns {string[] | null} its `applies-to:` globs; null when it has none, or a list that cannot be read */
function appliesTo(text) {
  const at = /^applies-to:[ \t]*(.*)\n?((?:[ \t]+-.*\n?)*)/m.exec(frontmatter(text))
  if (!at) return null
  const unquote = (/** @type {string} */ s) => s.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')
  const [, inline = '', block = ''] = at
  const value = unquote(inline)
  const globs = (value.startsWith('[') ? value.replace(/^\[|\]$/g, '').split(',') : value ? [value] : block.split('\n').map(l => l.replace(/^\s*-/, ''))).map(unquote).filter(Boolean)
  return !globs.length || globs.some(g => /[{}[\],]/.test(g)) ? null : globs
}

/** @param {string} glob @returns {RegExp} a path glob: `**`, `*`, `?`; a pattern without them also matches what is under it */
const globRe = glob => {
  const g = glob.replace(/^\.?\//, '').replace(/\/$/, '')
  const body = g.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, t => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[t] ?? `\\${t}`)
  return new RegExp(`^${body}${/[*?]/.test(g) ? '' : '(?:/.*)?'}$`)
}

/** @param {string} dir @param {string} root @returns {string[]} the files under `dir`, relative to `root` */
function walk(dir, root) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name), root) : [relative(root, join(dir, e.name)).split('\\').join('/')],
    )
  } catch {
    return []
  }
}

/**
 * A related doc: its path relative to the root, its text now (or why there
 * is none), and its text in HEAD.
 *
 * @typedef {{ name: string, path: string, now: ReturnType<typeof docText>, head: string | null }} Doc
 */

/**
 * The related docs for changing `paths` (relative to `root`; null when they
 * cannot be told, so every active ADR counts). The glossary and the ADRs come
 * from HEAD as well as the working tree, so moving, emptying or re-marking
 * one there does not drop it.
 *
 * @param {string} root @param {string[] | null} paths @param {Issue} issue @param {HeadDocs} head
 * @returns {Doc[]}
 */
function relatedDocs(root, paths, issue, head) {
  const names = new Set(['GLOSSARY.md', ...walk(join(root, 'docs', 'adr'), root), ...Object.keys(head ?? {})])
  /** @type {Doc[]} */
  const docs = []
  for (const name of [...names].sort()) {
    if (!isDocName(name)) continue
    const path = join(root, name)
    const now = docText(path)
    const was = head?.[name] ?? null
    const texts = ['text' in now ? now.text : null, was].filter(t => t !== null)
    if (name !== 'GLOSSARY.md' && !('unreadable' in now) && !texts.some(t => adrApplies(t, paths))) continue
    if (!('unreadable' in now) && texts.every(t => t.trim() === '')) continue
    docs.push({ name, path, now, head: was })
  }
  // Every text file under docs/ that the issue body names, by path or by URL,
  // that Read returns as lines: not a notebook, nor one too large.
  for (const [, link = ''] of issue.body.matchAll(/(?:^|[^\w.-])(docs\/[^\s)\]>"'`#?]*[^\s)\]>"'`#?.,;:!])/g)) {
    let name = link
    try {
      name = decodeURI(link)
    } catch {}
    const path = resolve(root, name)
    if (!path.startsWith(`${join(root, 'docs')}/`) || /\.ipynb$/i.test(path) || size(path) > MAX_DOC) continue
    const now = docText(path)
    if (!('text' in now) || now.text.trim() === '') continue
    if (!docs.some(d => d.path === path)) docs.push({ name: relative(root, path), path, now, head: null })
  }
  return docs
}

/** @param {string} path @returns {number} its size, or Infinity when it cannot be told */
const size = path => {
  try {
    return statSync(path).size
  } catch {
    return Infinity
  }
}

/**
 * The names of the related docs for any change, for an agent to be told
 * what it must read; a scoped ADR names the paths it is related to.
 *
 * @param {string} root @param {Issue} issue @param {HeadDocs} head @returns {string[]}
 */
export const relatedDocNames = (root, issue, head) =>
  relatedDocs(root, null, issue, head).map(d => {
    const scopes = [...('text' in d.now ? [d.now.text] : []), ...(d.head === null ? [] : [d.head])].map(appliesTo)
    if (!d.name.startsWith('docs/adr/') || !scopes.length || scopes.some(s => s === null)) return d.name
    return `${d.name} (for edits of ${[...new Set(scopes.flat())].join(', ')}, and any commit)`
  })

/** @param {Issue} issue @returns {{ what: string, text: string, hash: string, comment?: string }[]} the parts of an issue to read */
const issueParts = issue =>
  [
    { what: 'title', text: issue.title },
    { what: 'body', text: issue.body },
    ...issue.comments.map(c => ({ what: `comment ${c.id} by ${c.author}`, text: c.body, comment: c.id })),
  ]
    .filter(p => flat(p.text) !== '')
    .map(p => ({ ...p, hash: sha(flat(p.text)) }))

// --- what has been read ---------------------------------------------------------

/** Only a path that may be a related doc is worth reading back from disk. */
const MAYBE_DOC = /(?:^|\/)GLOSSARY\.md$|\/docs\//i

/**
 * The record a Read tool result makes: the lines it returned, when they are
 * the file's lines as they are now. A truncated or otherwise partial view
 * returns other text and makes none.
 *
 * @param {unknown} response the PostToolUse `tool_response`
 * @returns {ReadRecord | null}
 */
export function fileRecord(response) {
  const file = /** @type {{ file?: Record<string, unknown> } | null} */ (response)?.file
  if (!file) return null
  const { filePath, content, startLine, numLines, totalLines } = file
  if (typeof filePath !== 'string' || typeof content !== 'string') return null
  if (![startLine, numLines, totalLines].every(Number.isInteger) || /** @type {number} */ (startLine) < 1) return null
  const now = docOnDisk(filePath)
  if (!now) return null
  const lines = now.text.split('\n')
  const from = /** @type {number} */ (startLine)
  const to = from + /** @type {number} */ (numLines) - 1
  if (totalLines !== lines.length || to > lines.length) return null
  if (lf(content) !== lines.slice(from - 1, to).join('\n')) return null
  return { file: now.path, hash: sha(now.text), from, to }
}

/** @param {string} filePath @returns {{ path: string, text: string } | null} a path that may be a doc, resolved, and its text as Read compares it */
function docOnDisk(filePath) {
  const path = real(filePath)
  if ((!MAYBE_DOC.test(filePath) && !MAYBE_DOC.test(path)) || size(path) > MAX_DOC) return null
  const now = docText(path)
  return 'text' in now ? { path, text: lf(now.text) } : null
}

/** @param {ReadRecord[]} records @param {string} text as Read compares it @returns {Set<number>} the lines of `text` they cover, under any name */
const coverage = (records, text) => {
  const hash = sha(text)
  return new Set(records.flatMap(r => ('file' in r && r.hash === hash ? range(r.from, r.to) : [])))
}

/**
 * The record an agent's own Write or Edit of a doc makes: the whole file, when
 * the agent knows all of it. A Write knows what it wrote; an Edit knows the
 * file when the agent had read all of it before, and the user did not change
 * the edit.
 *
 * @param {string} filePath
 * @param {{ written: string } | { original: string, expected: string | null, userModified: boolean }} change
 *   `expected`: the original with the edit made, or null when that cannot be told
 * @param {ReadRecord[] | null} records the agent's reads before the change
 * @returns {ReadRecord | null}
 */
export function writeRecord(filePath, change, records) {
  const now = docOnDisk(filePath)
  if (!now) return null
  // The file must hold exactly what the agent made, not what something else wrote since.
  const made = 'written' in change ? change.written : change.expected
  if (made === null || lf(made) !== now.text) return null
  if ('original' in change && (change.userModified || !records || coverage(records, lf(change.original)).size < lf(change.original).split('\n').length)) return null
  return { file: now.path, hash: sha(now.text), from: 1, to: now.text.split('\n').length }
}

/**
 * The records a Bash command's text and shown output make: each part of the
 * linked issue whose whole text they contain, printed or inside JSON, and each
 * doc in HEAD whose whole text they contain (`git show HEAD:<path>`).
 *
 * @param {string} shown what the agent saw: the command and its output
 * @param {string} root @param {number} n
 * @param {Issue | null} issue @param {HeadDocs} head
 * @returns {ReadRecord[]}
 */
export function outputRecords(shown, root, n, issue, head) {
  /** @type {string[]} */
  const strings = [shown]
  /** @param {unknown} v */
  const collect = v => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  for (const chunk of [shown, ...shown.split('\n')]) {
    // Text behind \u escapes was not seen, except the control and HTML-safe escapes JSON encoders add.
    if (/\\u(?!00[01][0-9a-f]|003[ce]|0026|202[89])[0-9a-f]{4}/i.test(chunk)) continue
    try {
      collect(JSON.parse(chunk))
    } catch {}
  }
  const seen = flat(strings.join('\n'))
  /** @type {ReadRecord[]} */
  const records = []
  const hashes = issue ? issueParts(issue).filter(p => seen.includes(flat(p.text))).map(p => p.hash) : []
  if (hashes.length) records.push({ issue: issueKey(root, n), hashes })
  for (const [name, text] of Object.entries(head ?? {})) {
    if (text.trim() === '' || !seen.includes(flat(text))) continue
    records.push({ file: real(join(root, name)), hash: sha(lf(text)), from: 1, to: lf(text).split('\n').length })
  }
  return records
}

// --- the gate --------------------------------------------------------------------

/**
 * Why the agent may not change `paths` yet: the related docs it has not read
 * in full, or has read before they changed. Null once it has read them all.
 *
 * @param {string} root @param {number} n the linked issue
 * @param {string[] | null} paths relative to `root`; null when they cannot be told
 * @param {{ issue: Issue | null, slug: string | null, head: HeadDocs, records: () => ReadRecord[] | null, unknownAgent: string }} world
 *   `unknownAgent` is the refusal for an agent the hook input does not name
 * @returns {string | null}
 */
export function docsVerdict(root, n, paths, { issue, slug, head, records: recorded, unknownAgent }) {
  if (!issue) return `GitHub could not say what #${n}, the linked issue, says, so the trace cannot tell whether it has been read. Read step: the change waits for GitHub; check \`gh auth status\` and the network.`
  const docs = relatedDocs(root, paths, issue, head)
  const parts = issueParts(issue)
  if (!docs.length && !parts.length) return null
  const records = recorded()
  if (records === null) return unknownAgent
  /** @type {string[]} */
  const unread = []
  let [byRead, byCommand] = [false, false]
  for (const doc of docs) {
    if ('unreadable' in doc.now) {
      unread.push(`${doc.name} (cannot be read as text; make it readable)`)
      continue
    }
    const now = 'text' in doc.now && doc.now.text.trim() !== '' ? doc.now.text : null
    const text = lf(now ?? doc.head ?? '')
    const lines = text.split('\n').length
    // The same text read under another name, renamed or saved from HEAD, counts.
    const covered = coverage(records, text)
    const mine = records.filter(r => 'file' in r && fold(r.file) === fold(real(doc.path)))
    const missing = range(1, lines).filter(l => !covered.has(l)).length
    if (!missing) continue
    if (now === null) unread.push(`${doc.name} (gone or empty in the working tree, but in HEAD: \`git show HEAD:${doc.name}\`)`)
    else if (covered.size) unread.push(`${doc.name} (${missing} of its ${lines} lines unread)`)
    else if (mine.length) unread.push(`${doc.name} (stale: changed since this agent read it)`)
    else unread.push(doc.name)
    if (now === null) byCommand = true
    else byRead = true
  }
  const seen = new Set(records.flatMap(r => ('issue' in r && r.issue === issueKey(root, n) ? r.hashes : [])))
  const left = parts.filter(p => !seen.has(p.hash))
  if (left.length) {
    const repo = slug ? ` -R ${slug}` : ''
    const comments = left.filter(p => p.comment)
    const how = [
      ...(left.some(p => !p.comment) ? [`\`gh issue view ${n}${repo}\` for the title and body`] : []),
      ...(!comments.length
        ? []
        : slug
          ? [`\`gh api --paginate repos/${slug}/issues/${n}/comments --jq '.[].body'\` for the comments, or \`gh api repos/${slug}/issues/comments/<id> --jq .body\` for one`]
          : [`\`gh issue view ${n} --comments\``]),
    ]
    unread.push(`issue #${n}: its ${left.map(p => p.what).join(', ')} (${how.join('; ')})`)
    byCommand = true
  }
  if (!unread.length) return null
  const how = [
    ...(byRead ? ['read each file with the Read tool, every line'] : []),
    ...(byCommand ? ['run the commands shown (an output too long to show counts only for its preview: save it to a file outside the repository and Read that)'] : []),
  ]
  return `the related docs are not all read. Unread: ${unread.join('; ')}. Read step: ${how.join(', and ')}, in this agent; reads by its parent or another agent do not count.`
}

/** @param {number} a @param {number} b */
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i)

// --- the record store -----------------------------------------------------------

/** Where the hook keeps each agent's reads; only the hook writes there. */
const STORE = () => join(real(tmpdir()), 'trace-reads')

/** @returns {Buffer} the key every record is signed with, made on first use */
function storeKey() {
  const path = join(STORE(), '.key')
  try {
    return readFileSync(path)
  } catch {
    mkdirSync(STORE(), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' })
    } catch {}
    return readFileSync(path)
  }
}

/**
 * The reads of the agent a hook input comes from: the main session's, or a
 * subagent's by its `agent_id`. Each record is signed for that agent, so a
 * record copied from another agent, or written by hand, does not count.
 * Without a session id, none can be kept.
 *
 * @param {{ session_id?: unknown, agent_id?: unknown }} input
 * @returns {Reads}
 */
export function readsOf(input) {
  const id = /^[\w-]{1,128}$/
  const { session_id: session, agent_id: agent = 'main' } = input
  if (typeof session !== 'string' || !id.test(session) || typeof agent !== 'string' || !id.test(agent)) {
    return { records: () => null, add() {}, clear() {} }
  }
  const dir = join(STORE(), session, agent)
  const mac = (/** @type {string} */ json) => createHmac('sha256', storeKey()).update(`${session}\0${agent}\0${json}`).digest('hex')
  return {
    records() {
      /** @type {string[]} */
      let names = []
      try {
        names = readdirSync(dir)
      } catch {
        return []
      }
      return names.flatMap(name => {
        try {
          const { record, sig } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
          return sig === mac(JSON.stringify(record)) ? [record] : []
        } catch {
          return []
        }
      })
    },
    // One file per record, so parallel tool calls never lose one another's.
    add(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify({ record, sig: mac(JSON.stringify(record)) }), { mode: 0o600, flag: 'wx' })
    },
    clear() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Whether `key` is new: true the first time the hook asks, in any process.
 * The marks live with the read records, where only the hook writes.
 *
 * @param {string} key @returns {boolean}
 */
export function once(key) {
  const dir = join(STORE(), 'once')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(join(dir, createHash('sha256').update(key).digest('hex')), '', { mode: 0o600, flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/**
 * Why a tool may not touch the read records: they are the hook's own.
 *
 * @param {{ path: string } | { command: string }} subject an edited path, or a Bash command's text
 * @returns {string | null}
 */
export function storeVerdict(subject) {
  const store = fold(STORE())
  const touches =
    'path' in subject
      ? fold(subject.path) === store || fold(subject.path).startsWith(`${store}/`)
      : /\/trace-reads(?=$|[/\s'"`;|&)])|(?:^|[^\w.-])trace-reads\//i.test(subject.command)
  return touches ? "these are the trace's records of what each agent has read, and only its hook writes them. Read step: read the docs instead." : null
}
