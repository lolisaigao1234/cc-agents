// The trace: whether an action is traceable, from git and GitHub state
// (ADR 0006). In a traced repository, a file inside it may be edited only on
// the branch of an open issue, by an agent that has read the related docs
// (ADR 0007); a commit must reference that issue and a PR close it, and
// nothing the model writes turns that off.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { decode, docsVerdict, fileRecord, isDocName, once, outputRecords, writeRecord } from './docs.mjs'

import { fold, real, toolPath, untilde } from './paths.mjs'
import { GIT_COMMIT_OPTIONS, computed, gitParts, literal, parseCommands, readOptions, unliteral, withCwds } from './shell.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

// The human's switch, set when launching Claude Code, that turns the trace off.
const BYPASS = 'TRACE_BYPASS'
const BYPASS_HINT = `to work untraced, the human can launch Claude Code with ${BYPASS}=1`
// How an issue is opened, in the trace skill's words, with the section the issue context reads (context.mjs).
const TRACK_HINT = '`gh issue create` with an `## Acceptance criteria` section'

/**
 * What the trace needs from git. `origin` is origin's GitHub repository as
 * `owner/name`, and `ghBase` the one gh opens PRs in when not told; `message`
 * a commit's message; `config` a setting's value; `headDocs` the glossary and
 * ADRs as HEAD has them; `pushed` the head of a branch as its remote last
 * had it here, and when it got there (ISO 8601), or null when that holds
 * nothing beyond the remote's other branches; `committed` whether HEAD has a
 * commit the default branch does not whose message references #n, as the
 * commit gate reads a reference.
 *
 * @typedef {{
 *   root(path: string): string | null,
 *   traced(root: string): boolean,
 *   branch(root: string): string | null,
 *   defaultBranch(root: string): string | null,
 *   origin(root: string): string | null,
 *   message(root: string, rev: string): string | null,
 *   ghBase(root: string): string | null,
 *   config(root: string, key: string): string | null,
 *   headDocs(root: string): import('./docs.mjs').HeadDocs,
 *   pushed(root: string, branch: string): { sha: string, at: string } | null,
 *   committed(root: string, n: number): boolean,
 * }} Git
 */

/**
 * A pull request, and its checks by name and state (a check run's
 * conclusion, `PENDING` until it completes, or a status's state), the latest
 * run of each.
 *
 * @typedef {{ n: number, url: string, state: 'OPEN' | 'MERGED' | 'CLOSED', checks: { name: string, state: string }[] }} PullRequest
 */

/**
 * What the trace needs from GitHub: an issue's state, and its text, or null
 * when GitHub cannot be asked. A pull request is 'MISSING': it is not an issue.
 * `pr` is the latest PR from a branch, 'NONE', or null when GitHub cannot say.
 *
 * @typedef {{
 *   issueState(root: string, n: number): 'OPEN' | 'CLOSED' | 'MISSING' | null,
 *   issue(root: string, n: number): import('./docs.mjs').Issue | null,
 *   alias(name: string): string | null,
 *   pr(root: string, branch: string): PullRequest | 'NONE' | null,
 * }} GitHub
 */

/**
 * `once(key)` is true the first time it is asked about `key`. `timeLeft()`,
 * in a real world, is the milliseconds its call has left for git and GitHub,
 * and throws once there are none; the archive block shares it.
 *
 * @typedef {{ git: Git, github: GitHub, env: Record<string, string | undefined>, reads: import('./docs.mjs').Reads, once(key: string): boolean, timeLeft?: () => number }} World
 */

// --- the edit gate ---------------------------------------------------------------

/**
 * Why editing `path` breaks the trace, or null if it may be edited.
 *
 * @param {string} path an absolute path, symlinks resolved
 * @param {World} [world]
 * @returns {string | null}
 */
export function editVerdict(path, world = realWorld()) {
  if (world.env[BYPASS] === '1') return null
  const root = tracedRoot(path, world.git)
  if (!root) return null
  if (fold(path) === fold(`${root}/.git`) || fold(path).startsWith(fold(`${root}/.git/`))) {
    return "this is the repository's git directory. Branch step: change branches and remotes with git and `gh issue develop`, never by editing .git/."
  }
  const linked = linkedIssue(root, world.git.branch(root), world)
  return 'why' in linked ? linked.why : readVerdict(root, linked.n, [relative(root, path)], world)
}

/** @param {string} root @param {number} n @param {string[] | null} paths @param {World} world */
export const readVerdict = (root, n, paths, world) =>
  docsVerdict(root, n, paths, {
    issue: world.github.issue(root, n),
    slug: world.git.origin(root),
    head: world.git.headDocs(root),
    records: () => world.reads.records(),
    unknownAgent: cannotTell('which agent this is, so not what it has read', `the change waits for a hook input that names the agent; ${BYPASS_HINT}`, 'Read'),
  })

// Claude Code cuts a Bash output this long to a short preview, which is all the agent sees.
const PERSISTED = 30_000
const PREVIEW = 2_000

/** @param {string} out @returns {string} the preview of a cut output, as Claude Code makes it */
function preview(out) {
  const t = out.replace(/^(\s*\n)+/, '').trimEnd()
  if (t.length <= PREVIEW) return t
  const nl = t.slice(0, PREVIEW).lastIndexOf('\n')
  return t.slice(0, nl > PREVIEW / 2 ? nl : PREVIEW)
}

