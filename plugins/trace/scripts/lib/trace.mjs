// The trace: whether an action is traceable, from git and GitHub state
// (ADR 0006). In a traced repository, a file inside it may be edited only on
// the branch of an open issue, a commit must reference that issue and a PR
// close it, and nothing the model writes turns that off.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { fold, real, untilde } from './paths.mjs'
import { gitParts, parseCommands, readOptions, withCwds } from './shell.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

// The human's switch, set when launching Claude Code, that turns the trace off.
const BYPASS = 'TRACE_BYPASS'
const BYPASS_HINT = `to work untraced, the human can launch Claude Code with ${BYPASS}=1`

/**
 * What the trace needs from git. `origin` is origin's GitHub repository as
 * `owner/name`; `message` a commit's message; `alias` and `config` a
 * setting's value.
 *
 * @typedef {{
 *   root(path: string): string | null,
 *   traced(root: string): boolean,
 *   branch(root: string): string | null,
 *   defaultBranch(root: string): string | null,
 *   origin(root: string): string | null,
 *   message(root: string, rev: string): string | null,
 *   alias(root: string, name: string): string | null,
 *   config(root: string, key: string): string | null,
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

// --- the edit gate ---------------------------------------------------------------

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
  const linked = linkedIssue(root, world.git.branch(root), world)
  return 'why' in linked ? linked.why : null
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
 * The linked issue of `branch` in a traced repository, or why it has none.
 *
 * @param {string} root @param {string | null} branch @param {World} world
 * @returns {{ n: number } | { why: string }}
 */
function linkedIssue(root, branch, { git, github }) {
  if (branch && branch === git.defaultBranch(root)) {
    return { why: `this is the default branch (${branch}). Branch step: work on the issue's branch, \`gh issue develop <n> --checkout\` (Track first if there is no issue).` }
  }
  const n = Number(/^(\d+)-/.exec(branch ?? '')?.[1])
  if (!n) {
    return { why: `the branch ${branch ?? '(detached HEAD)'} names no issue. Track step: open an issue (to-tickets), then \`gh issue develop <n> --checkout\`.` }
  }
  const state = github.issueState(root, n)
  if (state === 'OPEN') return { n }
  if (state === null) {
    return { why: `GitHub could not say whether issue #${n} is open; check \`gh auth status\`, the network, and that origin is on GitHub. Track step: the work waits for an open issue; ${BYPASS_HINT}.` }
  }
  return { why: `#${n} is ${state === 'CLOSED' ? 'a closed issue' : 'not an open issue'}. Track step: open an issue for this change (to-tickets) and work on its branch.` }
}

// --- the commit and PR gates -----------------------------------------------------

/**
 * One command of a Bash command line, with where it may run and the
 * commands before it on the same line.
 *
 * @typedef {{ c: SimpleCommand, at: string[], unknown: boolean, earlier: { c: SimpleCommand, at: string[] }[] }} Run
 */

/**
 * Why a Bash command breaks the trace: a `git commit` whose message does not
 * reference the linked issue, or a `gh pr create` whose body does not close
 * it. When the message, the body or the repository cannot be told from the
 * command text, it refuses rather than guess.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {World} [world]
 * @returns {string | null}
 */
