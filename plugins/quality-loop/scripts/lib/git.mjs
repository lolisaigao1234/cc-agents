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
 * directory) into the index named by `env`.
 *
 * @param {string} root
 * @param {Record<string, string>} env
 */
function stageWorktree(root, env) {
  // --ignore-errors: a path git cannot index (an unreadable file, a nested repo
  // with no commit) is skipped rather than failing the snapshot; it is still
  // recorded as on disk through the checkpoint's list of paths outside the tree.
  // Exit 1 means "some files skipped"; anything else is a real failure.
  const add = git(['add', '-A', '--ignore-errors', '--', '.', EXCLUDE], { cwd: root, env, allowFail: true })
  if (!add.ok && add.status !== 1) throw new Error(`git add -A failed (${add.status}): ${add.stderr.trim()}`)
  // Drop loop files that a copied real index may already hold.
  git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', LOOP_DIR], { cwd: root, env })
}

/** @param {string} root */
function worktreeTree(root) {
  return withTempIndex(root, env => {
    stageWorktree(root, env)
    return git(['write-tree'], { cwd: root, env }).stdout.trim()
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
    return `${revParse(dir, 'HEAD') ?? ''} ${worktreeTree(dir)}`
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
 * `git add` runs clean filters and eol conversion, so the staged blob of such a
 * file is not its bytes on disk. For those files the checkpoint also records
 * the raw bytes, which is what a revert writes back.
 *
 * @param {string} root
 * @param {Record<string, string>} env
 * @param {IndexEntry[]} entries
 * @returns {string[]} index-info records
 */
function rawOverrides(root, env, entries) {
  // hash-object --stdin-paths reads lines and unquotes a leading '"'
  const files = entries.filter(e => (e.mode === '100644' || e.mode === EXECUTABLE) && !e.path.includes('\n') && !e.path.startsWith('"'))
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
  if (!candidates.length) return []
  const hashed = gitRaw(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
    cwd: root,
    input: candidates.map(c => `${c.path}\n`).join(''),
    allowFail: true,
  })
  if (!hashed.ok) return []
  const shas = hashed.stdout.split('\n')
  return candidates.flatMap((c, i) => {
    const raw = shas[i]
    return raw && raw !== c.sha ? [`${c.mode} ${raw}\t${META}/raw/${c.path}\0`] : []
  })
}

/**
 * Writes the whole working tree (tracked and untracked, minus ignored files
 * and the loop's own directory) as a git tree object and returns its id. The
 * user's index, HEAD and stash are untouched.
 *
 * Under `.quality-loop/checkpoint/` (never part of a diff) the tree also
 * records what a faithful revert needs: HEAD, the real index as a tree, the
 * paths on disk that the tree does not hold (ignored or unindexable), the
 * state of nested repositories and the raw bytes of filtered files.
 *
 * @param {string} root
 */
export function snapshotTree(root) {
  const head = revParse(root, 'HEAD') ?? ''
  const indexTree = realIndexTree(root)
  return withTempIndex(root, env => {
    stageWorktree(root, env)
    const entries = listIndex(root, env)
    const offTree = gitRaw(['ls-files', '-z', '-o', '--directory', '--', '.', EXCLUDE], { cwd: root, env }).stdout
    const nested = entries
      .filter(e => e.mode === GITLINK)
      .map(e => `${e.path}\0${nestedState(root, e.path)}\0`)
      .join('')
    /** @type {[string, string][]} */
    const blobs = [
      ['head', head],
      ['index', indexTree],
      ['off-tree', offTree],
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
 * @typedef {{
 *   head: string,
 *   index: string,
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
    head: text('head'),
    index: text('index'),
    offTree: new Set(text('off-tree').split('\0').filter(Boolean)),
    nested,
    raw,
  }
}

/**
 * Was `p` on disk at the checkpoint without being in its tree (ignored,
 * unindexable, or inside such a directory)?
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
 * entry, and reports a HEAD that moved (the loop never rewrites history).
 *
 * @param {string} root
 * @param {CheckpointMeta} meta
 * @param {string[]} problems
 */
function restoreIndex(root, meta, problems) {
  // No record: a legacy checkpoint, or an index with conflicts at the time.
  if (!meta.index) return
  const head = revParse(root, 'HEAD') ?? ''
  if (meta.head && head !== meta.head) {
    problems.push(
      `HEAD moved during the round (${meta.head.slice(0, 12)} -> ${head.slice(0, 12) || 'none'}): its commits were not undone. ` +
        `The working tree and index are back at the round start; review those commits, then \`git reset --soft ${meta.head}\`.`,
    )
  }
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
  if (!input) return
  const r = gitRaw(['update-index', '-z', '--index-info'], { cwd: root, input, allowFail: true })
  if (!r.ok) problems.push(`could not restore the index to the round start: ${r.stderr.trim()}`)
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
  const current = worktreeTree(root)
  const changes = parseRawDiff(
    gitRaw(['diff-tree', '-r', '-z', '--no-renames', current, tree, '--', '.', EXCLUDE], { cwd: root }).stdout,
  )
  const trash = `${TRASH}/${new Date().toISOString().replace(/[:.]/g, '-')}`
  /** @type {string[]} */ const restored = []
  /** @type {string[]} */ const deleted = []
  /** @type {string[]} */ const kept = []
  /** @type {string[]} */ const problems = []
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
      continue
    }
    try {
      moveAside(root, c.path, trash)
      deleted.push(c.path)
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') problems.push(`could not remove ${shown(c.path)}: ${/** @type {Error} */ (e).message}`)
    }
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
