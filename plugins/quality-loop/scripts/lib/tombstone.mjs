// Where a repository's git directories are, found without running git, and
// the loop's tombstone: a copy of each loop's status and round count kept in
// the git common directory (`<common>/quality-loop/`), outside the working
// tree. `ql start` reads it, so deleting `.quality-loop/` does not reset the
// round cap that only the user may lift. Recording fails open: without a
// tombstone the cap rests on the state file alone.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The working tree that holds `start`, its git directory and the common git
 * directory its worktrees share, the way git finds them: the nearest `.git`
 * directory, or the directory a `.git` file (a worktree, a submodule) points
 * to, whose `commondir` names the shared one.
 *
 * @param {string} start
 * @returns {{ top: string, gitDir: string, commonDir: string } | null}
 */
export function gitLayout(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    try {
      let gitDir = dotGit
      if (!statSync(dotGit).isDirectory()) {
        const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
        if (!to) return null
        gitDir = resolve(dir, to)
      }
      let commonDir = gitDir
      try {
        commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
      } catch {}
      return { top: dir, gitDir, commonDir }
    } catch {
      if (dirname(dir) === dir) return null
    }
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
 * named by a hash of the worktree's real path.
 *
 * @param {string} root
 */
export function tombstoneFile(root) {
  const l = gitLayout(root)
  if (!l) return null
  const key = createHash('sha256').update(real(l.top)).digest('hex').slice(0, 16)
  return join(real(l.commonDir), 'quality-loop', `${key}.json`)
}

/**
 * @typedef {{ root: string, id: string, status: string, round: number, maxRounds: number | null, reviewOnly: boolean, at: string }} Tombstone
 */

/**
 * Records a loop's latest status and round count.
 *
 * @param {string} root
 * @param {any} s the loop's state
 */
export function recordLoop(root, s) {
  try {
    const file = tombstoneFile(root)
    if (!file) return
    /** @type {Tombstone} */
    const t = {
      root,
      id: String(s.id),
      status: String(s.status),
      round: Number(s.round) || 0,
      maxRounds: s.config?.loop?.maxRounds ?? null,
      reviewOnly: !!s.reviewOnly,
      at: new Date().toISOString(),
    }
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
