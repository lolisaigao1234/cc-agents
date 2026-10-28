// Git plumbing for the loop: diffs against the base, and checkpoints of the
// whole working tree. Taking a checkpoint never touches the user's index, HEAD
// or stash; reverting to one puts the index back as it was at the checkpoint.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The loop's own files never belong to a checkpoint or a review diff.
export const LOOP_DIR = '.quality-loop'
const EXCLUDE = `:(exclude)${LOOP_DIR}`
// What a checkpoint records besides the working tree lives under this path in
// the checkpoint tree. Every diff excludes LOOP_DIR, so it never shows up.
const META = `${LOOP_DIR}/checkpoint`
// Where a revert moves the files it removes, so nothing is destroyed outright.
const TRASH = `${LOOP_DIR}/trash`
const MAX_BUFFER = 256 * 1024 * 1024

const GITLINK = '160000'
const SYMLINK = '120000'
const EXECUTABLE = '100755'
const NO_MODE = '000000'
// Attributes that make `git add` store something other than the file's bytes.
const CONVERSION_ATTRS = ['filter', 'text', 'eol', 'crlf', 'ident', 'working-tree-encoding']

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, input?: string, allowFail?: boolean }} opts
 */
export function git(args, opts) {
  return run(args, opts, 'utf8')
}

/**
 * Like `git`, but stdin and stdout carry raw bytes as latin1 strings (one char
 * per byte), so path names that are not valid UTF-8 survive the round trip.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, input?: string, allowFail?: boolean }} opts
 */
function gitRaw(args, opts) {
  return run(args, opts, 'latin1')
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, input?: string, allowFail?: boolean }} opts
 * @param {'utf8' | 'latin1'} encoding
 */