export function commandVerdict(command, cwd, world = REAL) {
  if (world.env[BYPASS] === '1') return null
  /** @type {Run['earlier']} */
  const earlier = []
  for (const { c, at, unknown } of withCwds(command, cwd)) {
    const run = { c, at, unknown, earlier: [...earlier] }
    const why = c.name === 'git' ? commitVerdict(run, world) : c.name === 'gh' ? prVerdict(run, world) : /[$`]/.test(c.name) ? computedVerdict(run, world) : null
    if (why) return why
    earlier.push({ c, at })
  }
  return null
}

/**
 * The one traced repository among `dirs`, and the directory relative paths
 * resolve in when the candidates agree; or `unknowable`.
 *
 * @param {(string | null)[]} dirs @param {boolean} unknown @param {Git} git
 * @returns {{ root: string | null, dir: string | null } | 'unknowable'}
 */
function where(dirs, unknown, git) {
  if (unknown || dirs.includes(null)) return 'unknowable'
  const roots = [...new Set(dirs.map(d => tracedRoot(/** @type {string} */ (d), git)).filter(r => r !== null))]
  if (roots.length > 1) return 'unknowable'
  return { root: roots[0] ?? null, dir: new Set(dirs).size === 1 ? /** @type {string} */ (dirs[0]) : null }
}

/** @param {string} dir @param {string} to @returns {string | null} */
const resolveIn = (dir, to) => (/[$`]/.test(to) || to === '-' ? null : resolve(dir, untilde(to, dir)))

/** @param {string} what @param {string} fix @param {string} step */
const cannotTell = (what, fix, step) => `the trace cannot tell ${what}. ${step} step: ${fix}.`

/**
 * The verdict on a message or body: null when `accepts` finds the reference
 * in the text the shell leaves, or a refusal saying what to add.
 *
 * @param {string | null} text null when it cannot be told
 * @param {RegExp} accepts
 * @param {{ what: string, how: string, step: string, fix: string, refusal: string }} o
 */
function judge(text, accepts, { what, how, step, fix, refusal }) {
  if (text === null) return cannotTell(`the ${what}`, `pass it with ${how}, and ${fix}`, step)
  const plain = dropExpansions(text)
  if (accepts.test(plain)) return null
  if (plain !== text) return cannotTell(`the ${what}, which the shell computes`, `write it out, and ${fix}`, step)
  return `${refusal} ${step} step: ${fix}.`
}

/**
 * `text` with each shell expansion replaced by `0`, which can neither start
 * nor finish a reference: `Closes ${X}#7` may become `Closes other/repo#7`.
 *
 * @param {string} text @returns {string}
 */
function dropExpansions(text) {
  let t = text
  for (let before = ''; before !== t; ) {
    before = t
    t = t.replace(/\$\([^()]*\)|`[^`]*`|\$\{[^{}]*\}|\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])/g, '0')
  }
  return t
}

/** @param {string} s */
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text an option's value names: `-` for stdin, or a file. A file that an
 * earlier command on the same line writes counts only when that command is
 * `cat > file <<EOF`, whose text is known.
 *
 * @param {string | undefined} v @param {Run} run @param {string | null} dir
 * @returns {string | null}
 */
function fileText(v, run, dir) {
  if (v === undefined || /[$`]/.test(v)) return null
  if (v === '-') return run.c.piped ? null : run.c.stdin ?? null
  const path = isAbsolute(untilde(v, '/')) ? untilde(v, '/') : dir === null ? null : resolve(dir, untilde(v, dir))
  if (path === null) return null
  /** @type {string | undefined} */
  let written
  for (const e of run.earlier) {
    // A target the shell computes may be this file.
    if (e.c.files.some(w => /[$`*?[]/.test(w)) || (!PRINTS.has(e.c.name) && e.c.args.some(w => /[$`*?[]/.test(w)))) return null
    if (!e.at.some(d => [...e.c.args, ...e.c.files].some(w => resolve(d, untilde(w, d)) === path))) continue
    if (e.c.name !== 'cat' || e.c.args.length || e.c.stdin === undefined || e.c.piped) return null
    written = e.c.stdin
  }
  if (written !== undefined) return written
  try {
    // A FIFO or a device would block the hook past its timeout.
    const st = statSync(path)
    return st.isFile() && st.size <= 1_000_000 ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

// Commands that write only to stdout, unless redirected.
const PRINTS = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'cd', 'pushd', 'popd', 'pwd'])

// git commit's options, from `git commit -h`.
/** @type {import('./shell.mjs').OptionTable} */
const GIT_COMMIT = {
  message: { short: 'm', value: 'required' },
  file: { short: 'F', value: 'required' },
  'reuse-message': { short: 'C', value: 'required' },
  'reedit-message': { short: 'c', value: 'required' },
  template: { short: 't', value: 'required' },
  fixup: { value: 'required' },
  squash: { value: 'required' },
  cleanup: { value: 'required' },
  author: { value: 'required' },
  date: { value: 'required' },
  trailer: { value: 'required' },
  'pathspec-from-file': { value: 'required' },
  unified: { short: 'U', value: 'required' },
  'inter-hunk-context': { value: 'required' },
  'gpg-sign': { short: 'S', value: 'optional' },
  'untracked-files': { short: 'u', value: 'optional' },
  ...Object.fromEntries(
    [['quiet', 'q'], ['verbose', 'v'], ['signoff', 's'], ['edit', 'e'], ['all', 'a'], ['include', 'i'], ['patch', 'p'], ['only', 'o'], ['no-verify', 'n'], ['null', 'z']].map(([l, s]) => [l, { short: s }]),
  ),
  ...Object.fromEntries(
    ['reset-author', 'interactive', 'verify', 'dry-run', 'short', 'branch', 'ahead-behind', 'porcelain', 'long', 'amend', 'post-rewrite', 'status', 'pathspec-file-nul', 'allow-empty', 'allow-empty-message'].map(l => [l, {}]),
  ),
}