/**
 * What a PostToolUse input shows its agent has read: a Read's lines, and, in
 * a file outside the repository (a saved output), the linked issue's parts
 * and HEAD's docs it holds; what a `gh` or `git show` command printed of
 * them, counting only the preview when the output was too long to show
 * whole; or a doc the agent wrote or edited knowing all of it.
 *
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown, cwd?: string }} input
 * @param {World} [world]
 * @returns {import('./docs.mjs').ReadRecord[]}
 */
export function readRecord(input, world = realWorld()) {
  const cwd = input.cwd ?? process.cwd()
  const linked = () => {
    const root = tracedRoot(real(cwd), world.git)
    const n = root && branchIssue(world.git.branch(root))
    return root && n ? { root, n } : null
  }
  const response = /** @type {Record<string, unknown> | null} */ (input.tool_response)
  if (input.tool_name === 'Read') {
    const file = fileRecord(response)
    const read = /** @type {{ filePath?: unknown, content?: unknown } | undefined} */ (response?.file)
    const at = typeof read?.filePath === 'string' && typeof read.content === 'string' ? linked() : null
    if (!at || !read || typeof read.content !== 'string') return file ? [file] : []
    const path = fold(real(String(read.filePath)))
    const inside = path === fold(at.root) || path.startsWith(`${fold(at.root)}/`)
    return [...(file ? [file] : []), ...(inside ? [] : outputRecords(read.content, at.root, at.n, world.github.issue(at.root, at.n), world.git.headDocs(at.root)))]
  }
  if (input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'MultiEdit') {
    const raw = input.tool_input?.file_path
    if (typeof raw !== 'string') return []
    const change =
      input.tool_name === 'Write'
        ? { written: String(input.tool_input?.content ?? '') }
        : typeof response?.originalFile === 'string'
          ? { expected: afterEdit(input.tool_name, input.tool_input ?? {}, response.originalFile), original: response.originalFile, userModified: response.userModified === true }
          : null
    const record = change && writeRecord(toolPath(raw, cwd), change, world.reads.records())
    return record ? [record] : []
  }
  const command = String(input.tool_input?.command ?? '')
  const stdout = response?.stdout
  const asksGitHub = /\bgh\b/.test(command) && /\b(?:issue|api)\b/.test(command)
  const asksGit = /\bgit\b/.test(command) && /\b(?:show|cat-file)\b/.test(command)
  if (input.tool_name !== 'Bash' || typeof stdout !== 'string' || !(asksGitHub || asksGit)) return []
  const at = linked()
  if (!at) return []
  const cut = typeof response?.persistedOutputPath === 'string' || stdout.length >= PERSISTED
  const shown = [command, ...postedTexts(command), cut ? preview(stdout) : stdout].join('\n')
  return outputRecords(shown, at.root, at.n, asksGitHub ? world.github.issue(at.root, at.n) : null, asksGit ? world.git.headDocs(at.root) : null)
}

/**
 * The words of a `gh` command line as the shell passes them: text the agent
 * wrote, such as a comment it posts. A `--body-file` does not count; the
 * agent may never have seen what is in it.
 *
 * @param {string} command @returns {string[]}
 */
const postedTexts = command =>
  parseCommands(command)
    .filter(c => c.name === 'gh')
    .flatMap(c => c.args.map(unliteral))

/** @param {string | null} branch @returns {number | null} the issue a branch's `<n>-` prefix names */
export const branchIssue = branch => Number(/^(\d+)-/.exec(branch ?? '')?.[1]) || null

/** @param {import('./docs.mjs').Reads} reads @returns {World} the real world, as the agent with `reads` sees it */
export const worldFor = reads => ({ ...realWorld(), reads })

/**
 * The nearest traced repository at or above `path`, so a nested repository
 * that is not traced itself does not opt its files out.
 *
 * @param {string} path @param {Git} git @returns {string | null}
 */
export function tracedRoot(path, git) {
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
export function linkedIssue(root, branch, { git, github }) {
  if (branch && branch === git.defaultBranch(root)) {
    return { why: `this is the default branch (${branch}). Branch step: work on the issue's branch, \`gh issue develop <n> --checkout\` (Track first if there is no issue).` }
  }
  const n = branchIssue(branch)
  if (!n) {
    return { why: `the branch ${branch ?? '(detached HEAD)'} names no issue. Track step: open an issue (${TRACK_HINT}), then \`gh issue develop <n> --checkout\`.` }
  }
  const state = github.issueState(root, n)
  if (state === 'OPEN') return { n }
  if (state === null) {
    return { why: `GitHub could not say whether issue #${n} is open; check \`gh auth status\`, the network, and that origin is on GitHub. Track step: the work waits for an open issue; ${BYPASS_HINT}.` }
  }
  return { why: `#${n} is ${state === 'CLOSED' ? 'a closed issue' : 'not an open issue'}. Track step: open an issue for this change (${TRACK_HINT}) and work on its branch.` }
}

// --- the commit and PR gates -----------------------------------------------------

/**
 * One command of a Bash command line, with where it may run, whether a `cd`
 * the shell computes or a variable that moves git or gh came before, and
 * the commands before it on the same line.
 *
 * @typedef {{ c: SimpleCommand, at: string[], moved: boolean, earlier: SimpleCommand[] }} Run
 */

// Variables that point git or gh at another repository, configuration or alias set.
const MOVERS = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CONFIG\w*|GH_REPO|GH_HOST|GH_CONFIG_DIR|HOME|XDG_CONFIG_HOME)$/
const DECLARES = new Set(['export', 'declare', 'typeset', 'readonly'])