function run(args, opts, encoding) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input === undefined ? undefined : Buffer.from(opts.input, encoding),
    encoding,
    maxBuffer: MAX_BUFFER,
  })
  if (r.error) throw r.error
  const stderr = encoding === 'latin1' ? shown(r.stderr) : r.stderr
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${stderr.trim()}`)
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr }
}

/** A raw (latin1) path as text for people. @param {string} p */
function shown(p) {
  return Buffer.from(p, 'latin1').toString('utf8')
}

/** A raw (latin1) repo-relative path as an exact file-system path. @param {string} root @param {string} p */
function onDisk(root, p) {
  return Buffer.concat([Buffer.from(`${root}/`, 'utf8'), Buffer.from(p, 'latin1')])
}

/** @param {string} p */
function parentOf(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** @param {string} cwd */
export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true })
  return r.ok ? r.stdout.trim() : null
}

/** @param {string} root @param {string} ref */
export function revParse(root, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, allowFail: true })
  return r.ok ? r.stdout.trim() : null
}

/**
 * The commit a change is reviewed against. `auto` is the merge-base with the
 * default branch when HEAD has moved off it, otherwise HEAD itself (so
 * uncommitted work on the default branch is what gets reviewed).
 *
 * @param {string} root
 * @param {string} ref
 */
export function resolveBase(root, ref) {
  if (ref !== 'auto') {
    const sha = revParse(root, ref)
    if (!sha) throw new Error(`base ref "${ref}" does not resolve to a commit`)
    return sha
  }
  const head = revParse(root, 'HEAD')
  if (!head) throw new Error('the repository has no commits yet; commit once so there is a base to review against')
  const originHead = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root, allowFail: true })
  const candidates = [originHead.ok ? originHead.stdout.trim() : '', 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)
  for (const c of candidates) {
    const sha = revParse(root, c)
    if (!sha) continue
    if (sha === head) return head
    const mb = git(['merge-base', 'HEAD', sha], { cwd: root, allowFail: true })
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim()
  }
  return head
}

/**
 * Runs `fn` against a private copy of the repository's index.
 *
 * @template T
 * @param {string} root
 * @param {(env: Record<string, string>) => T} fn
 */
function withTempIndex(root, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ql-index-'))
  const index = join(dir, 'index')
  try {
    // Start from the real index so unchanged files reuse its stat cache.
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: root }).stdout.trim()
    if (existsSync(real)) {
      copyFileSync(real, index)
      // Keep the real index's mtime (rounded down). Git trusts cached stat data
      // only for entries older than the index file, so a copy stamped "now"
      // would hide a same-size edit made in the second the index was written.
      const st = statSync(real)
      utimesSync(index, st.atime, Math.floor(st.mtimeMs / 1000))
    }
    return fn({ GIT_INDEX_FILE: index })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Stages the whole working tree (minus ignored files and the loop's own
 * directory) into the index named by `env`. Returns the raw paths git could
 * not read (an unreadable file, a nested repo with no commit): they are left
 * out of the index, so a tracked file the round made unreadable shows up as
 * removed instead of silently keeping its old content.
 *
 * @param {string} root
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function stageWorktree(root, env) {
  // --ignore-errors: skip what cannot be indexed rather than failing the
  // snapshot. Exit 1 means "some files skipped"; anything else is a failure.
  const add = git(['add', '-A', '--ignore-errors', '--', '.', EXCLUDE], { cwd: root, env, allowFail: true })
  if (!add.ok && add.status !== 1) throw new Error(`git add -A failed (${add.status}): ${add.stderr.trim()}`)
  // Drop loop files that a copied real index may already hold.
  git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', LOOP_DIR], { cwd: root, env })
  // A directory git cannot open draws only a warning, so a clean exit with
  // something on stderr still needs the scan below.
  if (add.ok && !add.stderr.trim()) return []
  /** @type {string[]} */ let stale = []
  if (!add.ok) {
    // A skipped tracked file keeps the copied index entry (its old content):
    // after `add` refreshed everything else, those are the entries still stale.
    stale = nulList(gitRaw(['diff-files', '-z', '--name-only', '--ignore-submodules', '--', '.', EXCLUDE], { cwd: root, env }).stdout)
    if (stale.length) {
      gitRaw(['update-index', '-z', '--force-remove', '--stdin'], { cwd: root, env, input: stale.map(p => `${p}\0`).join('') })
    }
  }
  const lsOther = (/** @type {string[]} */ flags) =>
    nulList(gitRaw(['ls-files', '-z', '-o', '--exclude-standard', ...flags, '--', '.', EXCLUDE], { cwd: root, env }).stdout)
  const untracked = lsOther([])
  // An unreadable directory lists none of its files above. `--directory` names
  // it, along with empty directories and ones holding only ignored files (git
  // calls an unreadable one empty too), so look at those on disk.
  const candidates = lsOther(['--directory']).filter(d => d.endsWith('/') && !untracked.some(u => u.startsWith(d)))
  /** @type {string[]} */ const unreadable = []
  if (candidates.length) {
    const ignoredDirs = new Set(lsOther(['--directory', '--ignored']).filter(d => d.endsWith('/')))
    const walk = (/** @type {string} */ d) => {
      /** @type {import('node:fs').Dirent<Buffer>[]} */ let entries
      try {
        entries = readdirSync(onDisk(root, d.slice(0, -1)), { withFileTypes: true, encoding: 'buffer' })
      } catch {
        unreadable.push(d)
        return
      }
      for (const e of entries) {
        const child = `${d}${e.name.toString('latin1')}/`
        if (e.isDirectory() && !ignoredDirs.has(child)) walk(child)
      }
    }
    candidates.forEach(walk)
  }
  return [...new Set([...stale, ...untracked, ...unreadable])]
}

/** @param {string} out NUL-separated list */
function nulList(out) {
  return out.split('\0').filter(Boolean)
}

/** @param {string} root @returns {{ tree: string, skipped: string[] }} */
function worktreeTree(root) {
  return withTempIndex(root, env => {
    const skipped = stageWorktree(root, env)
    return { tree: git(['write-tree'], { cwd: root, env }).stdout.trim(), skipped }
  })
}

/**
 * @typedef {{ mode: string, sha: string, path: string }} IndexEntry
 * @param {string} root
 * @param {Record<string, string>} env
 * @returns {IndexEntry[]}
 */
function listIndex(root, env) {
  /** @type {IndexEntry[]} */ const out = []
  for (const rec of gitRaw(['ls-files', '-s', '-z'], { cwd: root, env }).stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t([^]*)$/.exec(rec)
    if (m) out.push({ mode: String(m[1]), sha: String(m[2]), path: String(m[3]) })
  }
  return out
}

/**
 * Parses `-z --raw` output of diff-tree / diff-index.
 *
 * @param {string} out
 * @returns {{ srcMode: string, dstMode: string, srcSha: string, dstSha: string, status: string, path: string }[]}
 */
function parseRawDiff(out) {
  const parts = out.split('\0')
  const changes = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(String(parts[i]))
    const path = parts[i + 1]
    if (!m || !path) continue
    changes.push({ srcMode: String(m[1]), dstMode: String(m[2]), srcSha: String(m[3]), dstSha: String(m[4]), status: String(m[5]), path })
  }
  return changes
}

/** @param {string} root @param {string} content raw bytes as latin1 */
function writeBlob(root, content) {
  return gitRaw(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: root, input: content }).stdout.trim()
}

/**
 * Reads blobs by id, as raw bytes.
 *
 * @param {string} root
 * @param {string[]} shas
 * @returns {Map<string, Buffer>}
 */
function readBlobs(root, shas) {
  /** @type {Map<string, Buffer>} */ const out = new Map()
  const wanted = [...new Set(shas)]
  if (!wanted.length) return out
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: wanted.join('\n') + '\n', maxBuffer: MAX_BUFFER })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git cat-file --batch failed (${r.status}): ${r.stderr.toString().trim()}`)
  const buf = r.stdout
  let pos = 0
  for (const sha of wanted) {
    const nl = buf.indexOf(10, pos)
    if (nl < 0) break
    const header = buf.toString('latin1', pos, nl).split(' ')
    if (header[1] === 'missing') {
      pos = nl + 1
      continue
    }
    const size = Number(header[2])
    out.set(sha, buf.subarray(nl + 1, nl + 1 + size))
    pos = nl + 1 + size + 1
  }
  return out
}

/**
 * The real index as a tree, or '' when it cannot be one (unmerged entries).
 * Written from a copy because write-tree may rewrite the index it reads.
 *
 * @param {string} root
 */
function realIndexTree(root) {
  return withTempIndex(root, env => {
    const r = git(['write-tree'], { cwd: root, env, allowFail: true })
    return r.ok ? r.stdout.trim() : ''
  })
}

/**
 * What a nested repository (a gitlink) holds: its HEAD plus a snapshot of its
 * working tree, so edits inside it are noticed even though the outer tree only
 * records the commit.
 *
 * @param {string} root
 * @param {string} p raw path of the gitlink
 */
function nestedState(root, p) {
  const text = shown(p)
  if (Buffer.from(text, 'utf8').toString('latin1') !== p) return 'unknown'
  const dir = join(root, text)
  if (!existsSync(join(dir, '.git'))) return 'absent'
  try {
    return `${revParse(dir, 'HEAD') ?? ''} ${worktreeTree(dir).tree}`
  } catch {
    return 'unknown'
  }
}

