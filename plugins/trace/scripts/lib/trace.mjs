// The trace: whether an action is traceable, from git and GitHub state
// (ADR 0006). In a traced repository, a file inside it may be edited only on
// the branch of an open issue, and nothing the model writes turns that off.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { fold, real } from './paths.mjs'

// The human's switch, set when launching Claude Code, that turns the trace off.
const BYPASS = 'TRACE_BYPASS'
const BYPASS_HINT = `to work untraced, the human can launch Claude Code with ${BYPASS}=1`

/**
 * What the trace needs from git.
 *
 * @typedef {{
 *   root(path: string): string | null,
 *   traced(root: string): boolean,
 *   branch(root: string): string | null,
 *   defaultBranch(root: string): string | null,
 * }} Git
 */

/**
 * What the trace needs from GitHub: an issue's state, or null when GitHub
 * cannot be asked. A pull request is 'MISSING': it is not an issue.
 *
 * @typedef {{ issueState(root: string, n: number): 'OPEN' | 'CLOSED' | 'MISSING' | null }} GitHub
 */

/**
 * Why editing `path` breaks the trace, or null if it may be edited. The
 * nearest traced repository at or above `path` decides, so a nested
 * repository that is not traced itself does not opt its files out.
 *
 * @param {string} path an absolute path, symlinks resolved
 * @param {{ git: Git, github: GitHub, env: Record<string, string | undefined> }} [world]
 * @returns {string | null}
 */
export function editVerdict(path, { git, github, env } = { git: realGit, github: realGitHub, env: process.env }) {
  if (env[BYPASS] === '1') return null
  let root = git.root(path)
  while (root && !git.traced(root)) root = dirname(root) === root ? null : git.root(dirname(root))
  if (!root) return null
  if (fold(path) === fold(`${root}/.git`) || fold(path).startsWith(fold(`${root}/.git/`))) {
    return "this is the repository's git directory. Branch step: change branches and remotes with git and `gh issue develop`, never by editing .git/."
  }
  const branch = git.branch(root)
  if (branch && branch === git.defaultBranch(root)) {
    return `this is the default branch (${branch}). Branch step: work on the issue's branch, \`gh issue develop <n> --checkout\` (Track first if there is no issue).`
  }
  const n = /^(\d+)-/.exec(branch ?? '')?.[1]
  if (!n) {
    return `the branch ${branch ?? '(detached HEAD)'} names no issue. Track step: open an issue (to-tickets), then \`gh issue develop <n> --checkout\`.`
  }
  const state = github.issueState(root, Number(n))
  if (state === 'OPEN') return null
  if (state === null) {
    return `GitHub could not say whether issue #${n} is open; check \`gh auth status\`, the network, and that origin is on GitHub. Track step: the edit waits for an open issue; ${BYPASS_HINT}.`
  }
  return `#${n} is ${state === 'CLOSED' ? 'a closed issue' : 'not an open issue'}. Track step: open an issue for this change (to-tickets) and work on its branch.`
}

// Settings that, changed, can switch the hooks or the trace off: any `env`
// variable reaches the hook's process, not only the bypass.
const SWITCHES = ['env', 'disableAllHooks', 'enabledPlugins', 'hooks']
const SETTINGS = new Set(['settings.json', 'settings.local.json'])

