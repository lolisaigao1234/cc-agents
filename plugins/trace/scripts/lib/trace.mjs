// The trace: whether an action is traceable, from git and GitHub state
// (ADR 0006). In a traced repository, a file inside it may be edited only on
// the branch of an open issue, a commit must reference that issue and a PR
// close it, and nothing the model writes turns that off.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { fold, real, untilde } from './paths.mjs'
import { gitParts, parseCommands } from './shell.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

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
 *   message(root: string, rev: string): string | null,
 *   alias(root: string, name: string): string | null,
 * }} Git
 */

/**
 * What the trace needs from GitHub: an issue's state, or null when GitHub
 * cannot be asked. A pull request is 'MISSING': it is not an issue.
 *
 * @typedef {{
 *   issueState(root: string, n: number): 'OPEN' | 'CLOSED' | 'MISSING' | null,
 *   alias(name: string): string | null,
 * }} GitHub
 */

/** @typedef {{ git: Git, github: GitHub, env: Record<string, string | undefined> }} World */

/**
 * Why editing `path` breaks the trace, or null if it may be edited.
 *
 * @param {string} path an absolute path, symlinks resolved
 * @param {World} [world]
 * @returns {string | null}
 */
export function editVerdict(path, world = REAL) {
  if (world.env[BYPASS] === '1') return null
  const root = tracedRoot(path, world.git)
  if (!root) return null
  if (fold(path) === fold(`${root}/.git`) || fold(path).startsWith(fold(`${root}/.git/`))) {
    return "this is the repository's git directory. Branch step: change branches and remotes with git and `gh issue develop`, never by editing .git/."
  }
  return issueVerdict(root, world.git.branch(root), world).why
}

/**
 * The nearest traced repository at or above `path`, so a nested repository
 * that is not traced itself does not opt its files out.
 *
 * @param {string} path @param {Git} git @returns {string | null}
 */
function tracedRoot(path, git) {
  let root = git.root(path)
  while (root && !git.traced(root)) root = dirname(root) === root ? null : git.root(dirname(root))
  return root
}

/**
 * Whether `branch` of a traced repository belongs to an open issue.
 *
 * @param {string} root @param {string | null} branch @param {World} world
 * @returns {{ why: string | null, n?: number }}
 */
function issueVerdict(root, branch, { git, github }) {
  if (branch && branch === git.defaultBranch(root)) {
    return { why: `this is the default branch (${branch}). Branch step: work on the issue's branch, \`gh issue develop <n> --checkout\` (Track first if there is no issue).` }
  }
  const n = Number(/^(\d+)-/.exec(branch ?? '')?.[1])
  if (!n) {
    return { why: `the branch ${branch ?? '(detached HEAD)'} names no issue. Track step: open an issue (to-tickets), then \`gh issue develop <n> --checkout\`.` }
  }
  const state = github.issueState(root, n)
  if (state === 'OPEN') return { why: null, n }
  if (state === null) {
    return { why: `GitHub could not say whether issue #${n} is open; check \`gh auth status\`, the network, and that origin is on GitHub. Track step: the work waits for an open issue; ${BYPASS_HINT}.` }
  }
  return { why: `#${n} is ${state === 'CLOSED' ? 'a closed issue' : 'not an open issue'}. Track step: open an issue for this change (to-tickets) and work on its branch.` }
}

// --- the commit and PR gates -----------------------------------------------------

/** A message the gate cannot read: computed by the shell, or not given. */
const UNKNOWN = Symbol('unknown')

/**
 * Why a Bash command breaks the trace: a `git commit` whose message does not
 * reference the branch's issue, or a `gh pr create` whose body does not close
 * it. When the message or body cannot be told from the command text, it
 * refuses rather than guess.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {World} [world]
 * @returns {string | null}
 */
export function commandVerdict(command, cwd, world = REAL) {
  if (world.env[BYPASS] === '1') return null
  /** @type {string | null} where the next command runs, or null once a `cd` makes that unknowable */
  let dir = cwd
  let cdLevel = 0
  for (const c of parseCommands(command)) {
    /** @type {string | null} */
    const here = dir !== null && (c.level === cdLevel || dir === cwd) ? (c.chdir === undefined ? dir : resolveIn(dir, c.chdir)) : null
    if (c.name === 'cd' || c.name === 'pushd' || c.name === 'popd') {
      const to = c.args.find(a => !a.startsWith('-'))
      dir = c.name === 'popd' || here === null ? null : to === undefined ? homedir() : resolveIn(here, to)
      cdLevel = c.level
      continue
    }
    const why = c.name === 'git' ? commitVerdict(c, here, world) : c.name === 'gh' ? prVerdict(c, here, world) : null
    if (why) return why
  }
  return null
}