/** @param {string} root */
function autocrlfOn(root) {
  const v = git(['config', '--get', 'core.autocrlf'], { cwd: root, allowFail: true }).stdout.trim().toLowerCase()
  return ['true', 'yes', 'on', '1', 'input'].includes(v)
}

/**
 * @param {Record<string, string>} a check-attr values for one path
 * @param {boolean} autocrlf
 */
function converts(a, autocrlf) {
  const has = (/** @type {string | undefined} */ v) => v !== undefined && v !== 'unspecified' && v !== 'unset'
  if (has(a.filter) || a.ident === 'set' || has(a['working-tree-encoding'])) return true
  if (a.text === 'unset' || a.crlf === 'unset') return false
  return has(a.text) || has(a.eol) || has(a.crlf) || autocrlf
}

/**
 * The raw bytes' blob id of each file (no clean filter, no eol conversion).
 * A file that cannot be read is left out of the result.
 *
 * @param {string} root
 * @param {string[]} paths raw repo-relative paths
 * @param {boolean} write store the blobs in the object database
 * @returns {Map<string, string>}
 */
function hashRaw(root, paths, write) {
  /** @type {Map<string, string>} */ const out = new Map()
  if (!paths.length) return out
  const args = ['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--stdin-paths']
  // --stdin-paths reads lines and C-unquotes a line that starts with '"', so
  // quoting every path keeps a leading quote, a newline or a CR intact.
  const line = (/** @type {string} */ p) => `"${p.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"\n`
  const all = gitRaw(args, { cwd: root, input: paths.map(line).join(''), allowFail: true })
  if (all.ok) {
    const shas = all.stdout.split('\n')
    paths.forEach((p, i) => shas[i] && out.set(p, String(shas[i])))
    return out
  }
  // One unreadable file stops the batch: hash one by one, skipping failures.
  for (const p of paths) {
    const r = gitRaw(args, { cwd: root, input: line(p), allowFail: true })
    if (r.ok && r.stdout.trim()) out.set(p, r.stdout.trim())
  }
  return out
}

/**
 * `git add` runs clean filters and eol conversion, so the staged blob of such a
 * file is not its bytes on disk, and a change to only the bytes it strips does
 * not show in a tree diff. For every such file the checkpoint also records the
 * raw bytes: a revert compares against and writes back those.
 *
 * @param {string} root
 * @param {Record<string, string>} env
 * @param {IndexEntry[]} entries
 * @returns {string[]} index-info records
 */
function rawOverrides(root, env, entries) {
  const files = entries.filter(e => e.mode === '100644' || e.mode === EXECUTABLE)
  if (!files.length) return []
  const autocrlf = autocrlfOn(root)
  const attrOut = gitRaw(['check-attr', '-z', '--stdin', ...CONVERSION_ATTRS], {
    cwd: root,
    env,
    input: files.map(f => `${f.path}\0`).join(''),
  }).stdout.split('\0')
  /** @type {Map<string, Record<string, string>>} */ const attrs = new Map()
  for (let i = 0; i + 2 < attrOut.length; i += 3) {
    const path = String(attrOut[i])
    const rec = attrs.get(path) ?? {}
    rec[String(attrOut[i + 1])] = String(attrOut[i + 2])
    attrs.set(path, rec)
  }
  const candidates = files.filter(f => converts(attrs.get(f.path) ?? {}, autocrlf))
  const raw = hashRaw(root, candidates.map(c => c.path), true)
  return candidates.flatMap(c => {
    const sha = raw.get(c.path)
    return sha ? [`${c.mode} ${sha}\t${META}/raw/${c.path}\0`] : []
  })
}

// Markers of a git operation in progress, in the order a revert ends them, and
// the commands to try for each until one works. A rebase is aborted, which puts
// HEAD back on the branch it started from (quitting would leave HEAD detached
// and lose the way back); a merge is aborted, or else quit, since the revert
// rewrites the index and working tree anyway. The others are quit, leaving
// HEAD where it is: aborting them would move a branch.
/** @type {[string, ...string[][]][]} */
const IN_PROGRESS = [
  ['rebase-apply/applying', ['am', '--quit']],
  ['rebase-merge', ['rebase', '--abort']],
  ['rebase-apply', ['rebase', '--abort']],
  ['MERGE_HEAD', ['merge', '--abort'], ['merge', '--quit']],
  ['CHERRY_PICK_HEAD', ['cherry-pick', '--quit']],
  ['REVERT_HEAD', ['revert', '--quit']],
  ['sequencer', ['cherry-pick', '--quit']],
]

/** Which in-progress markers exist now. @param {string} root */
function inProgress(root) {
  const args = IN_PROGRESS.flatMap(([m]) => ['--git-path', m])
  const at = git(['rev-parse', '--path-format=absolute', ...args], { cwd: root }).stdout.split('\n')
  return IN_PROGRESS.filter((_, i) => at[i] && existsSync(String(at[i]))).map(([m]) => m)
}

/** The branch HEAD is on (`refs/heads/...`), or '' when detached. @param {string} root */
function symbolicHead(root) {
  const r = git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, allowFail: true })
  return r.ok ? r.stdout.trim() : ''
}

/**
 * Every local and remote-tracking branch with the commit it points at, as
 * `<sha> <ref>` lines, so a revert can tell commits the round made from ones
 * that were already there, and see a branch the round moved.
 *
 * @param {string} root
 */
function refTips(root) {
  const out = git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes'], { cwd: root }).stdout
  return out.split('\n').filter(Boolean)
}

/**
 * Paths the index holds as intent-to-add (`git add -N`): `tree` is the index
 * written as a tree, which leaves them out.
 *
 * @param {string} root
 * @param {string} tree
 * @param {Record<string, string>} [env]
 */
