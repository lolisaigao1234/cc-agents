// The guard: the hard block on commands that destroy work or history, or
// that write the settings and plugins that switch the hooks off.
//
// It reads command text, so it is a seatbelt, not a sandbox: aliases,
// functions and scripts can get past it.

import { basename, join, resolve } from 'node:path'

import { untilde } from './paths.mjs'
import { GIT_COMMIT_OPTIONS, beforeDashDash, gitParts, operands, readOptions, shortFlags, withCwds } from './shell.mjs'
import { switchKind } from './trace.mjs'

/** @typedef {import('./shell.mjs').SimpleCommand} SimpleCommand */

/** @param {string[]} args */
function gitDestructive(args) {
  const { config, sub, rest, opts, long } = gitParts(args)

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
      const refspecs = operands(opts, 'o', ['--push-option', '--repo', '--receive-pack', '--exec'])
      if (refspecs.some(x => x.startsWith('+'))) return 'a +refspec force-pushes'
      if (s.has('d') || long('--delete') || refspecs.slice(1).some(x => x.startsWith(':'))) return 'deleting a remote branch loses its commits for everyone'
      if (long('--mirror')) return 'git push --mirror overwrites and deletes the remote\'s refs'
      if (long('--prune')) return 'git push --prune deletes remote branches'
      break
    }
    case 'reflog':
      if ((rest[0] === 'expire' || rest[0] === 'delete') && !rest.some(a => a === '-n' || a === '--dry-run')) return 'expiring the reflog drops what recovers lost commits'
      break
    case 'gc':
      if (opts.some(a => /^--prune=(?:now|all)$/i.test(a))) return 'git gc --prune=now deletes unreachable commits at once'
      break
    case 'prune':
      if (!opts.some(a => a === '-n' || a === '--dry-run')) return 'git prune deletes unreachable commits'
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
  if (c.name === 'rsync' && c.args.some(a => /^--(?:del|delete(?:-\w+)*|remove-source-files)$/.test(a))) return 'rsync --delete deletes files the source does not have'
  return null
}

// --- the switches ---------------------------------------------------------------------

// Commands that write the files they name: all their operands, or only the last (the destination).
const WRITE_ALL = { tee: '', mv: 'tS', rm: '', unlink: '', truncate: 'sr', shred: 'nsu', sponge: '' }
const WRITE_LAST = { cp: 'tS', install: 'tgmoS', ln: 'tS', rsync: 'efT', scp: 'cFiJloPS' }
const IN_PLACE = { sed: 'ef', perl: 'eEIMm', ruby: 'eIr' }
// Interpreters whose code, given on the command line, may write any file.
const INTERPRETERS = /^(?:node|deno|bun|python[\d.]*|ruby|perl|php|osascript|lua)$/
const NAMES_SWITCH = /(?:^|[/\s'"`])(?:(?:managed-)?settings(?:\.local)?\.json\b|\.claude\/plugins\b)/
// `claude` subcommands that change installed plugins or settings.
const CLAUDE_WRITES = /^(?:plugins? (?:install|i|uninstall|remove|rm|enable|disable|update|marketplace)|config (?:set|add|remove|rm))\b/

/**
 * The files a command writes, as it names them.
 *
 * @param {import('./shell.mjs').SimpleCommand} c
 * @returns {string[]}
 */
function writeTargets(c) {
  const { name, args } = c
  /** @type {Record<string, string>} */ const all = WRITE_ALL
  /** @type {Record<string, string>} */ const last = WRITE_LAST
  /** @type {Record<string, string>} */ const inPlace = IN_PLACE
  if (name in all) return operands(args, all[name])
  if (name in inPlace && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return operands(args, inPlace[name])
  if (name === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
  if (!(name in last)) return []
  const ops = operands(args, last[name], ['--target-directory'])
  const t = args.findIndex(a => a === '-t' || a === '--target-directory')
  const glued = args.find(a => a.startsWith('--target-directory='))?.slice('--target-directory='.length)
  const dir = glued ?? (t >= 0 ? args[t + 1] : undefined)
  if (dir !== undefined) return ops.map(s => join(dir, basename(s)))
  const dest = ops.at(-1)
  return dest === undefined ? [] : [dest, ...ops.slice(0, -1).map(s => join(dest, basename(s)))]
}

/**
 * Why a command would write Claude Code's settings or an installed plugin,
 * which can switch the hooks off, or null.
 *
 * @param {import('./shell.mjs').SimpleCommand} c
 * @param {string[]} cwds the directories it may run in
 */
function switchWrite(c, cwds) {
  const fix = 'only the human changes it, by hand; a settings change other than env, disableAllHooks, enabledPlugins or hooks can be made with the Edit tool'
  if (c.name === 'claude' && CLAUDE_WRITES.test(c.args.join(' '))) return `\`claude ${c.args.slice(0, 2).join(' ')}\` changes Claude Code's plugins or settings, which can switch the hooks off; ${fix}`
  if (INTERPRETERS.test(c.name) && c.args.some(a => NAMES_SWITCH.test(a))) return `\`${c.name}\` names Claude Code's settings or plugins, and its code may write them, which can switch the hooks off; ${fix}`
  for (const target of [...c.writes, ...writeTargets(c)]) {
    for (const d of cwds) {
      const kind = switchKind(resolve(d, untilde(target, d)))
      if (kind) return `\`${c.name}\` writes ${target}, ${kind === 'plugin' ? 'an installed plugin' : "Claude Code's settings"}, which can switch the hooks off; ${fix}`
    }
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
  for (const { c, at } of withCwds(command, cwd)) {
    const why = destructive(c) ?? switchWrite(c, at)
    if (why) return why
  }
  return null
}