/**
 * Why a Bash command breaks the trace: a `git commit` whose message does not
 * reference the linked issue, or a `gh pr create` or `gh pr edit` whose body
 * does not close it. When the message, the body or the repository cannot be
 * told from the command text, it refuses rather than guess.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {World} [world]
 * @returns {string | null}
 */
export function commandVerdict(command, cwd, world = realWorld()) {
  if (world.env[BYPASS] === '1') return null
  /** @type {SimpleCommand[]} */
  const earlier = []
  let moved = false
  for (const { c, at, unknown } of withCwds(command, cwd)) {
    const sets = [...(c.env ?? []), ...(DECLARES.has(c.name) ? c.args.map(a => a.replace(/=.*/s, '')) : [])]
    const run = { c, at, moved: unknown || moved || sets.some(v => MOVERS.test(v)), earlier: [...earlier] }
    const why = c.name === 'git' ? commitVerdict(run, world) : c.name === 'gh' ? prVerdict(run, world) : computed(c.name) ? computedVerdict(run, world) : null
    if (why) return why
    // A bare assignment or a declaration lasts for the rest of the line.
    if (c.name === '' || DECLARES.has(c.name)) moved ||= sets.some(v => MOVERS.test(v))
    earlier.push(c)
  }
  return null
}

/**
 * The one traced repository among `dirs`, and the directory relative paths
 * resolve in when the candidates agree; null when that cannot be told.
 *
 * @param {(string | null)[]} dirs @param {boolean} moved @param {Git} git
 * @returns {{ root: string | null, dir: string | null } | null}
 */
function where(dirs, moved, git) {
  if (moved || dirs.includes(null)) return null
  const roots = [...new Set(dirs.map(d => tracedRoot(/** @type {string} */ (d), git)).filter(r => r !== null))]
  if (roots.length > 1) return null
  return { root: roots[0] ?? null, dir: new Set(dirs).size === 1 ? /** @type {string} */ (dirs[0]) : null }
}

/** @param {string} dir @param {string} to @returns {string | null} */
const resolveIn = (dir, to) => (computed(to) || to === '-' ? null : resolve(dir, untilde(to, dir)))

/** @param {string} what @param {string} fix @param {string} step */
const cannotTell = (what, fix, step) => `the trace cannot tell ${what}. ${step} step: ${fix}.`

/**
 * The verdict on a message or body: null when `accepts` finds the reference
 * in the text the shell leaves, or a refusal saying what to add.
 *
 * @param {string | null} text null when it cannot be told
 * @param {RegExp} accepts
 * @param {{ what: string, how: string, step: string, fix: string, refusal: string, hide?: (t: string) => string }} o
 */
function judge(text, accepts, { what, how, step, fix, refusal, hide = t => t }) {
  if (text === null) return cannotTell(`the ${what}`, `pass it with ${how}, and ${fix}`, step)
  const plain = dropExpansions(text)
  if (plain === null) return cannotTell(`the ${what}, which the shell computes`, `write it out, and ${fix}`, step)
  if (accepts.test(hide(unliteral(plain)))) return null
  if (plain !== text) return cannotTell(`the ${what}, which the shell computes`, `write it out, and ${fix}`, step)
  return `${refusal} ${step} step: ${fix}.`
}

/**
 * `text` with each shell expansion replaced by `0`, which can neither start
 * nor finish a reference: `Closes ${X}#7` may become `Closes other/repo#7`.
 * `$(cat <<EOF … EOF)` is its heredoc's text, and a `$` that starts no
 * expansion is kept. Null when an expansion is left that this cannot follow.
 *
 * @param {string} text @returns {string | null}
 */