function intentToAdd(root, tree, env) {
  const args = ['diff-index', '--cached', '--name-only', '-z', '--no-renames', '--ita-visible-in-index', tree, '--', '.', EXCLUDE]
  return nulList(gitRaw(args, { cwd: root, env }).stdout)
}

/**
 * Parses `git status --porcelain=v2 -z` for untracked (`?`) and ignored (`!`)
 * paths.
 *
 * @param {string} out
 */
function untrackedAndIgnored(out) {
  const recs = out.split('\0')
  /** @type {string[]} */ const paths = []
  for (let i = 0; i < recs.length; i++) {
    const rec = String(recs[i])
    if (rec.startsWith('? ') || rec.startsWith('! ')) paths.push(rec.slice(2))
    else if (rec.startsWith('2 ')) i++ // a rename record carries its source path next
  }
  return paths
}

/**
 * Writes the whole working tree (tracked and untracked, minus ignored files
 * and the loop's own directory) as a git tree object and returns its id. The
 * user's index, HEAD and stash are untouched. This is the cheap snapshot for
 * diffs; a round's revert target comes from `checkpointTree`.
 *
 * @param {string} root
 */
export function snapshotTree(root) {
  return worktreeTree(root).tree
}

/**
 * A snapshot a round can be reverted to. Under `.quality-loop/checkpoint/`
 * (never part of a diff) the tree also records what a faithful revert needs:
 * the time, HEAD and the branch it is on, the branch tips, the real index as a tree and its
 * intent-to-add entries, git operations in progress, the paths on disk that
 * the tree does not hold (ignored as matched by an ignore rule, or
 * unreadable), the state of nested repositories and the raw bytes of files
 * that a filter or eol conversion changes on the way in.
 *
 * @param {string} root
 */
export function checkpointTree(root) {
  const time = Date.now()
  const head = revParse(root, 'HEAD') ?? ''
  const branch = symbolicHead(root)
  const tips = refTips(root)
  const indexTree = realIndexTree(root)
  const ita = indexTree ? intentToAdd(root, indexTree) : []
  const ops = inProgress(root)
  return withTempIndex(root, env => {
    const skipped = stageWorktree(root, env)
    const entries = listIndex(root, env)
    // After staging, what is still untracked could not be read; `matching`
    // lists an ignored directory only when a rule ignores it as a whole, and
    // otherwise the ignored files in it, so an empty directory or one holding
    // only ignored files does not cover files created in it later. A
    // directory git cannot open shows up in neither list but in `skipped`.
    const status = gitRaw(
      ['status', '--porcelain=v2', '-z', '--no-renames', '--ignored=matching', '--untracked-files=all', '--ignore-submodules=all', '--', '.', EXCLUDE],
      { cwd: root, env },
    ).stdout
    const offTree = [...new Set([...untrackedAndIgnored(status), ...skipped])]
    const nested = entries
      .filter(e => e.mode === GITLINK)
      .map(e => `${e.path}\0${nestedState(root, e.path)}\0`)
      .join('')
    /** @type {[string, string][]} */
    const blobs = [
      ['time', String(time)],
      ['head', head],
      ['branch', branch],
      ['refs', tips.join('\n')],
      ['index', indexTree],
      ['ita', ita.map(p => `${p}\0`).join('')],
      ['ops', ops.map(o => `${o}\0`).join('')],
      ['off-tree', offTree.map(p => `${p}\0`).join('')],
      ['nested', nested],
    ]
    const records = [
      ...blobs.map(([name, content]) => `100644 ${writeBlob(root, content)}\t${META}/${name}\0`),
      ...rawOverrides(root, env, entries),
    ]
    gitRaw(['update-index', '-z', '--add', '--index-info'], { cwd: root, env, input: records.join('') })
    return git(['write-tree'], { cwd: root, env }).stdout.trim()
  })
}

/**
 * The local branches in a `refs` record and the commits they pointed at.
 *
 * @param {string} text
 */
function branchesOf(text) {
  /** @type {Map<string, string>} */ const out = new Map()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]+) (refs\/heads\/.+)$/.exec(line)
    if (m) out.set(String(m[2]), String(m[1]))
  }
  return out
}

/**
 * @typedef {{
 *   time: number,
 *   head: string,
 *   branch: string | null,
 *   refs: string[] | null,
 *   branches: Map<string, string> | null,
 *   index: string,
 *   ita: Set<string> | null,
 *   ops: string[] | null,
 *   offTree: Set<string>,
 *   nested: Map<string, string>,
 *   raw: Map<string, { mode: string, sha: string }>,
 * }} CheckpointMeta
 * @param {string} root
 * @param {string} tree
 * @returns {CheckpointMeta}
 */