/** @returns {string[]} Claude Code's user config directories, real and folded */
const configDirs = () =>
  [...new Set([process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter(d => !!d).map(d => fold(real(String(d)))))]

/** @param {string} path real and folded */
function isSettings(path) {
  if (basename(path) === 'managed-settings.json') return true
  return SETTINGS.has(basename(path)) && (basename(dirname(path)) === '.claude' || configDirs().includes(dirname(path)))
}

/**
 * Why an edit tool's change to `path` would switch the hooks or the trace
 * off, or null. Claude Code's settings may change in everything but those
 * switches; installed plugins may not change at all.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} path an absolute path, symlinks resolved
 * @returns {string | null}
 */
export function switchVerdict(toolName, toolInput, path) {
  const why = 'only the human changes it, by hand.'
  const folded = fold(path)
  if (configDirs().some(d => folded.startsWith(`${d}/plugins/`))) return `this is an installed plugin; ${why}`
  if (!isSettings(folded)) return null
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const after = afterEdit(toolName, toolInput, before)
  if (after === null) return `the trace cannot tell what this edit does to Claude Code's settings; ${why}`
  /** @param {string} text */
  const parse = text => {
    try {
      return { ok: true, value: JSON.parse(text || '{}') }
    } catch {
      return { ok: false, value: {} }
    }
  }
  const [was, will] = [parse(before), parse(after)]
  if (!was.ok || !will.ok) return `the trace cannot read these Claude Code settings, so cannot tell whether the change switches its hooks off; ${why}`
  const changed = SWITCHES.some(key => JSON.stringify(was.value?.[key]) !== JSON.stringify(will.value?.[key]))
  return changed ? `this changes ${SWITCHES.join(', ')} in Claude Code's settings; ${why}` : null
}

/**
 * @param {string} toolName @param {Record<string, unknown>} input @param {string} text
 * @returns {string | null} `text` after the edit, or null when that cannot be told
 */
function afterEdit(toolName, input, text) {
  if (toolName === 'Write') return String(input.content ?? '')
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return null
  const edits = toolName === 'MultiEdit' ? /** @type {Record<string, unknown>[]} */ (input.edits ?? []) : [input]
  /** @type {string | null} */
  let t = text
  for (const e of edits) {
    const [from, to] = [String(e.old_string ?? ''), String(e.new_string ?? '')]
    if (t === null || !t.includes(from)) return null
    t = e.replace_all ? t.split(from).join(to) : t.replace(from, () => to)
  }
  return t
}

// --- the real adapters ---------------------------------------------------------

/** The marker `/trace:setup` commits to opt a repository in. */
const MARKER = '.claude/trace.json'

// A hook that times out lets the edit through, so every call shares one
// deadline well inside the hook's timeout, and running out throws.
const DEADLINE = Date.now() + 20_000
const timeLeft = () => {
  const ms = DEADLINE - Date.now()
  if (ms <= 0) throw new Error('out of time asking git and GitHub')
  return ms
}

/** @param {string} root @param {string[]} args @returns {string | null} stdout, or null when git says no */
const git = (root, args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: Math.min(3000, timeLeft()) })
  if (r.error) throw r.error
  return r.status === 0 ? r.stdout.trim() : null
}

/** @type {Map<string, string | null>} */
const defaults = new Map()

/** @type {Git} */
const realGit = {
  root(path) {
    for (let d = path; ; d = dirname(d)) {
      if (existsSync(join(d, '.git'))) return d
      if (dirname(d) === d) return null
    }
  },
  // Deleting the marker from the working tree, or committing its deletion on a
  // branch, does not opt out: it also counts while HEAD or the default branch has it.
  // When git fails, only the marker in the working tree counts.
  traced(root) {
    if (existsSync(join(root, MARKER))) return true
    try {
      const def = this.defaultBranch(root)
      return ['HEAD', ...(def ? [`origin/${def}`, def] : [])].some(rev => git(root, ['cat-file', '-e', `${rev}:${MARKER}`]) !== null)
    } catch {
      return false
    }
  },
  branch: root => git(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || null,
  defaultBranch(root) {
    if (!defaults.has(root)) {
      const remote = git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
      const local = () => ['main', 'master'].find(b => git(root, ['show-ref', '--verify', '-q', `refs/heads/${b}`]) !== null) ?? null
      defaults.set(root, remote ? remote.replace(/^origin\//, '') : local())
    }
    return defaults.get(root) ?? null
  },
}

/** @type {GitHub} */
const realGitHub = {
  // Asks about origin's repository by name: gh's own choice prefers a remote
  // called upstream, which on a fork is someone else's issues.
  issueState(root, n) {
    const url = git(root, ['remote', 'get-url', 'origin']) ?? ''
    const slug = /(?:^|[@/])github\.com(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1]
    if (!slug) return null
    const r = spawnSync('gh', ['api', `repos/${slug}/issues/${n}`], { cwd: root, encoding: 'utf8', timeout: Math.min(10_000, timeLeft()) })
    if (r.status !== 0) return /HTTP (404|410)/.test(r.stderr ?? '') ? 'MISSING' : null
    try {
      const issue = JSON.parse(r.stdout)
      if (issue.pull_request) return 'MISSING'
      return issue.state === 'open' ? 'OPEN' : 'CLOSED'
    } catch {
      return null
    }
  },
}