// gh pr create's options, from `gh pr create --help`, with the inherited -R.
/** @type {import('./shell.mjs').OptionTable} */
const GH_PR_CREATE = {
  ...Object.fromEntries(
    [['assignee', 'a'], ['base', 'B'], ['body', 'b'], ['body-file', 'F'], ['head', 'H'], ['label', 'l'], ['milestone', 'm'], ['project', 'p'], ['reviewer', 'r'], ['template', 'T'], ['title', 't'], ['repo', 'R'], ['attach', ''], ['recover', '']].map(([l, s]) => [l, { ...(s ? { short: s } : {}), value: /** @type {const} */ ('required') }]),
  ),
  ...Object.fromEntries([['draft', 'd'], ['editor', 'e'], ['fill', 'f'], ['web', 'w']].map(([l, s]) => [l, { short: s }])),
  ...Object.fromEntries(['dry-run', 'fill-first', 'fill-verbose', 'no-maintainer-edit', 'help'].map(l => [l, {}])),
}

// Options that leave the PR body to gh, an editor or a browser.
const BODY_ELSEWHERE = new Set(['fill', 'fill-first', 'fill-verbose', 'web', 'editor', 'template', 'recover'])

/** @param {Run} run @param {World} world */
function commitVerdict(run, world) {
  let parts = gitParts(run.c.args)
  const dirs = run.at.map(d => parts.dirs.reduce((/** @type {string | null} */ x, y) => x && resolveIn(x, y), d))
  const place = where(dirs, run.unknown || parts.relocated, world.git)
  const lookIn = place === 'unknowable' ? null : place.root ?? place.dir
  /** @type {string[]} */
  let config = parts.config
  let rest = parts.rest
  // Follow aliases, which may name other aliases.
  for (let hops = 0; parts.sub && !GIT_COMMANDS.has(parts.sub) && hops < 5; hops++) {
    const name = parts.sub
    const inline = [...config].reverse().map(kv => /^alias\.([^=]+)=(.*)$/is.exec(kv)).find(m => m?.[1]?.toLowerCase() === name.toLowerCase())
    const alias = inline ? (inline[2] ?? '') : lookIn ? world.git.alias(lookIn, name) : null
    if (alias !== null && /[$`]/.test(alias)) return aliasVerdict(`the git alias \`${name}\``, place, world, n => `run \`git commit\` directly, with "#${n}" in its message`, 'Implement')
    if (alias === null) {
      if (lookIn) return null
      return cannotTell(`what \`git ${name}\` runs, or where`, 'run `git commit` directly, from the repository', 'Implement')
    }
    if (alias.startsWith('!')) return aliasVerdict(`the git alias \`${name}\``, place, world, n => `run \`git commit\` directly, with "#${n}" in its message`, 'Implement')
    const expanded = gitParts(parseCommands(`git ${alias}`)[0]?.args ?? [])
    parts = { ...expanded, rest: [...expanded.rest, ...rest] }
    config = [...config, ...expanded.config]
    rest = parts.rest
  }
  if (parts.sub !== 'commit') return null
  if (place === 'unknowable') return cannotTell('which repository this commit lands in', 'run `git commit` from the repository, or with `git -C <dir>`', 'Implement')
  if (!place.root) return null
  const linked = linkedIssue(place.root, world.git.branch(place.root), world)
  if ('why' in linked) return linked.why
  const { opts, unknown } = readOptions(rest, GIT_COMMIT, { abbrev: true })
  if (opts.some(([name]) => name === 'dry-run')) return null
  const { n } = linked
  const slug = world.git.origin(place.root)
  return judge(unknown ? null : commitMessage(opts, run, place.dir, place.root, config, world.git), new RegExp(`(?:^|[^\\w&/])#${n}(?!\\d)${slug ? `|${escape(slug)}#${n}(?!\\d)` : ''}`, 'i'), {
    what: 'commit message',
    how: '-m or a heredoc to -F -',
    step: 'Implement',
    fix: `add "#${n}" to the commit message, e.g. end the subject with "(#${n})"`,
    refusal: `this commit message does not reference #${n}, the linked issue.`,
  })
}

/**
 * The message `git commit` records, or null when an editor, a computed
 * file or an unreadable commit decides it.
 *
 * @param {[string, string | undefined][]} opts
 * @param {Run} run @param {string | null} dir @param {string} root
 * @param {string[]} config inline `-c` settings
 * @param {Git} git
 * @returns {string | null}
 */
function commitMessage(opts, run, dir, root, config, git) {
  /** @type {string[]} */
  const texts = []
  let editor = false
  let amend = false
  let noEdit = false
  /** @type {Record<string, string | undefined>} */
  const last = {}
  for (const [name, v] of opts) {
    if (name === 'message' || name === 'trailer') texts.push(v ?? '')
    else if (name === 'file') {
      const text = fileText(v, run, dir)
      if (text === null) return null
      texts.push(text)
    } else if (name === 'edit' || name === 'reedit-message' || name === 'template') [editor, noEdit] = [true, false]
    else if (name === 'no-edit') [editor, noEdit] = [false, true]
    else if (name === 'amend' || name === 'no-amend') amend = name === 'amend'
    if (name === 'reedit-message') last['reuse-message'] = v
    else last[name] = v
  }
  const subject = (/** @type {string | undefined} */ rev) => (rev === undefined ? null : git.message(root, rev)?.split('\n')[0] ?? null)
  if (last.fixup !== undefined) {
    if (/^(?:amend|reword):/.test(last.fixup)) return null
    const s = subject(last.fixup)
    if (s === null) return null
    texts.unshift(`fixup! ${s}`)
  }
  if (last.squash !== undefined) {
    const s = subject(last.squash)
    if (s === null || texts.length === 0) return null
    texts.unshift(`squash! ${s}`)
  }
  if (last['reuse-message'] !== undefined) {
    const m = git.message(root, last['reuse-message'])
    if (m === null) return null
    texts.push(m)
  }
  if (texts.length === 0) {
    if (!amend || !noEdit) return null
    const m = git.message(root, 'HEAD')
    if (m === null) return null
    texts.push(m)
  }
  if (editor) return null
  // Under strip or scissors cleanup, git drops comment lines.
  const setting = (/** @type {string} */ key) =>
    [...config].reverse().find(kv => kv.toLowerCase().startsWith(`${key.toLowerCase()}=`))?.slice(key.length + 1) ?? git.config(root, key)
  const mode = last.cleanup ?? setting('commit.cleanup')
  if (mode && /[$`]/.test(mode)) return null
  let text = texts.join('\n\n')
  if (mode === 'strip' || mode === 'scissors') {
    const cc = setting('core.commentString') ?? setting('core.commentChar') ?? '#'
    if (cc === 'auto' || cc === '' || /[$`]/.test(cc)) return null
    if (mode === 'scissors') text = text.split(`\n${cc} ------------------------ >8 ------------------------`)[0] ?? ''
    text = text.split('\n').filter(l => !l.startsWith(cc)).join('\n')
  }
  return text
}