function readCheckpoint(root, tree) {
  /** @type {Map<string, string>} */ const files = new Map()
  /** @type {CheckpointMeta['raw']} */ const raw = new Map()
  for (const rec of gitRaw(['ls-tree', '-r', '-z', tree, '--', META], { cwd: root }).stdout.split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([^]*)$/.exec(rec)
    if (!m) continue
    const name = String(m[3]).slice(META.length + 1)
    if (name.startsWith('raw/')) raw.set(name.slice(4), { mode: String(m[1]), sha: String(m[2]) })
    else files.set(name, String(m[2]))
  }
  const blobs = readBlobs(root, [...files.values()])
  const text = (/** @type {string} */ name) => {
    const sha = files.get(name)
    return (sha && blobs.get(sha)?.toString('latin1')) || ''
  }
  const nestedParts = text('nested').split('\0')
  /** @type {Map<string, string>} */ const nested = new Map()
  for (let i = 0; i + 1 < nestedParts.length; i += 2) nested.set(String(nestedParts[i]), String(nestedParts[i + 1]))
  return {
    // no record (an older checkpoint): every kept file counts as touched
    time: Number(text('time')) || 0,
    head: text('head'),
    // null: an older checkpoint that did not record it
    branch: files.has('branch') ? text('branch') : null,
    // `<sha> <ref>` lines; an older checkpoint recorded the shas alone
    refs: files.has('refs') ? text('refs').split('\n').filter(Boolean).map(l => /** @type {string} */ (l.split(' ')[0])) : null,
    branches: text('refs').includes(' ') ? branchesOf(text('refs')) : null,
    index: text('index'),
    ita: files.has('ita') ? new Set(nulList(text('ita'))) : null,
    ops: files.has('ops') ? nulList(text('ops')) : null,
    offTree: new Set(nulList(text('off-tree'))),
    nested,
    raw,
  }
}

/**
 * Was `p` on disk at the checkpoint without being in its tree (ignored,
 * unreadable, or inside a directory ignored as a whole)?
 *
 * @param {Set<string>} offTree
 * @param {string} p
 */
function wasOffTree(offTree, p) {
  if (offTree.has(p)) return true
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
    if (offTree.has(p.slice(0, i + 1))) return true
  }
  return false
}

/** @param {string} root @param {string} p @param {string} trash */
function moveAside(root, p, trash) {
  const ignore = join(root, TRASH, '.gitignore')
  if (!existsSync(ignore)) {
    // The trash ignores itself, so set-aside files never show up in `git status`.
    mkdirSync(join(root, TRASH), { recursive: true })
    writeFileSync(ignore, '*\n')
  }
  const dest = `${trash}/${p}`
  mkdirSync(onDisk(root, parentOf(dest)), { recursive: true })
  renameSync(onDisk(root, p), onDisk(root, dest))
}

/**
 * Did `p` change on disk (content, mode or creation) at or after `time`?
 * ctime moves on every such change and cannot be set back by the round.
 *
 * @param {string} root @param {string} p @param {number} time ms since the epoch
 */
function touchedSince(root, p, time) {
  const st = lstatOrNull(onDisk(root, p))
  // whole milliseconds: a file written just before the checkpoint, in the same ms, is not "since"
  return !st || st.ctimeMs >= time + 1
}

/** @param {Buffer} at */
function lstatOrNull(at) {
  try {
    return lstatSync(at)
  } catch {
    return null
  }
}

/**
 * Writes a checkpoint entry's exact bytes to `p`, replacing whatever is there.
 *
 * @param {string} root @param {string} p @param {string} mode @param {Buffer} data @param {string} trash
 */
function writeEntry(root, p, mode, data, trash) {
  const at = onDisk(root, p)
  const st = lstatOrNull(at)
  // A directory where the checkpoint had a file holds only what the round made.
  if (st?.isDirectory()) moveAside(root, p, trash)
  else if (st) unlinkSync(at)
  const parent = parentOf(p)
  if (parent) mkdirSync(onDisk(root, parent), { recursive: true })
  if (mode === SYMLINK) symlinkSync(data, at)
  else writeFileSync(at, data, { mode: mode === EXECUTABLE ? 0o777 : 0o666 })
}

/**
 * Puts the user's real index back to its state at the checkpoint, entry by
 * entry, intent-to-add entries included.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 */
function restoreIndex(root, meta, problems) {
  // No record: a legacy checkpoint, or an index with conflicts at the time.
  if (!meta.index) return
  // Intent-to-add entries are not in meta.index: leave them out of this
  // comparison and put them back as recorded below.
  const diff = gitRaw(['diff-index', '--cached', '--raw', '-z', '--no-renames', '--ita-invisible-in-index', meta.index, '--', '.', EXCLUDE], {
    cwd: root,
    allowFail: true,
  })
  if (!diff.ok) {
    problems.push(`could not compare the index with the round start: ${diff.stderr.trim()}`)
    return
  }
  /** @type {Map<string, { mode: string, sha: string }> | null} */ let startEntries = null
  const startEntry = (/** @type {string} */ p) => {
    if (!startEntries) {
      startEntries = new Map()
      for (const rec of gitRaw(['ls-tree', '-r', '-z', meta.index], { cwd: root }).stdout.split('\0')) {
        const m = /^(\d+) \w+ ([0-9a-f]+)\t([^]*)$/.exec(rec)
        if (m) startEntries.set(String(m[3]), { mode: String(m[1]), sha: String(m[2]) })
      }
    }
    return startEntries.get(p)
  }
  const zero = '0'.repeat(meta.index.length)
  let input = ''
  for (const c of parseRawDiff(diff.stdout)) {
    // Unmerged entries carry no tree side in the diff.
    const was = c.status === 'U' ? startEntry(c.path) : c.srcMode === NO_MODE ? undefined : { mode: c.srcMode, sha: c.srcSha }
    input += `0 ${zero}\t${c.path}\0`
    if (was) input += `${was.mode} ${was.sha}\t${c.path}\0`
  }
  if (input) {
    const r = gitRaw(['update-index', '-z', '--index-info'], { cwd: root, input, allowFail: true })
    if (!r.ok) {
      problems.push(`could not restore the index to the round start: ${r.stderr.trim()}`)
      return
    }
  }
  restoreIntentToAdd(root, meta, problems)
}

/**
 * Now that every other entry matches meta.index, what still differs from it
 * is intent-to-add: drop the ones the round made, re-add the user's.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 */