function dropExpansions(text) {
  let t = text
    .replace(/\$\(\s*cat\s*<<-?[ \t]*(['"])([^'"\n]+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n\s*\)/g, (_, _q, _d, body) => literal(body))
    .replace(/\$\(\s*cat\s*<<-?[ \t]*([A-Za-z_]\w*)[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*\n\s*\)/g, (_, _d, body) => body)
  for (let before = ''; before !== t; ) {
    before = t
    t = t.replace(/\$\(\([^()]*(?:\([^()]*\)[^()]*)*\)\)|\$\[[^\]]*\]|\$\([^()]*\)|`[^`]*`|\$\{[^{}]*\}|\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])|\{[^{},\s]*\.\.[^{},\s]*\}/g, '0')
  }
  t = t.replace(/\$(?![A-Za-z_{(\[0-9@*#?$!'"-])/g, literal('$'))
  return /[$`]/.test(t) ? null : t
}

/** @param {string} s */
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What a commit message must hold to reference issue #n of `slug`: `#n` on
 * its own, or `slug#n`.
 *
 * @param {number} n @param {string | null} slug
 */
export const refersTo = (n, slug) => new RegExp(`(?:^|[^\\w&/])#${n}(?!\\d)${slug ? `|${escape(slug)}#${n}(?!\\d)` : ''}`, 'i')

/**
 * The text an option's value names: `-` for stdin, or a file. A file that a
 * command earlier on the line may write counts only when that command is
 * `cat > file <<EOF` chained before it, whose text is known.
 *
 * @param {string | undefined} v @param {Run} run @param {string | null} dir
 * @returns {string | null}
 */
function fileText(v, run, dir) {
  if (v === undefined || computed(v)) return null
  if (v === '-') return run.c.piped ? null : run.c.stdin ?? null
  const path = isAbsolute(untilde(v, '/')) ? untilde(v, '/') : dir === null ? null : resolve(dir, untilde(v, dir))
  if (path === null) return null
  const name = fold(basename(path))
  /** @type {string | undefined} */
  let written
  for (const [i, e] of run.earlier.entries()) {
    // A word the shell computes or globs may name this file; any other names it in some form.
    const words = PRINTS.has(e.name) ? e.files : [...e.args, ...e.files]
    if (words.some(w => /[$`*?[]/.test(w))) return null
    if (!words.some(w => new RegExp(`(?:^|[/=:])${escape(name)}$`).test(fold(w)))) continue
    // Only a `cat` that surely runs, and finishes, before this command writes known text.
    const chained = (/** @type {string | undefined} */ op) => op === '&&' || op === ';'
    const writes = e.name === 'cat' && !e.args.length && e.files.length === 1 && e.stdin !== undefined && !e.piped && chained(e.op) && (i === 0 || chained(run.earlier[i - 1]?.op)) && e.level === run.c.level
    if (!writes) return null
    written = e.stdin
  }
  if (written !== undefined) return written
  try {
    // A FIFO or a device would block the hook past its timeout.
    const st = statSync(path)
    return st.isFile() && st.size <= 1_000_000 ? literal(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

// Commands that write only to stdout, unless redirected.
const PRINTS = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'cd', 'pushd', 'popd', 'pwd'])

/**
 * A setting as git reads it: the last inline `-c`, else the repository's
 * configuration. Keys are case-insensitive.
 *
 * @param {string[]} config @param {string} key @param {string | null} root @param {Git} git
 */
const setting = (config, key, root, git) => {
  const kv = [...config].reverse().find(kv => kv.toLowerCase().startsWith(`${key.toLowerCase()}=`))
  return kv !== undefined ? kv.slice(key.length + 1) : root ? git.config(root, key) : null
}

/** @param {SimpleCommand} c @returns {boolean} whether `c` may set a git alias */
function definesGitAlias(c) {
  if (c.name !== 'git') return false
  const { sub, rest } = gitParts(c.args)
  if (sub !== 'config') return false
  const words = rest[0] === 'set' ? rest.slice(1) : rest
  if (words.some(w => /^(?:--get(?:-all|-regexp)?|--list|-l|--unset(?:-all)?|get|list)$/.test(w))) return false
  return words.some(w => /^(?:alias\.|--file|-f$|--edit|-e$)/i.test(w) || computed(w))
}

// Git commands other than commit that make or move commits; the related docs
// must be read before them as before a commit. Stopping one, skipping a step
// or asking for help makes nothing new.
const COMMIT_MAKERS = new Set(['commit-tree', 'update-ref', 'merge', 'cherry-pick', 'revert', 'am', 'rebase', 'pull'])
const MAKES_NOTHING = /^(?:--abort|--quit|--skip|--show-current-patch|--help|-h)$/

/** @param {string} root @param {World} world @returns {string | null} */
function makerVerdict(root, world) {
  const n = world.git.branch(root) === world.git.defaultBranch(root) ? null : branchIssue(world.git.branch(root))
  return n && world.github.issueState(root, n) === 'OPEN' ? readVerdict(root, n, null, world) : null
}

/** @param {Run} run @param {World} world */
function commitVerdict(run, world) {
  let parts = gitParts(run.c.args)
  const dirs = run.at.map(d => parts.dirs.reduce((/** @type {string | null} */ x, y) => x && resolveIn(x, y), d))
  const place = where(dirs, run.moved || parts.relocated, world.git)
  const lookIn = place && (place.root ?? place.dir)
  let config = parts.config
  // Follow aliases, which may name other aliases; one defined earlier on the line is not known yet.
  const defines = run.earlier.some(definesGitAlias)
  const fix = (/** @type {number} */ n) => `run \`git commit\` directly, with "#${n}" in its message`
  for (const seen = new Set(); parts.sub && !GIT_COMMANDS.has(parts.sub); ) {
    const name = parts.sub
    // git refuses an alias loop; refusing here too says why.
    const loops = seen.has(name.toLowerCase())
    const alias = defines || loops ? null : setting(config, `alias.${name}`, lookIn, world.git)
    if (alias === null && !defines && !loops && lookIn) return null
    if (alias === null || alias.startsWith('!') || computed(alias)) return opaqueVerdict(`what \`git ${name}\` runs`, place, world, fix, 'Implement')
    seen.add(name.toLowerCase())
    const expanded = gitParts(parseCommands(`git ${alias}`)[0]?.args ?? [])
    config = [...config, ...expanded.config]
    parts = { ...expanded, rest: [...expanded.rest, ...parts.rest] }
  }
  if (parts.sub && COMMIT_MAKERS.has(parts.sub)) return place?.root && !(parts.rest.length === 1 && MAKES_NOTHING.test(parts.rest[0] ?? '')) ? makerVerdict(place.root, world) : null
  if (parts.sub !== 'commit') return null
  if (!place) return cannotTell('which repository this commit lands in', 'run `git commit` from the repository, or with `git -C <dir>`', 'Implement')
  if (!place.root) return null
  const linked = linkedIssue(place.root, world.git.branch(place.root), world)
  if ('why' in linked) return linked.why
  const { opts, unknown: unknownOption } = readOptions(parts.rest, GIT_COMMIT_OPTIONS, { abbrev: true })
  if (opts.some(([name]) => name === 'dry-run')) return null
  const { n } = linked
  // What a commit takes cannot be told from its text, so every active ADR counts.
  const unread = readVerdict(place.root, n, null, world)
  if (unread) return unread
  const slug = world.git.origin(place.root)
  return judge(unknownOption ? null : commitMessage(opts, run, { root: place.root, dir: place.dir }, config, world.git), refersTo(n, slug), {
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
 * @param {Run} run @param {{ root: string, dir: string | null }} place
 * @param {string[]} config inline `-c` settings
 * @param {Git} git
 * @returns {string | null}
 */
function commitMessage(opts, run, { root, dir }, config, git) {
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
  // Without an editor only strip cleanup drops comment lines; git reads scissors as whitespace.
  const mode = last.cleanup ?? setting(config, 'commit.cleanup', root, git)
  if (mode && computed(mode)) return null
  const text = texts.join('\n\n')
  if (mode !== 'strip') return text
  const cc = setting(config, 'core.commentString', root, git) ?? setting(config, 'core.commentChar', root, git) ?? '#'
  if (cc === 'auto' || cc === '' || computed(cc)) return null
  return text
    .split('\n')
    .filter(l => !l.startsWith(cc))
    .join('\n')
}

// gh pr create's and gh pr edit's options, from their --help, with the inherited -R.
/** @param {[string, string][]} valued @param {[string, string][]} flags @returns {import('./shell.mjs').OptionTable} */
const ghTable = (valued, flags) => ({
  ...Object.fromEntries(valued.map(([l, s]) => [l, { ...(s ? { short: s } : {}), value: /** @type {const} */ ('required') }])),
  ...Object.fromEntries(flags.map(([l, s]) => [l, s ? { short: s } : {}])),
})
/** @type {[string, string][]} */
const GH_SHARED = [['body', 'b'], ['body-file', 'F'], ['base', 'B'], ['milestone', 'm'], ['title', 't'], ['repo', 'R']]
const GH_PR_CREATE = ghTable(
  [...GH_SHARED, ['assignee', 'a'], ['head', 'H'], ['label', 'l'], ['project', 'p'], ['reviewer', 'r'], ['template', 'T'], ['attach', ''], ['recover', '']],
  [['draft', 'd'], ['editor', 'e'], ['fill', 'f'], ['web', 'w'], ['dry-run', ''], ['fill-first', ''], ['fill-verbose', ''], ['no-maintainer-edit', ''], ['help', 'h']],
)
const GH_PR_EDIT = ghTable(
  [...GH_SHARED, ...['assignee', 'label', 'project', 'reviewer'].flatMap(o => /** @type {[string, string][]} */ ([[`add-${o}`, ''], [`remove-${o}`, '']]))],
  [['remove-milestone', ''], ['help', 'h']],
)

// Options that leave the PR body to gh, an editor or a browser.
const BODY_ELSEWHERE = new Set(['fill', 'fill-first', 'fill-verbose', 'web', 'editor', 'template', 'recover'])

/** @param {string | undefined} v a boolean option's value, as gh's parser reads it */
const isOn = v => v === undefined || /^(?:1|t|true)$/i.test(v)

/** @param {Run} run @param {World} world */
function prVerdict(run, world) {
  let args = run.c.args
  const place = where(run.at, run.moved, world.git)
  const read = (/** @type {string[]} */ a) => readOptions(a, a.includes('edit') ? GH_PR_EDIT : GH_PR_CREATE, { pflag: true })
  let { opts, operands, unknown: unknownOption } = read(args)
  const fix = (/** @type {number} */ n) => `run \`gh pr create\` directly, with "Closes #${n}" in its body`
  if (operands.slice(0, 2).some(o => /[$`*?[]/.test(o))) return opaqueVerdict('which gh command this is', place, world, fix, 'Review')
  const first = operands[0]
  // gh aliases may be two words, even after one of gh's own; one set earlier on the line is not known yet.
  const two = operands.length > 1 ? `${first} ${operands[1]}` : null
  const name = two !== null && world.github.alias(two) !== null ? two : first !== undefined && !GH_COMMANDS.has(first) ? first : null
  if (name !== null) {
    const alias = world.github.alias(name)
    if (alias === null && !run.earlier.some(e => e.name === 'gh' && e.args[0] === 'alias' && (e.args[1] === 'set' || e.args[1] === 'import'))) return null
    if (alias === null || alias.startsWith('!') || alias.includes('$')) return opaqueVerdict(`what \`gh ${name}\` runs`, place, world, fix, 'Review')
    const at = args.indexOf(first)
    args = [...args.slice(0, at), ...(parseCommands(`gh ${alias}`)[0]?.args ?? []), ...args.slice(at + name.split(' ').length)]
    ;({ opts, operands, unknown: unknownOption } = read(args))
  }
  // An option this does not know may take the next word as its value, so the
  // subcommand is only certain when it is one of gh pr's own.
  const sub = operands[0] === 'pr' ? operands[1] : undefined
  if (sub !== undefined && GH_PR_COMMANDS.has(sub)) return null
  const loose = unknownOption !== null && args.includes('pr')
  if (!(sub === 'create' || sub === 'new' || sub === 'edit' || (loose && args.some(a => a === 'create' || a === 'new' || a === 'edit')))) return null
  /** @type {Record<string, string | undefined>} */
  const last = Object.fromEntries(opts)
  if ('help' in last && isOn(last.help)) return null
  const edits = sub === 'edit'
  if (edits && !unknownOption && !('body' in last) && !('body-file' in last)) return null
  if (!place) return cannotTell('which repository this PR is in', 'run gh from the repository', 'Review')
  if (!place.root) return null
  if (!edits && 'dry-run' in last && isOn(last['dry-run'])) return null
  const head = last.head?.replace(/^[^:]*:/, '') ?? world.git.branch(place.root)
  const linked = linkedIssue(place.root, head, world)
  if ('why' in linked) return linked.why
  const { n } = linked
  const slug = world.git.origin(place.root)
  const closes = `put "Closes #${n}" in the PR body`
  if (edits && operands.length > 2) return cannotTell(`which issue the PR ${operands[2]} closes`, `edit the body from the PR's own branch, without naming it, and ${closes}`, 'Review')
  // gh opens the PR in -R's repository, else in the one it resolves from the remotes.
  const repo = last.repo === undefined ? world.git.ghBase(place.root) : /^(?:github\.com\/)?([^/]+\/[^/]+)$/i.exec(last.repo)?.[1] ?? null
  if (repo?.toLowerCase() !== slug?.toLowerCase()) {
    return cannotTell(`which issue #${n} is in ${repo ?? last.repo ?? "gh's chosen repository"}`, `pass \`-R ${slug ?? '<origin>'}\`, and ${closes}`, 'Review')
  }
  const elsewhere = opts.some(([name, v]) => BODY_ELSEWHERE.has(name) && (GH_PR_CREATE[name]?.value || isOn(v)))
  const bodyFile = [...opts].reverse().find(([name]) => name === 'body-file')
  // --body-file replaces --body, whatever their order.
  const text = unknownOption || elsewhere ? null : bodyFile ? fileText(bodyFile[1], run, place.dir) : last.body ?? null
  const ref = `(?:#${n}${slug ? `|${escape(slug)}#${n}|https://github\\.com/${escape(slug)}/issues/${n}` : ''})(?![\\w/])`
  return judge(text, new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+${ref}`, 'i'), {
    what: 'PR body',
    how: '--body or a heredoc to --body-file -',
    step: 'Review',
    fix: closes,
    refusal: `this PR body does not close #${n}, the linked issue.`,
    hide: dropMarkdownCode,
  })
}

/** @param {string} text @returns {string} `text` without what GitHub does not read as links: code and comments */
const dropMarkdownCode = text =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/(^|\n[ \t]*\n)((?: {4}|\t)[^\n]*(?:\n|$))+/g, '$1')

/**
 * A command the trace cannot follow (a shell alias, a computed word) that
 * may commit or open a PR: refused wherever it may run in a traced
 * repository, naming the linked issue when there is one.
 *
 * @param {string} what @param {ReturnType<typeof where>} place @param {World} world
 * @param {(n: number) => string} fix @param {string} step
 */
function opaqueVerdict(what, place, world, fix, step) {
  if (place && !place.root) return null
  const linked = place?.root ? linkedIssue(place.root, world.git.branch(place.root), world) : null
  if (linked && 'why' in linked) return linked.why
  return cannotTell(what, linked ? fix(linked.n) : 'run git or gh directly, from the repository', step)
}

/**
 * A command word the shell computes (`$(echo git) commit`) that may commit
 * or open a PR.
 *
 * @param {Run} run @param {World} world
 */
function computedVerdict(run, world) {
  const a = run.c.args
  const commits = a.includes('commit')
  if (!commits && !(a.includes('pr') && a.some(w => w === 'create' || w === 'new' || w === 'edit'))) return null
  const fix = commits ? (/** @type {number} */ n) => `name git directly, with "#${n}" in the message` : (/** @type {number} */ n) => `name gh directly, with "Closes #${n}" in the body`
  return opaqueVerdict(`which command \`${run.c.name}\` is`, where(run.at, run.moved, world.git), world, fix, commits ? 'Implement' : 'Review')
}

// git's own subcommands: a word outside this set may be an alias.
const GIT_COMMANDS = new Set(
  'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch for-each-ref format-patch fsck gc grep gui hash-object help hook init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-tree mergetool mktag mktree mv name-rev notes pack-objects pack-refs prune prune-packed pull push range-diff read-tree rebase reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email shortlog show show-branch show-ref sparse-checkout stage stash status submodule switch symbolic-ref tag unpack-objects update-index update-ref upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree'.split(' '),
)

// gh pr's subcommands that never create a PR or change its body.
const GH_PR_COMMANDS = new Set('checkout checks close comment diff list lock merge ready reopen revert review status unlock update-branch view'.split(' '))

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
 * What `path` is to the switches: a file of an installed plugin, one of
 * Claude Code's settings files, or neither.
 *
 * @param {string} path an absolute path
 * @returns {'plugin' | 'settings' | null}
 */
export function switchKind(path) {
  const folded = fold(real(path))
  if (configDirs().some(d => folded === `${d}/plugins` || folded.startsWith(`${d}/plugins/`))) return 'plugin'
  return isSettings(folded) ? 'settings' : null
}

/**
 * Whether `path` is a directory that holds the switches: a `.claude`
 * directory, Claude Code's config directory, or a directory above it.
 *
 * @param {string} path an absolute path
 */
export function holdsSwitches(path) {
  const folded = fold(real(path))
  return basename(folded) === '.claude' || configDirs().some(d => d === folded || d.startsWith(folded.endsWith('/') ? folded : `${folded}/`))
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
  const kind = switchKind(path)
  if (kind === 'plugin') return `this is an installed plugin; ${why}`
  if (!kind) return null
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

/** @param {string} url @returns {string | null} the GitHub repository a remote URL names, as `owner/name` */
const slugOf = url => /(?:^|[@/])github\.com(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1] ?? null

/** @typedef {{ state?: string, pull_request?: unknown, title?: string, body?: string | null, comments?: number }} IssueJson */

// A hook that times out lets the edit through, so the git and GitHub calls of
// one hook call share one deadline well inside the hook's timeout, and running
// out throws. Each call makes its own world, and with it its own deadline and
// its own answers from git and GitHub: none outlives the call.

/** @returns {World} a fresh real world, its deadline starting now */
function realWorld() {
  const deadline = Date.now() + 20_000
  const timeLeft = () => {
    const ms = deadline - Date.now()
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
  /** @type {Map<string, string | null>} */
  const origins = new Map()

  /** @type {Git} */
  const realGit = {
    origin(root) {
      if (!origins.has(root)) origins.set(root, slugOf(git(root, ['remote', 'get-url', 'origin']) ?? ''))
      return origins.get(root) ?? null
    },
    // As gh resolves it: a remote marked by `gh repo set-default`, else the
    // first GitHub remote of upstream, github, origin and the rest.
    ghBase(root) {
      const lines = (git(root, ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']) ?? '').split('\n')
      /** @type {Map<string, { slug: string | null, resolved?: string }>} */
      const remotes = new Map()
      for (const line of lines) {
        const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/i.exec(line)
        if (!m) continue
        const [, name = '', key = '', value = ''] = m
        const r = remotes.get(name) ?? { slug: null }
        if (key.toLowerCase() === 'url') r.slug = slugOf(value)
        else r.resolved = value
        remotes.set(name, r)
      }
      for (const r of remotes.values()) if (r.resolved) return r.resolved === 'base' ? r.slug : r.resolved
      const rank = (/** @type {string} */ name) => ['upstream', 'github', 'origin'].indexOf(name) >>> 0
      return [...remotes].filter(([, r]) => r.slug).sort(([a], [b]) => rank(a) - rank(b))[0]?.[1].slug ?? null
    },
    message: (root, rev) => git(root, ['log', '-1', '--format=%B', rev, '--']),
    committed(root, n) {
      const def = this.defaultBranch(root)
      const base = def ? ['--ignore-missing', '--not', `refs/heads/${def}`, `refs/remotes/origin/${def}`] : []
      const refers = refersTo(n, this.origin(root))
      return (git(root, ['log', '-z', '--format=%B', 'HEAD', ...base, '--']) ?? '').split('\0').some(m => refers.test(m))
    },
    // Where the branch is pushed: its push destination, else its upstream,
    // else origin's branch of its name. Null unless that holds commits no other
    // branch of the remote has. Its time is when the ref last moved here (the
    // reflog), else the commit's date.
    pushed(root, branch) {
      const full = (/** @type {string} */ rev) => git(root, ['rev-parse', '--symbolic-full-name', rev])
      const ref = [full(`${branch}@{push}`), full(`${branch}@{upstream}`)].find(r => r?.startsWith('refs/remotes/')) ?? `refs/remotes/origin/${branch}`
      const [, remote = '', name = ''] = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref) ?? []
      const [sha, committed] = (git(root, ['log', '-1', '--format=%H %cI', ref, '--']) ?? '').split(' ')
      if (!sha || !committed || !git(root, ['rev-list', '-1', ref, '--not', `--exclude=${remote}/${name}`, `--remotes=${remote}`])) return null
      const moved = /@\{(.+)\}$/.exec(git(root, ['reflog', 'show', '-1', '--format=%gd', '--date=iso-strict', ref, '--']) ?? '')?.[1]
      return { sha, at: moved && !Number.isNaN(Date.parse(moved)) ? moved : committed }
    },
    config: (root, key) => git(root, ['config', '--get', key]),
    headDocs(root) {
      const names = git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'GLOSSARY.md', 'docs/adr'])
      if (names === null) return null
      const list = names.split('\0').filter(isDocName)
      const r = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input: list.map(p => `HEAD:${p}\n`).join(''), timeout: Math.min(3000, timeLeft()), maxBuffer: 64 << 20 })
      if (r.error) throw r.error
      if (r.status !== 0) return null
      /** @type {Record<string, string>} */
      const docs = {}
      let at = 0
      for (const name of list) {
        const end = r.stdout.indexOf(10, at)
        const size = Number(/ blob (\d+)$/.exec(r.stdout.subarray(at, end).toString())?.[1])
        if (Number.isNaN(size)) return null
        const text = decode(r.stdout.subarray(end + 1, end + 1 + size))
        if (text !== null) docs[name] = text
        at = end + 1 + size + 1
      }
      return docs
    },
    root(path) {
      for (let d = path; ; d = dirname(d)) {
        if (existsSync(join(d, '.git'))) return d
        if (dirname(d) === d) return null
      }
    },
    // Deleting the marker from the working tree, or committing its deletion on a
    // branch, does not opt out: it also counts while HEAD or the default branch has it.
    // Only git saying no makes a repository untraced: when git does not answer
    // (a timeout, the deadline run out, or no git to run), this throws, and
    // the gates refuse rather than let an untraced edit, commit or PR through.
    traced(root) {
      if (existsSync(join(root, MARKER))) return true
      const def = this.defaultBranch(root)
      return ['HEAD', ...(def ? [`origin/${def}`, def] : [])].some(rev => git(root, ['cat-file', '-e', `${rev}:${MARKER}`]) !== null)
    },
    // While a rebase stops, HEAD is detached; the branch is the one being rebased.
    branch(root) {
      const branch = git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
      if (branch) return branch
      for (const dir of ['rebase-merge', 'rebase-apply']) {
        const at = git(root, ['rev-parse', '--git-path', `${dir}/head-name`])
        try {
          const name = at && readFileSync(resolve(root, at), 'utf8').trim()
          if (name) return name.replace(/^refs\/heads\//, '')
        } catch {}
      }
      return null
    },
    defaultBranch(root) {
      if (!defaults.has(root)) {
        const remote = git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
        const local = () => ['main', 'master'].find(b => git(root, ['show-ref', '--verify', '-q', `refs/heads/${b}`]) !== null) ?? null
        defaults.set(root, remote ? remote.replace(/^origin\//, '') : local())
      }
      return defaults.get(root) ?? null
    },
  }

  /** @type {string | undefined} `gh alias list`, asked once */
  let ghAliases

  /** @type {GitHub} */
  const realGitHub = {
    alias(name) {
      if (ghAliases === undefined) {
        const r = spawnSync('gh', ['alias', 'list'], { encoding: 'utf8', timeout: Math.min(5000, timeLeft()) })
        // An alias that cannot be looked up may be anything.
        if (r.error) throw r.error
        if (r.status !== 0 && !/no aliases/i.test(r.stderr ?? '')) throw new Error(`gh alias list failed: ${(r.stderr ?? '').trim()}`)
        ghAliases = r.stdout ?? ''
      }
      const line = ghAliases.split('\n').find(l => l.startsWith(`${name}:`))
      return line ? line.slice(name.length + 1).trim().replace(/^'(.*)'$/s, '$1') : null
    },
    issueState(root, n) {
      const issue = issueJson(root, n)
      if (issue === 'MISSING' || issue === null) return issue
      if (issue.pull_request) return 'MISSING'
      return issue.state === 'open' ? 'OPEN' : 'CLOSED'
    },
    issue(root, n) {
      const issue = issueJson(root, n)
      if (issue === 'MISSING' || issue === null) return null
      const r = issue.comments === 0 ? null : gh(root, ['api', '--paginate', `repos/${realGit.origin(root)}/issues/${n}/comments`, '--jq', '.[] | {id: (.id | tostring), author: .user.login, body, at: .created_at}'])
      if (r && r.status !== 0) return null
      const comments = r ? r.stdout : ''
      try {
        const parsed = comments.split('\n').filter(Boolean).map(l => JSON.parse(l))
        return { title: String(issue.title ?? ''), body: String(issue.body ?? ''), comments: parsed.map(c => ({ id: String(c.id), author: String(c.author), body: String(c.body ?? ''), at: String(c.at ?? '') })) }
      } catch {
        return null
      }
    },
    pr(root, branch) {
      const slug = realGit.origin(root)
      if (!slug) return null
      const r = gh(root, ['pr', 'view', branch, '-R', slug, '--json', 'number,url,state,statusCheckRollup'])
      if (r.status !== 0) return /no pull requests found/i.test(r.stderr ?? '') ? 'NONE' : null
      try {
        const pr = JSON.parse(r.stdout)
        if (!Number.isInteger(pr.number) || typeof pr.url !== 'string') return null
        /** @type {{ name?: string, context?: string, workflowName?: string, status?: string, conclusion?: string, state?: string, startedAt?: string }[]} */
        const rollup = pr.statusCheckRollup ?? []
        // A re-run is listed beside the run it replaces; the latest counts.
        const started = (/** @type {{ startedAt?: string }} */ c) => Date.parse(c.startedAt ?? '') || 0
        /** @type {Map<string, typeof rollup[number]>} */
        const latest = new Map()
        for (const c of rollup) {
          const key = `${c.workflowName ?? ''}\0${c.name ?? c.context ?? ''}`
          const seen = latest.get(key)
          if (!seen || started(c) >= started(seen)) latest.set(key, c)
        }
        const checks = [...latest.values()].map(c => ({ name: String(c.name ?? c.context ?? ''), state: c.status && c.status !== 'COMPLETED' ? 'PENDING' : String(c.conclusion || c.state || 'PENDING') }))
        return { n: Number(pr.number), url: String(pr.url), state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : 'OPEN', checks }
      } catch {
        return null
      }
    },
  }

  /** @param {string} root @param {string[]} args */
  const gh = (root, args) => spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: Math.min(10_000, timeLeft()), maxBuffer: 64 << 20 })

  /** @type {Map<string, IssueJson | 'MISSING' | null>} */
  const issues = new Map()

  /**
   * An issue as GitHub's API gives it, asked once per hook run: 'MISSING', or
   * null when GitHub cannot be asked. It asks about origin's repository by name:
   * gh's own choice prefers a remote called upstream, which on a fork is
   * someone else's issues.
   *
   * @param {string} root @param {number} n
   * @returns {IssueJson | 'MISSING' | null}
   */
  function issueJson(root, n) {
    const key = `${root}#${n}`
    if (!issues.has(key)) {
      const slug = realGit.origin(root)
      const r = slug ? gh(root, ['api', `repos/${slug}/issues/${n}`]) : null
      /** @type {IssueJson | 'MISSING' | null} */
      let issue = null
      if (r && r.status !== 0) issue = /HTTP (404|410)/.test(r.stderr ?? '') ? 'MISSING' : null
      else if (r) {
        try {
          issue = JSON.parse(r.stdout)
        } catch {}
      }
      issues.set(key, issue)
    }
    return issues.get(key) ?? null
  }

  return { git: realGit, github: realGitHub, env: process.env, reads: { records: () => null, add() {}, clear() {} }, once, timeLeft }
}
