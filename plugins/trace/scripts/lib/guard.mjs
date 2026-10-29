// The guard: the hard block on commands that destroy work or history, or
// that write the settings and plugins that switch the hooks off.
//
// It reads command text, so it is a seatbelt, not a sandbox: aliases,
// functions and scripts can get past it.

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { untilde } from './paths.mjs'
import { GIT_COMMIT_OPTIONS, INTERPRETERS, beforeDashDash, gitParts, operands, readOptions, shortFlags, withCwds } from './shell.mjs'
import { holdsSwitches, switchKind } from './trace.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

/**
 * The values `opts` gives the long option `f`, or a prefix of it git takes
 * as that option (three letters or more); `true` for one without a value.
 *
 * @param {string[]} opts @param {string} f @returns {(string | true)[]}
 */
function longValues(opts, f) {
  return opts.flatMap(x => {
    const eq = x.indexOf('=')
    const name = eq < 0 ? x : x.slice(0, eq)
    return name === f || (name.length >= 5 && f.startsWith(name)) ? [eq < 0 ? true : x.slice(eq + 1)] : []
  })
}

// Settings under which git gc drops unreachable commits, or their reflog, at once.
const PRUNES_NOW = /^gc\.(?:pruneexpire|reflogexpire|reflogexpireunreachable)=(?:now|all|0)$/i

/** @param {string[]} args */
function gitDestructive(args) {
  const { config, sub, rest, opts } = gitParts(args)
  const long = (/** @type {string} */ f) => longValues(opts, f).length > 0

  if (['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert'].includes(sub ?? '')) {
    if (long('--no-verify') || (sub === 'commit' && readOptions(rest, GIT_COMMIT_OPTIONS, { abbrev: true }).opts.some(([name]) => name === 'no-verify'))) return '--no-verify (or commit -n) skips the repository checks'
    if (config.some(c => /^core\.hookspath\b/i.test(c))) return 'overriding core.hooksPath skips the repository checks'
  }
  switch (sub) {
    case 'reset':
      if (long('--hard')) return 'git reset --hard discards uncommitted work'
      break
    case 'clean': {
      const s = shortFlags(opts, 'e')
      if ((s.has('f') || long('--force')) && !(s.has('n') || long('--dry-run'))) return 'git clean -f deletes untracked files'
      break
    }
    case 'checkout': {
      const s = shortFlags(opts, 'bB')
      if (s.has('f') || long('--force')) return 'git checkout -f discards working-tree changes'
      const dd = rest.indexOf('--')
      if (dd >= 0 && dd < rest.length - 1) return 'git checkout [<ref>] -- <path> discards working-tree changes'
      const ops = operands(opts, 'bB', ['--orphan'])
      if (ops.includes('.')) return 'git checkout . discards working-tree changes'
      const creates = s.has('b') || s.has('B') || long('--orphan')
      if (!creates && ops.length >= 2) return 'git checkout <ref> <path> overwrites working-tree files'
      break
    }
    case 'switch': {
      const s = shortFlags(opts, 'cC')
      if (s.has('f') || long('--force') || long('--discard-changes')) return 'git switch --discard-changes discards working-tree changes'
      break
    }
    case 'restore': {
      // It only unstages with --staged and without --worktree.
      const s = shortFlags(opts, 's')
      const staged = s.has('S') || long('--staged')
      const worktree = s.has('W') || long('--worktree')
      if (!staged || worktree) return 'git restore discards working-tree changes'
      break
    }
    case 'push': {
      const s = shortFlags(opts, 'o')
      if (s.has('f') || long('--force') || long('--force-with-lease') || long('--force-if-includes')) return 'force push rewrites shared history'
      const refspecs = operands(rest, 'o', ['--push-option', '--repo', '--receive-pack', '--exec'])
      if (refspecs.some(x => x.startsWith('+'))) return 'a +refspec force-pushes'
      if (s.has('n') || long('--dry-run')) break
      if (s.has('d') || long('--delete') || refspecs.slice(1).some(x => /^:./.test(x))) return 'deleting a remote branch loses its commits for everyone'
      if (long('--mirror')) return 'git push --mirror overwrites and deletes the remote\'s refs'
      if (long('--prune')) return 'git push --prune deletes remote branches'
      break
    }
    case 'reflog':
      if ((rest[0] === 'expire' || rest[0] === 'delete') && !(shortFlags(opts).has('n') || long('--dry-run'))) return `git reflog ${rest[0]} drops what recovers lost commits`
      break
    case 'gc': {
      const now = longValues(opts, '--prune').find(v => v !== true && /^(?:now|all|0)$/i.test(v))
      if (now) return `git gc --prune=${now} deletes unreachable commits at once`
      const set = config.find(c => PRUNES_NOW.test(c))
      if (set) return `git gc under ${set} deletes unreachable commits at once`
      break
    }
    case 'prune':
      if (!(shortFlags(opts).has('n') || long('--dry-run'))) return 'git prune deletes unreachable commits'
      break
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') return 'dropping a stash loses work'
      break
    case 'branch': {
      const s = shortFlags(opts)
      if (s.has('D') || ((s.has('d') || long('--delete')) && (s.has('f') || long('--force')))) return 'git branch -D deletes unmerged work'
      break
    }
  }
  return null
}