/** @param {string} dir @param {string} to @returns {string | null} */
const resolveIn = (dir, to) => (/[$`]/.test(to) || to === '-' ? null : resolve(dir, untilde(to, dir)))

const COMMIT_VALUES = 'mFCctSu'

/**
 * @param {SimpleCommand} c a `git` command
 * @param {string | null} dir where it runs, or null when unknowable
 * @param {World} world
 */
function commitVerdict(c, dir, world) {
  const parts = gitParts(c.args)
  let sub = parts.sub
  let rest = parts.rest
  const inline = parts.config.map(kv => /^alias\.([^=]+)=(.*)$/s.exec(kv)).find(m => m?.[1] === sub)
  const gitDir = dir === null ? null : parts.dirs.reduce((/** @type {string | null} */ d, x) => d && resolveIn(d, x), dir)
  const root = gitDir === null ? null : tracedRoot(gitDir, world.git)
  const alias = inline ? inline[2] : sub && root && !GIT_COMMANDS.has(sub) ? world.git.alias(root, sub) : null
  if (!inline && sub && !GIT_COMMANDS.has(sub) && gitDir === null) return cannotTell(`what \`git ${sub}\` runs, or where`, 'run `git commit` directly, from the repository', 'Implement')
  if (alias?.startsWith('!')) return root ? `the trace cannot tell what the git alias \`${sub}\` runs, so cannot tell whether it commits. Implement step: run \`git commit\` directly.` : null
  if (alias) {
    const words = parseCommands(alias)[0]
    sub = words?.name
    rest = [...(words?.args ?? []), ...rest]
  }
  if (sub !== 'commit') return null
  if (gitDir === null || parts.relocated) return cannotTell('which repository this commit lands in', 'run `git commit` from the repository, or with `git -C <dir>`', 'Implement')
  if (!root) return null
  const { why, n } = issueVerdict(root, world.git.branch(root), world)
  if (why) return why
  const text = commitMessage(rest, c, gitDir, root, world.git)
  const fix = `add "#${n}" to the commit message, e.g. end the subject with "(#${n})"`
  if (text === UNKNOWN) return cannotTell('the commit message', `pass it with -m or a heredoc to -F -, and ${fix}`, 'Implement')
  if (new RegExp(`(^|[^\\w&/])#${n}(?!\\d)`).test(text)) return null
  if (/[$`]/.test(text)) return cannotTell('the commit message, which the shell computes', `write it out, and ${fix}`, 'Implement')
  return `this commit message does not reference #${n}, the issue of this branch. Implement step: ${fix}.`
}

/**
 * The message `git commit <rest>` would record, or UNKNOWN.
 *
 * @param {string[]} rest @param {SimpleCommand} c @param {string} dir @param {string} root @param {Git} git
 * @returns {string | typeof UNKNOWN}
 */
function commitMessage(rest, c, dir, root, git) {
  /** @type {string[]} */
  const texts = []
  let amend = false
  let editor = false
  /** @param {string} rev */
  const reuse = rev => {
    const m = git.message(root, rev.replace(/^(?:amend|reword):/, ''))
    if (m === null) return false
    texts.push(m)
    return true
  }
  /** @param {string} letter @param {string} v @returns {boolean} false when the value makes the message unknowable */
  const take = (letter, v) => {
    if (letter === 'm') texts.push(v)
    else if (letter === 'F') {
      const text = v === '-' ? (c.piped ? undefined : c.stdin) : readText(resolve(dir, untilde(v, dir)))
      if (text === undefined) return false
      texts.push(text)
    } else if (letter === 'C' || letter === 'c') return reuse(v)
    else if (letter === 't') editor = true
    return true
  }
  const LONG = { message: 'm', file: 'F', 'reuse-message': 'C', 'reedit-message': 'c', template: 't', fixup: 'C', squash: 'C' }
  for (let i = 0; i < rest.length; i++) {
    const a = /** @type {string} */ (rest[i])
    if (a === '--') break
    const long = /^--([a-z-]+)(?:=(.*))?$/s.exec(a)
    if (long) {
      const [, name = '', glued] = long
      if (name === 'amend') amend = true
      else if (name === 'edit') editor = true
      else if (name === 'no-edit') editor = false
      else if (name in LONG) {
        const v = glued ?? rest[++i]
        if (v === undefined || !take(LONG[/** @type {keyof typeof LONG} */ (name)], v)) return UNKNOWN
      }
      continue
    }
    if (!/^-[^-]/.test(a)) continue
    for (let j = 1; j < a.length; j++) {
      const letter = /** @type {string} */ (a[j])
      if (letter === 'e') editor = true
      if (!COMMIT_VALUES.includes(letter)) continue
      // -S and -u take their value only when glued.
      const v = j + 1 < a.length ? a.slice(j + 1) : letter === 'S' || letter === 'u' ? '' : rest[++i]
      if (v === undefined || !take(letter, v)) return UNKNOWN
      break
    }
  }
  if (editor) return UNKNOWN
  if (!texts.length && amend && !reuse('HEAD')) return UNKNOWN
  return texts.length ? texts.join('\n\n') : UNKNOWN
}

/** @param {string} path @returns {string | undefined} */
const readText = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * @param {SimpleCommand} c a `gh` command
 * @param {string | null} dir where it runs, or null when unknowable
 * @param {World} world
 */
function prVerdict(c, dir, world) {
  let args = c.args
  const root = dir === null ? null : tracedRoot(dir, world.git)
  const first = args[0]
  if (first && !GH_COMMANDS.has(first) && (root || dir === null)) {
    const alias = world.github.alias(first)
    if (alias?.startsWith('!')) return `the trace cannot tell what the gh alias \`${first}\` runs, so cannot tell whether it opens a PR. Review step: run \`gh pr create\` directly.`
    if (alias) args = [...(parseCommands(`gh ${alias}`)[0]?.args ?? []), ...args.slice(1)]
  }
  if (args[0] !== 'pr' || args[1] !== 'create') return null
  if (dir === null) return cannotTell('which repository this PR is opened from', 'run `gh pr create` from the repository', 'Review')
  if (!root) return null
  const opts = args.slice(2)
  /** @param {string} short @param {string} long */
  const value = (short, long) => {
    for (let i = 0; i < opts.length; i++) {
      const a = /** @type {string} */ (opts[i])
      if (a === short || a === `--${long}`) return opts[i + 1]
      if (a.startsWith(`--${long}=`)) return a.slice(long.length + 3)
      if (short && a.startsWith(short) && a.length > 2) return a.slice(2)
    }
    return undefined
  }
  const head = value('-H', 'head')?.replace(/^[^:]*:/, '') ?? world.git.branch(root)
  const { why, n } = issueVerdict(root, head, world)
  if (why) return why
  const fix = `put "Closes #${n}" in the PR body`
  const body = value('-b', 'body')
  const file = value('-F', 'body-file')
  /** @type {string | undefined} */
  let text = body
  if (file !== undefined) text = file === '-' ? (c.piped ? undefined : c.stdin) : readText(resolve(dir, untilde(file, dir)))
  const asksElsewhere = opts.some(a => /^(?:-[fwe]|--(?:fill|fill-first|fill-verbose|web|editor|template|recover)(?:=.*)?|-T.*)$/.test(a))
  if (text === undefined || asksElsewhere) return cannotTell('the PR body', `pass it with --body or a heredoc to --body-file -, and ${fix}`, 'Review')
  if (new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#${n}(?!\\d)`, 'i').test(text)) return null
  if (/[$`]/.test(text)) return cannotTell('the PR body, which the shell computes', `write it out, and ${fix}`, 'Review')
  return `this PR body does not close #${n}, the issue of its branch. Review step: ${fix}.`
}

/** @param {string} what @param {string} fix @param {string} step */
const cannotTell = (what, fix, step) => `the trace cannot tell ${what}. ${step} step: ${fix}.`

// git's own subcommands: a word outside this set may be an alias.
const GIT_COMMANDS = new Set(
  'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout checkout-index cherry cherry-pick citool clean clone commit commit-graph commit-tree config count-objects describe diff diff-files diff-index diff-tree difftool fetch fetch-pack for-each-ref format-patch fsck gc grep gui hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mktag mktree mv notes pull push range-diff read-tree rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-pack verify-tag whatchanged worktree write-tree'.split(' '),
)

// gh's own top-level commands: a word outside this set may be an alias.
const GH_COMMANDS = new Set(
  'agent-task alias api attestation auth browse cache co codespace completion config copilot extension gist gpg-key help issue label org pr preview project release repo ruleset run search secret ssh-key status variable workflow'.split(' '),
)

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
  message: (root, rev) => git(root, ['log', '-1', '--format=%B', rev, '--']),
  alias: (root, name) => git(root, ['config', '--get', `alias.${name}`]),
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
  alias(name) {
    const r = spawnSync('gh', ['alias', 'list'], { encoding: 'utf8', timeout: Math.min(5000, timeLeft()) })
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith(`${name}:`))
    return line ? line.slice(name.length + 1).trim().replace(/^'(.*)'$/s, '$1') : null
  },
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

/** @type {World} */
const REAL = { git: realGit, github: realGitHub, env: process.env }