function restoreIntentToAdd(root, meta, problems) {
  if (!meta.ita) return
  const was = meta.ita
  const now = intentToAdd(root, meta.index)
  const made = now.filter(p => !was.has(p))
  if (made.length) {
    const r = gitRaw(['update-index', '-z', '--force-remove', '--stdin'], { cwd: root, input: made.map(p => `${p}\0`).join(''), allowFail: true })
    if (!r.ok) problems.push(`could not remove the intent-to-add entries the round made: ${r.stderr.trim()}`)
  }
  const nowSet = new Set(now)
  const lost = [...was].filter(p => !nowSet.has(p))
  if (lost.length) {
    const r = gitRaw(['add', '--intent-to-add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd: root,
      env: { GIT_LITERAL_PATHSPECS: '1' },
      input: lost.map(p => `${p}\0`).join(''),
      allowFail: true,
    })
    if (!r.ok) problems.push(`could not put back the intent-to-add entries of ${lost.map(shown).join(', ')}: ${r.stderr.trim()}`)
  }
}

/**
 * Ends a merge, cherry-pick, revert, rebase or am that the round started (see
 * IN_PROGRESS for how): otherwise a later plain `git commit` would record, say,
 * a merge whose changes the revert dropped. Runs before the working tree and
 * index are restored, since an abort rewrites them. Returns whether none is
 * left in progress.
 *
 * A file outside the checkpoint (ignored or unreadable) that the index now
 * tracks, because the operation brought it in or the round staged it (`git
 * add -f`), would be removed by an abort: its bytes are saved first and put
 * back after, so the revert never deletes it.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 * @param {string} trash
 */
function endOperations(root, meta, problems, trash) {
  if (!meta.ops) return true
  const before = new Set(meta.ops)
  const started = () => inProgress(root).filter(m => !before.has(m))
  if (!started().length) return true
  const offTree = meta.offTree.size
    ? [...new Set(nulList(gitRaw(['ls-files', '-z', '--', '.', EXCLUDE], { cwd: root }).stdout))].filter(p => wasOffTree(meta.offTree, p))
    : []
  /** @type {{ path: string, mode: string, data: Buffer, touched: boolean }[]} */ const saved = []
  for (const p of offTree) {
    const at = onDisk(root, p)
    const st = lstatOrNull(at)
    if (!st || !(st.isFile() || st.isSymbolicLink())) continue
    try {
      const link = st.isSymbolicLink()
      saved.push({
        path: p,
        mode: link ? SYMLINK : st.mode & 0o111 ? EXECUTABLE : '100644',
        data: link ? readlinkSync(at, { encoding: 'buffer' }) : readFileSync(at),
        touched: touchedSince(root, p, meta.time),
      })
    } catch (e) {
      problems.push(`could not save ${shown(p)} before ending a git operation the round started: ${/** @type {Error} */ (e).message}`)
    }
  }
  /** @type {string[]} */ const errors = []
  for (const [marker, ...commands] of IN_PROGRESS) {
    for (const cmd of commands) {
      // one command can end several markers (`am --quit` clears rebase-apply too)
      if (!started().includes(marker)) break
      const r = git(cmd, { cwd: root, allowFail: true })
      if (!r.ok) errors.push(`git ${cmd.join(' ')}: ${r.stderr.trim()}`)
    }
  }
  // One still tracked and on disk is reported with the rest of the working tree.
  const tracked = offTree.length ? new Set(nulList(gitRaw(['ls-files', '-z', '--', '.', EXCLUDE], { cwd: root }).stdout)) : new Set()
  for (const f of saved) {
    const gone = !lstatOrNull(onDisk(root, f.path))
    if (gone) {
      try {
        writeEntry(root, f.path, f.mode, f.data, trash)
      } catch (e) {
        problems.push(`${shown(f.path)} was outside the checkpoint (ignored or unreadable), and ending a git operation the round started removed it: ${/** @type {Error} */ (e).message}`)
        continue
      }
    }
    if (f.touched && (gone || !tracked.has(f.path))) {
      problems.push(
        `${shown(f.path)} was left in place: it was outside the checkpoint (ignored or unreadable), ` +
          'so a version the round or a git operation it started wrote cannot be told apart from the original',
      )
    }
  }
  const left = started()
  if (!left.length) return true
  problems.push(`a git operation the round started is still in progress (${left.join(', ')}); ${errors.join('; ') || 'ending it had no effect'}`)
  return false
}

/** @param {string} ref */
function branchName(ref) {
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * Does `head` hold commits that no branch held at the checkpoint? A round that
 * only checked out an existing branch made none. Without a record (an older
 * checkpoint) or an answer from git, assume it did.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string} head
 */
function madeCommits(root, meta, head) {
  if (!meta.refs || !head) return true
  const input = [meta.head, ...meta.refs].filter(Boolean).map(sha => `^${sha}\n`).join('')
  const r = git(['rev-list', '--count', head, '--stdin'], { cwd: root, input, allowFail: true })
  return !r.ok || r.stdout.trim() !== '0'
}

/**
 * Branches checked out in another worktree of the repository: what moves
 * them is that worktree's work, not the round's.
 *
 * @param {string} root
 */
function otherWorktreeBranches(root) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd: root, allowFail: true })
  /** @type {Set<string>} */ const out = new Set()
  if (!r.ok) return out
  const here = realPath(root)
  for (const block of r.stdout.split('\n\n')) {
    const at = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch (.+)$/m.exec(block)?.[1]
    if (at && branch && realPath(at) !== here) out.add(branch)
  }
  return out
}