/**
 * @param {SimpleCommand} c
 * @returns {string | null} why the command is destructive
 */
function destructive(c) {
  if (c.name === 'git') return gitDestructive(c.args)
  if (c.name === 'rm') {
    const opts = beforeDashDash(c.args)
    const s = shortFlags(opts)
    if (s.has('r') || s.has('R') || opts.includes('--recursive')) return 'rm -r deletes whole directory trees'
  }
  if (c.name === 'find' && c.args.includes('-delete')) return 'find -delete deletes every file it matches'
  if (c.name === 'rsync' && !(shortFlags(c.args, RSYNC_VALUES).has('n') || c.args.includes('--dry-run'))) {
    if (c.args.includes('--remove-source-files')) return 'rsync --remove-source-files deletes the source files'
    if (c.args.some(a => /^--(?:del|delete(?:-\w+)*)$/.test(a))) return 'rsync --delete deletes files the source does not have'
  }
  return null
}

// --- the switches ---------------------------------------------------------------------

const RSYNC_VALUES = 'efTBM'
// Commands that write the files they name: all their operands, or only the last (the destination).
const WRITE_ALL = { tee: '', rm: '', unlink: '', truncate: 'sr', shred: 'nsu', sponge: '' }
const WRITE_LAST = { cp: 'tS', install: 'tgmoS', ln: 'tS', rsync: RSYNC_VALUES, scp: 'cFiJloPS' }
const IN_PLACE = { sed: 'ef', gsed: 'ef', perl: 'eEIMm', ruby: 'eIr' }
// Downloaders: the option that names the file they write.
const DOWNLOADS = { curl: ['o', '--output'], wget: ['O', '--output-document'] }
const NAMES_SWITCH = /\.claude\/(?:settings(?:\.local)?\.json|plugins)\b|managed-settings\.json\b/
// `claude` subcommands that change installed plugins or settings.
const CLAUDE_WRITES = /^(?:plugins? (?:install|i|uninstall|remove|rm|enable|disable|update|marketplace (?:add|remove|rm|update))|config (?:set|add|remove|rm))\b/
// scp and rsync paths on another host.
const REMOTE = /^(?:rsync:\/\/|(?:[^/:@\s]+@)?[^/:\s]+::?)/

/**
 * What a copy or move takes and writes: its sources, its destination
 * (unless `-t` names a directory), and the paths it writes there.
 *
 * @param {string[]} args @param {string} letters its short options that take a value
 */
function copyParts(args, letters) {
  const ops = operands(args, letters, ['--target-directory'])
  const t = args.findIndex(a => a === '-t' || a === '--target-directory')
  const dir = args.find(a => a.startsWith('--target-directory='))?.slice('--target-directory='.length) ?? (t >= 0 ? args[t + 1] : undefined)
  if (dir !== undefined) return { sources: ops, dest: undefined, written: ops.map(s => join(dir, basename(s))) }
  const dest = ops.at(-1)
  const sources = ops.slice(0, -1)
  return { sources, dest, written: dest === undefined ? [] : [dest, ...sources.map(s => join(dest, basename(s)))] }
}

/**
 * The values of a short option `letter`, alone or last in a cluster, or of
 * the long option `long`.
 *
 * @param {string[]} args @param {string} letter @param {string} long
 */
function valuesOf(args, letter, long) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i])
    if (a === long) out.push(args[++i] ?? '')
    else if (a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1))
    else if (/^-[a-zA-Z]/.test(a)) {
      const k = a.indexOf(letter)
      if (k > 0) out.push(k === a.length - 1 ? (args[++i] ?? '') : a.slice(k + 1))
    }
  }
  return out
}

/**
 * A move's parts, for `mv` and `git mv`, with `git -C` applied; else null.
 *
 * @param {SimpleCommand} c
 */
function moveParts(c) {
  if (c.name === 'mv') return copyParts(c.args, 'tS')
  if (c.name !== 'git') return null
  const { sub, rest, dirs } = gitParts(c.args)
  if (sub !== 'mv') return null
  const base = dirs.reduce((b, d) => (isAbsolute(d) ? d : join(b, d)), '.')
  /** @param {string} p */
  const at = p => (isAbsolute(p) || p.startsWith('~') ? p : join(base, p))
  const p = copyParts(rest, '')
  return { sources: p.sources.map(at), dest: p.dest === undefined ? undefined : at(p.dest), written: p.written.map(at) }
}

/**
 * The files a command writes, as it names them.
 *
 * @param {SimpleCommand} c
 * @returns {string[]}
 */
