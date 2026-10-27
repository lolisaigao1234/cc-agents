// Where a repository's git directories are, found without running git, and
// the loop's tombstone: a copy of each loop's status and round count kept in
// the git common directory (`<common>/quality-loop/`), outside the working
// tree. `ql start` reads it, so deleting `.quality-loop/` does not reset the
// round cap that only the user may lift. Recording fails open: without a
// tombstone the cap rests on the state file alone.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** @typedef {{ top: string, gitDir: string, commonDir: string }} GitLayout */

/** @param {string} p */
const isDir = p => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} p */
const isFile = p => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * The repository whose `.git` entry is in `dir`, or null when there is none
 * or it is not one git would use: a git directory has a HEAD, and its common
 * directory objects and refs. An empty `.git` directory or a `.git` file
 * pointing nowhere is not a repository.
 *
 * @param {string} dir
 * @returns {GitLayout | null}
 */
function layoutAt(dir) {
  const dotGit = join(dir, '.git')
  let gitDir = dotGit
  if (!isDir(dotGit)) {
    let text = ''
    try {
      text = readFileSync(dotGit, 'utf8')
    } catch {
      return null
    }
    const to = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
    if (!to) return null
    gitDir = resolve(dir, to)
  }
  let commonDir = gitDir
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
  } catch {}
  if (!isFile(join(gitDir, 'HEAD')) || !isDir(join(commonDir, 'objects')) || !isDir(join(commonDir, 'refs'))) return null
  return { top: dir, gitDir, commonDir }
}

/**
 * Every repository whose working tree holds `start`, nearest first: the
 * first is the one `git rev-parse --show-toplevel` (and so `ql`) finds, the
 * rest enclose it. Found without running git; a `.git` that is not a
 * repository is passed over, so it cannot hide the one above it.
 *
 * @param {string} start
 * @returns {GitLayout[]}
 */
export function gitLayouts(start) {
  const out = []
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const l = layoutAt(dir)
    if (l) out.push(l)
    if (dirname(dir) === dir) return out
  }
}

/**
 * The working tree that holds `start`, its git directory and the common git
 * directory its worktrees share, as git finds them.
 *
 * @param {string} start
 * @returns {GitLayout | null}
 */
export function gitLayout(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const l = layoutAt(dir)
    if (l) return l
    if (dirname(dir) === dir) return null
  }
}

/** @param {string} p */
const real = p => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The directory holding every worktree's tombstone, or null outside git.
 *
 * @param {string} root
 */
export function tombstoneDir(root) {
  const l = gitLayout(root)
  return l ? join(real(l.commonDir), 'quality-loop') : null
}

/**
 * The tombstone of the loop in the working tree `root`: one per worktree,
 * named after the worktree's own git directory, which stays put when the
 * worktree is moved (`git worktree move`, or moving a repository with its
 * `.git`): `main.json` for the main worktree, `worktrees-<name>.json` for a
 * linked one. A worktree removed and added again under the same name finds
 * the old tombstone; the user lifts it with `! ql start --force`.
 *
 * @param {string} root
 */
export function tombstoneFile(root) {
  const l = gitLayout(root)
  if (!l) return null
  const common = real(l.commonDir)
  const rel = relative(common, real(l.gitDir))
  const key =
    rel === ''
      ? 'main'
      : !rel.startsWith('..') && !rel.startsWith('/')
        ? rel.replace(/[^\w.-]+/g, '-')
        : createHash('sha256').update(real(l.gitDir)).digest('hex').slice(0, 16)
  return join(common, 'quality-loop', `${key}.json`)
}

/**
 * @typedef {{ root: string, id: string, status: string, round: number, maxRounds: number | null, reviewOnly: boolean, at: string }} Tombstone
 */

// Statuses a loop leaves only by the user's hand: `ql extend` (capped,
// stalled) or a forced restart, which records a new loop.
/** The statuses only the user clears (`ql extend`, `ql start --force`). */
export const STOPPED = ['capped', 'stalled', 'aborted']

/**
 * Whether a recorded loop keeps `ql start` from starting over: it spent
 * rounds (or hit its cap) without finishing.
 *
 * @param {Tombstone} t
 */
export function holdsCap(t) {
  if (t.status === 'done' || t.reviewOnly) return false
  return t.round > 0 || t.status === 'capped' || t.status === 'stalled'
}

/**
 * Merges what the state says into the last record of the same loop, so the
 * record only ever gets stricter: the round never goes down, a capped,
 * stalled or aborted loop keeps that status, a loop is recorded done only
 * when ql finishes it, it never becomes review-only afterwards, and the
 * round budget never goes up. A state edited outside ql therefore cannot
 * launder the record through the next command that saves it. Only `ql
 * start` records a new loop over one that holds the cap (the guard keeps
 * `--force` from the agent), and only `ql extend`, which the guard keeps from
 * the agent, lifts a capped or stalled record and raises its budget.
 *
 * @param {Tombstone | null} prev
 * @param {Tombstone} next
 * @param {'start' | 'extend' | 'end'} [how] `end`: `ql round end` or `ql finish` decided the status
 * @returns {Tombstone | null} the record to write, or null to keep `prev`
 */
export function mergeRecord(prev, next, how) {
  if (!prev || how === 'start') return next
  if (prev.id !== next.id) return holdsCap(prev) ? null : next
  const lift = how === 'extend' && (prev.status === 'capped' || prev.status === 'stalled')
  const budget = [prev.maxRounds, next.maxRounds].filter(n => typeof n === 'number')
  // Done only as ql decided it: by `round end`, or by `finish` for a loop
  // that was review-only from its start.
  const finished = how === 'end' && (!next.reviewOnly || !!prev.reviewOnly)
  const keep = (STOPPED.includes(prev.status) && !lift) || (next.status === 'done' && prev.status !== 'done' && !finished)
  return {
    ...next,
    status: keep ? prev.status : next.status,
    round: Math.max(Number(prev.round) || 0, next.round),
    reviewOnly: !!prev.reviewOnly && next.reviewOnly,
    maxRounds: lift ? next.maxRounds : budget.length ? Math.min(...budget) : null,
  }
}

/**
 * Records a loop's latest status and round count, never less strictly than
 * the last record of the same loop (`mergeRecord`).
 *
 * @param {string} root
 * @param {any} s the loop's state
 * @param {'start' | 'extend' | 'end'} [how] the ql command saving it, when it may replace, lift or finish the record
 */
export function recordLoop(root, s, how) {
  try {
    const file = tombstoneFile(root)
    if (!file) return
    /** @type {Tombstone} */
    const next = {
      root,
      id: String(s.id),
      status: String(s.status),
      round: Number(s.round) || 0,
      maxRounds: typeof s.config?.loop?.maxRounds === 'number' ? s.config.loop.maxRounds : null,
      reviewOnly: !!s.reviewOnly,
      at: new Date().toISOString(),
    }
    const t = mergeRecord(readTombstone(root), next, how)
    if (!t) return
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`)
    renameSync(tmp, file)
  } catch {}
}

/**
 * @param {string} root
 * @returns {Tombstone | null}
 */
export function readTombstone(root) {
  try {
    const file = tombstoneFile(root)
    const t = file ? JSON.parse(readFileSync(file, 'utf8')) : null
    return t && typeof t.id === 'string' && typeof t.status === 'string' ? t : null
  } catch {
    return null
  }
}
