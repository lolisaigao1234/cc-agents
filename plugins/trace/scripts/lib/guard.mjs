// The guard: the hard block on commands that destroy work or history.
//
// It reads command text, so it is a seatbelt, not a sandbox: aliases,
// functions and scripts can get past it.

import { GIT_COMMIT_OPTIONS, beforeDashDash, gitParts, operands, parseCommands, readOptions, shortFlags } from './shell.mjs'

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
      if (operands(opts, 'o', ['--push-option', '--repo', '--receive-pack', '--exec']).some(x => x.startsWith('+'))) return 'a +refspec force-pushes'
      break
    }
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
  return null
}

/**
 * Why a shell command would destroy work or history, or null if it would not.
 *
 * @param {string} command
 * @returns {string | null}
 */
export function guard(command) {
  for (const c of parseCommands(command)) {
    const why = destructive(c)
    if (why) return why
  }
  return null
}
