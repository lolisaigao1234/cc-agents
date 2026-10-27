// Git plumbing for the loop: diffs against the base, and checkpoints of the
// whole working tree that never touch the user's index, HEAD or stash.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The loop's own files never belong to a checkpoint or a review diff.
export const LOOP_DIR = '.quality-loop'
const EXCLUDE = `:(exclude)${LOOP_DIR}`

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, input?: string, allowFail?: boolean }} opts
 */
export function git(args, opts) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.error) throw r.error
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`)
  }
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr }
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
    if (existsSync(real)) copyFileSync(real, index)
    return fn({ GIT_INDEX_FILE: index })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Writes the whole working tree (tracked and untracked, minus ignored files
 * and the loop's own directory) as a git tree object and returns its id. The
 * user's index, HEAD and stash are untouched.
 *
 * @param {string} root
 */
export function snapshotTree(root) {
  return withTempIndex(root, env => {
    git(['add', '-A', '--', '.', EXCLUDE], { cwd: root, env })
    // Drop loop files that a copied real index may already hold.
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', LOOP_DIR], { cwd: root, env })
    return git(['write-tree'], { cwd: root, env }).stdout.trim()
  })
}

/**
 * Makes the working tree match a snapshot: files changed since are rewritten,
 * files created since are deleted. Ignored files and the loop's own directory
 * are left alone.
 *
 * @param {string} root
 * @param {string} tree
 * @returns {{ restored: string[], deleted: string[] }}
 */
export function restoreTree(root, tree) {
  const current = snapshotTree(root)
  const out = git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', current, tree], { cwd: root }).stdout
  const parts = out.split('\0').filter(Boolean)
  /** @type {string[]} */ const restored = []
  /** @type {string[]} */ const deleted = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]
    const path = parts[i + 1]
    if (!status || !path) continue
    if (status === 'D') deleted.push(path)
    else restored.push(path)
  }
  for (const p of deleted) {
    try {
      unlinkSync(join(root, p))
    } catch {
      // already gone
    }
  }
  if (restored.length) {
    withTempIndex(root, env => {
      git(['read-tree', tree], { cwd: root, env })
      git(['checkout-index', '-f', '-z', '--stdin'], { cwd: root, env, input: restored.join('\0') + '\0' })
    })
  }
  return { restored, deleted }
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