/** @param {string} p */
function realPath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Local branches the round moved, deleted, or created holding commits no
 * branch held at the checkpoint, except `skip` (already reported) and those
 * another worktree has checked out. The loop never moves a branch back, so
 * each is a problem for the user.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {Set<string>} skip
 * @returns {string[]}
 */
function branchMoves(root, meta, skip) {
  if (!meta.branches) return []
  const others = otherWorktreeBranches(root)
  /** @type {Map<string, string>} */ const now = new Map()
  for (const line of git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { cwd: root }).stdout.split('\n')) {
    const i = line.indexOf(' ')
    if (i > 0) now.set(line.slice(i + 1), line.slice(0, i))
  }
  /** @type {string[]} */ const out = []
  for (const [ref, was] of meta.branches) {
    if (skip.has(ref) || others.has(ref)) continue
    const is = now.get(ref)
    if (is === was) continue
    out.push(
      is
        ? `branch ${branchName(ref)} moved during the round (${was.slice(0, 12)} -> ${is.slice(0, 12)}) and was not moved back; review it, then \`git update-ref ${ref} ${was}\` to put it back.`
        : `branch ${branchName(ref)} was deleted during the round; \`git branch ${branchName(ref)} ${was}\` puts it back.`,
    )
  }
  for (const [ref, is] of now) {
    if (meta.branches.has(ref) || skip.has(ref) || others.has(ref) || !madeCommits(root, meta, is)) continue
    out.push(`branch ${branchName(ref)} was created during the round at ${is.slice(0, 12)} and holds commits made during it; they were not undone.`)
  }
  return out
}

/**
 * Puts HEAD back on the branch (or detached commit) it was on at the
 * checkpoint when that is safe, and reports what it cannot undo: the loop
 * never moves a branch, so commits made during the round, and branches it
 * moved or deleted, stay and pause it.
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 * @param {boolean} mayMove false while an operation the round started is still in progress
 */
function restoreHead(root, meta, problems, mayMove) {
  if (!meta.head) return
  const head = revParse(root, 'HEAD') ?? ''
  const branch = symbolicHead(root)
  /** @type {Set<string>} branches a problem below already names */ const named = new Set()
  headProblems(root, meta, problems, mayMove, head, branch, named)
  problems.push(...branchMoves(root, meta, named))
}

/**
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 * @param {boolean} mayMove
 * @param {string} head HEAD now
 * @param {string} branch the branch HEAD is on now ('' when detached)
 * @param {Set<string>} named
 */
function headProblems(root, meta, problems, mayMove, head, branch, named) {
  const at = (/** @type {string} */ ref, /** @type {string} */ sha) =>
    `${ref ? branchName(ref) : 'detached HEAD'} at ${sha.slice(0, 12) || 'none'}`
  const restored = 'The working tree and index are back at the round start'
  if (meta.branch === null || meta.branch === branch) {
    if (head !== meta.head) {
      named.add(branch)
      problems.push(
        `HEAD moved during the round (${meta.head.slice(0, 12)} -> ${head.slice(0, 12) || 'none'}): its commits were not undone. ` +
          `${restored}; review those commits, then \`git reset --soft ${meta.head}\`.`,
      )
    }
    return
  }
  // HEAD is on another branch, or detached, or attached when it was detached.
  const startNow = meta.branch ? revParse(root, meta.branch) ?? '' : meta.head
  // Back onto the start branch while it is still where it was; back to a
  // detached HEAD only when nothing moved but the attachment.
  const canReturn = mayMove && startNow === meta.head && (meta.branch !== '' || head === meta.head)
  if (!canReturn) {
    named.add(meta.branch).add(branch)
    const moved = startNow === meta.head ? '' : startNow ? `, and ${branchName(meta.branch)} moved to ${startNow.slice(0, 12)}` : `, and ${branchName(meta.branch)} was deleted`
    const back = meta.branch
      ? `\`git symbolic-ref HEAD ${meta.branch}\`, then \`git reset --soft ${meta.head}\``
      : `\`git update-ref --no-deref HEAD ${meta.head}\``
    problems.push(
      `HEAD moved during the round (${at(meta.branch, meta.head)} -> ${at(branch, head)})${moved}: its commits were not undone. ` +
        `${restored}; review those commits, then ${back}.`,
    )
    return
  }
  // Only HEAD itself moved: point it back. The index and working tree already
  // match the round start, and no branch changes.
  const message = 'quality-loop: revert round'
  const r = meta.branch
    ? git(['symbolic-ref', '-m', message, 'HEAD', meta.branch], { cwd: root, allowFail: true })
    : git(['update-ref', '--no-deref', '-m', message, 'HEAD', meta.head], { cwd: root, allowFail: true })
  if (!r.ok) {
    problems.push(`could not put HEAD back on ${at(meta.branch, meta.head)}: ${r.stderr.trim()}`)
  } else if (head !== meta.head && madeCommits(root, meta, head)) {
    named.add(branch)
    problems.push(
      `HEAD was moved during the round to ${at(branch, head)}; it is back on ${at(meta.branch, meta.head)}, and those commits were not undone ` +
        `(${branch ? `${branchName(branch)} still holds them` : 'find them with `git reflog`'}).`,
    )
  }
}

/**
 * Makes the working tree and index match a checkpoint: files changed since are
 * rewritten byte for byte, files created since are moved to
 * `.quality-loop/trash/`. Paths that were on disk at the checkpoint but not in
 * its tree (ignored or unindexable files) are never removed, and the loop's own
 * directory is left alone. What cannot be reverted (nested repositories, a
 * moved HEAD, write failures) is listed in `problems`, never in `restored` or
 * `deleted`.
 *
 * @param {string} root
 * @param {string} tree
 * @returns {{ restored: string[], deleted: string[], kept: string[], problems: string[] }}
 */
