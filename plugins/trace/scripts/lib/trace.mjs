// The trace: whether an action is traceable, from git and GitHub state
// (ADR 0006). In a traced repository, a file inside its working tree may be
// edited only on the branch of an open issue.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The human's switch, set when launching Claude Code, that turns the trace off.
const BYPASS = 'TRACE_BYPASS'

/**
 * What the trace needs from git.
 *
 * @typedef {{
 *   root(dir: string): string | null,
 *   marked(root: string): boolean,
 *   branch(root: string): string | null,
 *   defaultBranch(root: string): string | null,
 * }} Git
 */

/**
 * What the trace needs from GitHub: an issue's state, or null when GitHub
 * cannot be asked.
 *
 * @typedef {{ issueState(root: string, n: number): 'OPEN' | 'CLOSED' | 'MISSING' | null }} GitHub
 */

/**
 * Why editing `path` breaks the trace, or null if it may be edited.
 *
 * @param {string} path an absolute path
 * @param {{ git: Git, github: GitHub, env: Record<string, string | undefined> }} [world]
 * @returns {string | null}
 */
export function editVerdict(path, { git, github, env } = { git: realGit, github: realGitHub, env: process.env }) {
  if (env[BYPASS] === '1') return null
  const root = git.root(path)
  if (!root || !git.marked(root) || path.startsWith(`${root}/.git/`)) return null
  const branch = git.branch(root)
  if (branch === git.defaultBranch(root)) {
    return `this is the default branch (${branch}). Branch step: work on the issue's branch, \`gh issue develop <n> --checkout\` (Track first if there is no issue).`
  }
  const n = /^(\d+)-/.exec(branch ?? '')?.[1]
  if (!n) {
    return `the branch ${branch ?? '(detached HEAD)'} names no issue. Track step: open an issue (to-tickets), then \`gh issue develop <n> --checkout\`.`
  }
  const state = github.issueState(root, Number(n))
  if (state === 'OPEN') return null
  if (state === null) {
    return `GitHub could not say whether issue #${n} is open. Check \`gh auth status\` and the network; to work untraced, the human can launch Claude Code with ${BYPASS}=1.`
  }
  return `issue #${n} is ${state === 'CLOSED' ? 'closed' : 'not an open issue'}. Track step: open an issue for this change (to-tickets) and work on its branch.`
}

// --- the real adapters ---------------------------------------------------------

/** The marker `/trace:setup` commits to opt a repository in. */
export const MARKER = '.claude/trace.json'

/** @param {string} root @param {string[]} args */
const git = (root, args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000 })
  return r.status === 0 ? r.stdout.trim() : null
}

/** @type {Git} */
export const realGit = {
  root(path) {
    for (let d = path; ; d = dirname(d)) {
      if (existsSync(join(d, '.git'))) return d
      if (dirname(d) === d) return null
    }
  },
  // Deleting the marker from the working tree, or committing its deletion on a
  // branch, does not opt out: it also counts while HEAD or the default branch has it.
  marked(root) {
    if (existsSync(join(root, MARKER))) return true
    const def = this.defaultBranch(root)
    return ['HEAD', ...(def ? [`origin/${def}`, def] : [])].some(rev => git(root, ['cat-file', '-e', `${rev}:${MARKER}`]) !== null)
  },
  branch: root => git(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || null,
  defaultBranch(root) {
    const remote = git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
    if (remote) return remote.replace(/^origin\//, '')
    return ['main', 'master'].find(b => git(root, ['show-ref', '--verify', '-q', `refs/heads/${b}`]) !== null) ?? null
  },
}

/** @type {GitHub} */
export const realGitHub = {
  issueState(root, n) {
    const r = spawnSync('gh', ['issue', 'view', String(n), '--json', 'state', '--jq', '.state'], { cwd: root, encoding: 'utf8', timeout: 8000 })
    if (r.status === 0) return r.stdout.trim() === 'OPEN' ? 'OPEN' : 'CLOSED'
    return /could not resolve to an issue|not found|pull request/i.test(r.stderr ?? '') ? 'MISSING' : null
  },
}