function writeTargets(c) {
  const { name, args } = c
  /** @type {Record<string, string>} */ const all = WRITE_ALL
  /** @type {Record<string, string>} */ const last = WRITE_LAST
  /** @type {Record<string, string>} */ const inPlace = IN_PLACE
  /** @type {Record<string, string[]>} */ const downloads = DOWNLOADS
  const moved = moveParts(c)
  if (moved) return [...moved.sources, ...moved.written]
  if (name in all) return operands(args, all[name])
  if (name in inPlace && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return operands(args, inPlace[name])
  if (name === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
  if (name in downloads) {
    const [letter = '', long = ''] = downloads[name] ?? []
    return valuesOf(args, letter, long).filter(t => t !== '-')
  }
  if (name === 'git') {
    const { sub, rest, dirs, long } = gitParts(args)
    const base = dirs.reduce((b, d) => (isAbsolute(d) ? d : join(b, d)), '.')
    if (sub === 'rm' && !long('--cached')) return operands(rest).map(p => (isAbsolute(p) || p.startsWith('~') ? p : join(base, p)))
    return []
  }
  if (!(name in last)) return []
  return copyParts(args, last[name]).written.filter(t => !REMOTE.test(t))
}

/**
 * `target` as a path from `cwd`, with `~`, `$HOME` and `$CLAUDE_CONFIG_DIR` expanded.
 *
 * @param {string} cwd @param {string} target
 */
function pathAt(cwd, target) {
  const expanded = target
    .replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, homedir())
    .replace(/^(?:\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\})(?=\/|$)/, m => process.env.CLAUDE_CONFIG_DIR || m)
  return resolve(cwd, untilde(expanded, cwd))
}

/**
 * Whether interpreter code names Claude Code's settings or plugins.
 *
 * @param {string} code @param {string[]} cwds
 */
function namesSwitch(code, cwds) {
  if (NAMES_SWITCH.test(code)) return true
  return code.split(/[\s'"`(),;=]+/).some(w => /settings|plugins/.test(w) && cwds.some(d => switchKind(pathAt(d, w))))
}

/**
 * Why a command would write Claude Code's settings or an installed plugin,
 * which can switch the hooks off, or null.
 *
 * @param {SimpleCommand} c
 * @param {string[]} cwds the directories it may run in
 * @param {SimpleCommand | undefined} from the command piping into it
 */
function switchWrite(c, cwds, from) {
  const fix = 'only the human changes it, by hand; a settings change other than env, disableAllHooks, enabledPlugins or hooks can be made with the Edit tool'
  const who = c.name ? `\`${c.name}\`` : 'a redirection'
  if (c.name === 'claude') {
    // Past the global options, to the subcommand.
    const k = c.args.findIndex(a => /^(?:plugins?|config)$/.test(a))
    if (k >= 0 && CLAUDE_WRITES.test(c.args.slice(k).join(' '))) return `\`claude ${c.args.slice(k, k + 2).join(' ')}\` changes Claude Code's plugins or settings, which can switch the hooks off; ${fix}`
  }
  const moved = moveParts(c)
  if (moved) {
    // Moving a directory that holds them moves them all; so does moving a file into its place.
    for (const d of cwds) {
      const into = moved.dest === undefined ? [] : [pathAt(d, moved.dest)].filter(p => !statSync(p, { throwIfNoEntry: false })?.isDirectory())
      const whole = [...moved.sources.map(s => pathAt(d, s)), ...into].find(holdsSwitches)
      if (whole) return `${who} moves ${whole}, which holds Claude Code's settings or plugins, which can switch the hooks off; ${fix}`
    }
  }
  for (const target of [...c.writes, ...writeTargets(c)]) {
    for (const d of cwds) {
      const kind = switchKind(pathAt(d, target))
      if (kind) return `${who} writes ${target}, ${kind === 'plugin' ? 'an installed plugin' : "Claude Code's settings"}, which can switch the hooks off; ${fix}`
    }
  }
  // jq's code reads files but cannot write them.
  if (INTERPRETERS.test(c.name) && c.name !== 'jq') {
    const code = [...c.args, c.stdin ?? '', ...(c.piped && from?.op === '|' ? from.args : [])]
    if (code.some(a => namesSwitch(a, cwds))) return `${who} names Claude Code's settings or plugins, and its code may write them, which can switch the hooks off; ${fix}`
  }
  return null
}

/**
 * Why a shell command would destroy work or history, or switch the hooks
 * off, or null if it would not.
 *
 * @param {string} command
 * @param {string} [cwd] where it runs
 * @returns {string | null}
 */
export function guard(command, cwd = process.cwd()) {
  /** @type {SimpleCommand | undefined} */
  let from
  for (const { c, at } of withCwds(command, cwd)) {
    const why = destructive(c) ?? switchWrite(c, at, from)
    if (why) return why
    from = c
  }
  return null
}