export function restoreTree(root, tree) {
  const meta = readCheckpoint(root, tree)
  /** @type {string[]} */ const problems = []
  const trash = `${TRASH}/${new Date().toISOString().replace(/[:.]/g, '-')}`
  const settled = endOperations(root, meta, problems, trash)
  const { tree: current, skipped } = worktreeTree(root)
  const changes = parseRawDiff(
    gitRaw(['diff-tree', '-r', '-z', '--no-renames', current, tree, '--', '.', EXCLUDE], { cwd: root }).stdout,
  )
  /** @type {string[]} */ const restored = []
  /** @type {string[]} */ const deleted = []
  /** @type {string[]} */ const kept = []
  /** @type {Set<string>} */ const reportedNested = new Set()
  /** @type {{ path: string, mode: string, sha: string }[]} */ const writes = []

  // src: the working tree now; dst: the checkpoint.
  for (const c of changes) {
    if (c.srcMode === GITLINK || c.dstMode === GITLINK) {
      reportedNested.add(c.path)
      const what =
        c.status === 'D'
          ? 'appeared (or got its first commit) during the round and was left in place'
          : c.status === 'A'
            ? 'was removed or replaced during the round and was not restored'
            : `moved from ${c.dstSha.slice(0, 12)} to ${c.srcSha.slice(0, 12)} during the round: its commits were not undone`
      problems.push(`nested repository ${shown(c.path)} ${what}`)
      continue
    }
    if (c.status !== 'D') {
      writes.push({ path: c.path, ...(meta.raw.get(c.path) ?? { mode: c.dstMode, sha: c.dstSha }) })
      continue
    }
    if (wasOffTree(meta.offTree, c.path)) {
      kept.push(c.path)
      // It was on disk then, but the round may have created or changed it
      // (inside a directory ignored as a whole, say): nothing to restore it from.
      if (touchedSince(root, c.path, meta.time)) {
        problems.push(
          `${shown(c.path)} was left in place: it was outside the checkpoint (ignored or unreadable), ` +
            'so a version the round created or changed cannot be told apart from the original',
        )
      }
      continue
    }
    try {
      moveAside(root, c.path, trash)
      deleted.push(c.path)
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') problems.push(`could not remove ${shown(c.path)}: ${/** @type {Error} */ (e).message}`)
    }
  }

  // A change to only the bytes a clean filter or eol conversion strips leaves
  // the tree unchanged: compare the raw bytes of every such file.
  const pending = new Set(writes.map(w => w.path))
  const rawPaths = [...meta.raw.keys()].filter(p => !pending.has(p))
  const rawNow = hashRaw(root, rawPaths, false)
  for (const p of rawPaths) {
    const was = meta.raw.get(p)
    const now = rawNow.get(p)
    if (was && now && now !== was.sha) writes.push({ path: p, ...was })
  }

  // What git could not read now: a checkpoint version is written over it
  // below; anything else the round made unreadable stays and is reported.
  for (const p of skipped) {
    if (pending.has(p) || wasOffTree(meta.offTree, p)) continue
    problems.push(`${shown(p)} could not be read (unreadable, or a repository with no commit), so it was not reverted`)
  }

  const blobs = readBlobs(root, writes.map(w => w.sha))
  for (const w of writes) {
    const data = blobs.get(w.sha)
    try {
      if (!data) throw new Error(`object ${w.sha} is missing`)
      writeEntry(root, w.path, w.mode, data, trash)
      restored.push(w.path)
    } catch (e) {
      problems.push(`could not restore ${shown(w.path)}: ${/** @type {Error} */ (e).message}`)
    }
  }

  for (const [p, state] of meta.nested) {
    if (!reportedNested.has(p) && nestedState(root, p) !== state) {
      problems.push(`files inside nested repository ${shown(p)} changed during the round and were not reverted`)
    }
  }

  restoreIndex(root, meta, problems)
  restoreHead(root, meta, problems, settled)
  return { restored: restored.map(shown), deleted: deleted.map(shown), kept: kept.map(shown), problems }
}

/**
 * Unified diff between two tree-ish objects (commits or snapshot trees),
 * without the loop's own directory.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {{ context?: number }} [opts]
 */
export function diffTrees(root, from, to, opts = {}) {
  return git(['diff', '--no-color', '--no-ext-diff', `-U${opts.context ?? 3}`, from, to, '--', '.', EXCLUDE], { cwd: root })
    .stdout
}

/**
 * `git diff --numstat` between two tree-ish objects, NUL-separated and
 * without rename detection (one path per entry), without the loop's own
 * directory.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 */
export function numstatTrees(root, from, to) {
  return git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '--numstat', '-z', from, to, '--', '.', EXCLUDE], { cwd: root }).stdout
}

/**
 * Paths that differ between two tree-ish objects (`added` only: paths new in
 * `to`), without rename detection and without the loop's own directory.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {{ added?: boolean }} [opts]
 */
export function changedPaths(root, from, to, opts = {}) {
  const filter = opts.added ? ['--diff-filter=A'] : []
  return nulList(git(['diff', '--name-only', '-z', '--no-renames', ...filter, from, to, '--', '.', EXCLUDE], { cwd: root }).stdout)
}

/**
 * Every directory in a tree-ish object.
 *
 * @param {string} root
 * @param {string} tree
 */
export function treeDirs(root, tree) {
  return new Set(nulList(git(['ls-tree', '-r', '-d', '--name-only', '-z', tree], { cwd: root }).stdout))
}
