// Doc authority (ADR 0007): before an agent changes a file in a traced
// repository, it must have read every related doc in full, itself. Which docs
// are related is decided here, never by the agent; what each agent has read
// is recorded from its own tool results, keyed by its session and agent id.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { fold, real } from './paths.mjs'

/**
 * What an agent has read: lines `from`–`to` of a file whose content had
 * `hash`, or the parts of an issue (`<root>#<n>`) whose texts have `hashes`.
 *
 * @typedef {{ file: string, hash: string, from: number, to: number } | { issue: string, hashes: string[] }} ReadRecord
 */

/**
 * One agent's reads: null when the hook input does not say which agent it is.
 *
 * @typedef {{ records(): ReadRecord[] | null, add(record: ReadRecord): void }} Reads
 */

/** @typedef {{ title: string, body: string, comments: { id: string, author: string, body: string }[] }} Issue */

/** @param {string} s */
const sha = s => createHash('sha256').update(s).digest('hex')

/** @param {string} text @returns {string} the text as Read shows it: no BOM, LF line ends */
const lf = text => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

/** @param {string} text @returns {string} the text with its whitespace collapsed, as printed text is compared */
const flat = text => text.normalize('NFC').replace(/\s+/g, ' ').trim()

// --- what is related ------------------------------------------------------------