/** @param {Run} run @param {World} world */
function prVerdict(run, world) {
  let args = run.c.args
  let { opts, operands, unknown } = readOptions(args, GH_PR_CREATE)
  const place = where(run.at, run.unknown, world.git)
  const first = operands[0]
  if (first !== undefined && !GH_COMMANDS.has(first)) {
    const alias = world.github.alias(first)
    if (alias === null) return null
    if (alias.startsWith('!')) return aliasVerdict(`the gh alias \`${first}\``, place, world, n => `run \`gh pr create\` directly, with "Closes #${n}" in its body`, 'Review')
    const at = args.indexOf(first)
    args = [...args.slice(0, at), ...(parseCommands(`gh ${alias}`)[0]?.args ?? []), ...args.slice(at + 1)]
    ;({ opts, operands, unknown } = readOptions(args, GH_PR_CREATE))
  }
  const creates = (/** @type {string[]} */ ops) => ops[0] === 'pr' && (ops[1] === 'create' || ops[1] === 'new')
  if (!creates(operands) && !(unknown && creates(args.filter(a => !a.startsWith('-'))))) return null
  if (place === 'unknowable') return cannotTell('which repository this PR is opened from', 'run `gh pr create` from the repository', 'Review')
  if (!place.root) return null
  /** @type {Record<string, string | undefined>} */
  const last = Object.fromEntries(opts)
  if ('dry-run' in last) return null
  const head = last.head?.replace(/^[^:]*:/, '') ?? world.git.branch(place.root)
  const linked = linkedIssue(place.root, head, world)
  if ('why' in linked) return linked.why
  const { n } = linked
  const slug = world.git.origin(place.root)
  const fix = `put "Closes #${n}" in the PR body`
  if (last.repo !== undefined && last.repo.replace(/^[^/]+\/(?=[^/]+\/)/, '').toLowerCase() !== slug?.toLowerCase()) {
    return cannotTell(`which issue #${n} is in ${last.repo}`, `open the PR in origin's repository, and ${fix}`, 'Review')
  }
  const bodyOpt = [...opts].reverse().find(([name]) => name === 'body' || name === 'body-file')
  const text = unknown || opts.some(([name]) => BODY_ELSEWHERE.has(name)) || !bodyOpt ? null : bodyOpt[0] === 'body' ? bodyOpt[1] ?? null : fileText(bodyOpt[1], run, place.dir)
  const ref = `(?:#${n}${slug ? `|${escape(slug)}#${n}|https://github\\.com/${escape(slug)}/issues/${n}` : ''})(?![\\w/])`
  return judge(text === null ? null : dropMarkdownCode(text), new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+${ref}`, 'i'), {
    what: 'PR body',
    how: '--body or a heredoc to --body-file -',
    step: 'Review',
    fix,
    refusal: `this PR body does not close #${n}, the linked issue.`,
  })
}