/**
 * @param {string} text
 * @returns {{ status: string, appliesTo: string[] | null }} an ADR's frontmatter;
 *   `appliesTo` is null when the ADR applies to every path, as it does when the list cannot be read
 */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(lf(text))
  const head = m?.[1] ?? ''
  const status = /^status:\s*["']?([^"'\n]*)/m.exec(head)?.[1]?.trim() ?? ''
  const at = /^applies-to:[ \t]*(.*)\n?((?:[ \t]+-.*\n?)*)/m.exec(head)
  if (!at) return { status, appliesTo: null }
  const [, inline = '', block = ''] = at
  const unquote = (/** @type {string} */ s) => s.trim().replace(/^(["'])(.*)\1$/, '$2')
  const globs = inline.trim().startsWith('[')
    ? inline.trim().replace(/^\[|\]$/g, '').split(',').map(unquote)
    : inline.trim()
      ? [unquote(inline)]
      : block.split('\n').map(l => unquote(l.replace(/^\s*-/, '')))
  const kept = globs.filter(Boolean)
  return { status, appliesTo: kept.length ? kept : null }
}

/** @param {string} glob @returns {RegExp} a path glob: `**`, `*`, `?`, and a trailing `/` for a whole directory */
const globRe = glob =>
  new RegExp(
    `^${glob
      .replace(/^\.?\//, '')
      .replace(/\/$/, '/**')
      .replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, t => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[t] ?? `\\${t}`)}$`,
  )

const INACTIVE = /^(?:superseded|deprecated|rejected)\b/i

/** @param {string} path @returns {string | null} the file's text, or null when it is not a readable file */
function text(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * The related doc files for changing `paths` (relative to `root`; null when
 * they cannot be told, so every ADR counts), as absolute paths.
 *
 * @param {string} root @param {string[] | null} paths @param {Issue} issue
 * @returns {string[]}
 */
function relatedFiles(root, paths, issue) {
  const files = [join(root, 'GLOSSARY.md')]
  const adrs = join(root, 'docs', 'adr')
  /** @type {string[]} */
  let names = []
  try {
    names = readdirSync(adrs).filter(n => n.endsWith('.md')).sort()
  } catch {}
  for (const name of names) {
    const t = text(join(adrs, name))
    if (t === null) continue
    const { status, appliesTo } = frontmatter(t)
    if (INACTIVE.test(status)) continue
    if (appliesTo && paths && !paths.some(p => appliesTo.some(g => globRe(g).test(p.split(sep).join('/'))))) continue
    files.push(join(adrs, name))
  }
  // Every file under docs/ that the issue body links, by path or by URL.
  const docs = join(root, 'docs')
  for (const [, link = ''] of issue.body.matchAll(/(?:^|[^\w.-])(docs\/[^\s)\]>"'`#?]*[^\s)\]>"'`#?.,;:!])/g)) {
    const path = resolve(root, decodeURI(link))
    if (path.startsWith(`${docs}/`)) files.push(path)
  }
  return [...new Set(files)].filter(f => (text(f) ?? '').trim() !== '')
}

/** @param {Issue} issue @returns {{ what: string, hash: string, comment?: string }[]} the parts of an issue to read */
const issueParts = issue =>
  [
    { what: 'title', text: issue.title },
    { what: 'body', text: issue.body },
    ...issue.comments.map(c => ({ what: `comment ${c.id} by ${c.author}`, text: c.body, comment: c.id })),
  ]
    .filter(p => flat(p.text) !== '')
    .map(({ text, ...p }) => ({ ...p, hash: sha(flat(text)) }))

// --- what has been read ---------------------------------------------------------

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
  const path = real(filePath)
  const now = text(path)
  if (now === null) return null
  const lines = lf(now).split('\n')
  const from = /** @type {number} */ (startLine)
  const to = from + /** @type {number} */ (numLines) - 1
  if (totalLines !== lines.length || to > lines.length) return null
  if (lf(content) !== lines.slice(from - 1, to).join('\n')) return null
  return { file: path, hash: sha(lf(now)), from, to }
}

/**
 * The record a Bash command's output makes for issue `n`: every part of the
 * issue whose whole text the output contains, as printed or inside JSON.
 *
 * @param {string} stdout @param {string} key `<root>#<n>` @param {Issue} issue
 * @returns {ReadRecord | null}
 */
export function issueRecord(stdout, key, issue) {
  /** @type {string[]} */
  const strings = [stdout]
  /** @param {unknown} v */
  const collect = v => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  for (const chunk of [stdout, ...stdout.split('\n')]) {
    try {
      collect(JSON.parse(chunk))
    } catch {}
  }
  const seen = flat(strings.join('\n'))
  const hashes = issueParts(issue)
    .filter(p => seen.includes(flat(partText(issue, p))))
    .map(p => p.hash)
  return hashes.length ? { issue: key, hashes } : null
}

/** @param {Issue} issue @param {{ what: string, comment?: string }} part */
const partText = (issue, part) =>
  part.what === 'title' ? issue.title : part.what === 'body' ? issue.body : (issue.comments.find(c => c.id === part.comment)?.body ?? '')

// --- the gate --------------------------------------------------------------------

/**
 * Why the agent may not change `paths` yet: the related docs it has not read
 * in full, or has read before they changed. Null once it has read them all.
 *
 * @param {string} root @param {number} n the linked issue
 * @param {string[] | null} paths relative to `root`; null when they cannot be told
 * @param {{ issue: Issue | null, slug: string | null, reads: Reads }} world
 * @returns {string | null}
 */
export function docsVerdict(root, n, paths, { issue, slug, reads }) {
  const step = 'Read step: read each file with the Read tool, every line, in this agent; reads by its parent or another agent do not count'
  if (!issue) return `GitHub could not say what #${n}, the linked issue, says, so its reading cannot be checked. ${step}, once GitHub answers.`
  const files = relatedFiles(root, paths, issue)
  const parts = issueParts(issue)
  if (!files.length && !parts.length) return null
  const records = reads.records()
  if (records === null) {
    return 'the hook input does not say which agent this is, so the trace cannot tell what it has read. The edit waits; to work untraced, the human can launch Claude Code with TRACE_BYPASS=1.'
  }
  /** @type {string[]} */
  const unread = []
  for (const file of files) {
    const lines = lf(text(file) ?? '').split('\n')
    const hash = sha(lf(text(file) ?? ''))
    const mine = records.filter(r => 'file' in r && fold(r.file) === fold(file))
    const covered = new Set(mine.flatMap(r => ('file' in r && r.hash === hash ? range(r.from, r.to) : [])))
    const missing = lines.length - range(1, lines.length).filter(l => covered.has(l)).length
    const name = relative(root, file)
    if (!missing) continue
    if (covered.size) unread.push(`${name} (${missing} of its ${lines.length} lines unread)`)
    else if (mine.length) unread.push(`${name} (changed since this agent read it)`)
    else unread.push(name)
  }
  const seen = new Set(records.flatMap(r => ('issue' in r && r.issue === `${root}#${n}` ? r.hashes : [])))
  const left = parts.filter(p => !seen.has(p.hash))
  if (left.length) {
    const repo = slug ? ` -R ${slug}` : ''
    const comments = left.filter(p => p.comment)
    const how = [
      ...(left.some(p => !p.comment) ? [`\`gh issue view ${n}${repo}\``] : []),
      ...(comments.length > 3 || !slug ? [`\`gh issue view ${n}${repo} --comments\``] : comments.map(p => `\`gh api repos/${slug}/issues/comments/${p.comment} --jq .body\``)),
    ]
    unread.push(`issue #${n}: its ${left.map(p => p.what).join(', ')} (${how.join(', ')})`)
  }
  if (!unread.length) return null
  return `the related docs are not all read. Unread: ${unread.join('; ')}. ${step}${left.length ? '; run the gh commands shown for the issue' : ''}.`
}

/** @param {number} a @param {number} b */
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i)

// --- the record store -----------------------------------------------------------

/** Where the hook keeps each agent's reads; only the hook writes there. */
const STORE = () => join(real(tmpdir()), 'trace-reads')

/**
 * The reads of the agent a hook input comes from: the main session's, or a
 * subagent's by its `agent_id`. Without a session id, none can be kept.
 *
 * @param {{ session_id?: unknown, agent_id?: unknown }} input
 * @returns {Reads}
 */
export function readsOf(input) {
  const id = /^[\w-]{1,128}$/
  const { session_id: session, agent_id: agent = 'main' } = input
  if (typeof session !== 'string' || !id.test(session) || typeof agent !== 'string' || !id.test(agent)) {
    return { records: () => null, add() {} }
  }
  const dir = join(STORE(), session, agent)
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
          return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]
        } catch {
          return []
        }
      })
    },
    // One file per record, so parallel tool calls never lose one another's.
    add(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    },
  }
}

/**
 * Why a tool may not touch the read records: they are the hook's own.
 *
 * @param {string} subject an edited path, or a Bash command's text
 * @returns {string | null}
 */
export const storeVerdict = subject =>
  /\/trace-reads\b/i.test(subject) ? "these are the trace's records of what each agent has read, and only its hook writes them. Read step: read the docs instead." : null