/** @param {string} text @returns {string} `text` without what GitHub does not read as links: code and comments */
const dropMarkdownCode = text =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')

/**
 * A shell alias that may commit or open a PR: refused wherever it may land
 * in a traced repository.
 *
 * @param {string} what @param {ReturnType<typeof where>} place @param {World} world
 * @param {(n: number) => string} fix @param {string} step
 */
function aliasVerdict(what, place, world, fix, step) {
  if (place !== 'unknowable' && !place.root) return null
  const linked = place === 'unknowable' || !place.root ? null : linkedIssue(place.root, world.git.branch(place.root), world)
  if (linked && 'why' in linked) return linked.why
  return cannotTell(`what ${what} runs`, linked ? fix(linked.n) : 'run the command directly', step)
}

/**
 * A command word the shell computes (`$(echo git) commit`) that may commit
 * or open a PR.
 *
 * @param {Run} run @param {World} world
 */
function computedVerdict(run, world) {
  const a = run.c.args
  if (!a.includes('commit') && !(a.includes('pr') && (a.includes('create') || a.includes('new')))) return null
  const place = where(run.at, run.unknown, world.git)
  if (place !== 'unknowable' && !place.root) return null
  return cannotTell(`which command \`${run.c.name}\` is`, 'name git or gh directly', a.includes('commit') ? 'Implement' : 'Review')
}

// git's own subcommands: a word outside this set may be an alias.
const GIT_COMMANDS = new Set(
  'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout checkout-index cherry cherry-pick citool clean clone commit commit-graph commit-tree config count-objects describe diff diff-files diff-index diff-tree difftool fetch fetch-pack for-each-ref format-patch fsck gc grep gui hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mktag mktree mv notes pull push range-diff read-tree rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-pack verify-tag whatchanged worktree write-tree'.split(' '),
)

// gh's own top-level commands: a word outside this set may be an alias.
const GH_COMMANDS = new Set(
  'agent-task alias api attestation auth browse cache co codespace completion config copilot extension gist gpg-key help issue label org pr preview project release repo ruleset run search secret ssh-key status variable workflow'.split(' '),
)

// --- the switches -------------------------------------------------------------------

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
  origin(root) {
    const url = git(root, ['remote', 'get-url', 'origin']) ?? ''
    return /(?:^|[@/])github\.com(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1] ?? null
  },
  message: (root, rev) => git(root, ['log', '-1', '--format=%B', rev, '--']),
  alias: (root, name) => git(root, ['config', '--get', `alias.${name}`]),
  config: (root, key) => git(root, ['config', '--get', key]),
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
    const slug = realGit.origin(root)
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
