// Policy for the PreToolUse guard while a loop runs. Pure.
//
// It reads command text only, so it is a seatbelt, not a sandbox: `$(...)`,
// aliases and scripts can get past it. Permission rules are the hard block.

import { matchesAny, normalizePath } from './glob.mjs'

/** @type {[RegExp, string][]} */
const DESTRUCTIVE = [
  [/\bgit\s+reset\b[^;&|]*--hard\b/, 'git reset --hard discards uncommitted work'],
  [/\bgit\s+clean\b[^;&|]*\s-[a-zA-Z]*f/, 'git clean -f deletes untracked files'],
  [/\bgit\s+checkout\b[^;&|]*\s(?:--\s+)?\.(?:\s|$)/, 'git checkout . discards working-tree changes'],
  [/\bgit\s+checkout\s+--\s/, 'git checkout -- <path> discards working-tree changes'],
  [/\bgit\s+push\b[^;&|]*(?:--force\b|--force-with-lease\b|\s-f\b)/, 'force push rewrites shared history'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, 'dropping a stash loses work'],
  [/\bgit\s+branch\b[^;&|]*\s-D\b/, 'git branch -D deletes unmerged work'],
  [/\bgit\s+(?:commit|push|merge|rebase)\b[^;&|]*--no-verify\b/, '--no-verify skips the checks the loop relies on'],
  [/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b/, 'rm -rf'],
]

/**
 * `git restore` discards working-tree changes unless it only unstages
 * (`--staged` without `--worktree`/`-W`).
 *
 * @param {string} cmd
 * @returns {[RegExp, string][]}
 */
function restoreRule(cmd) {
  const m = /\bgit\s+restore\b([^;&|]*)/.exec(cmd)
  if (!m) return []
  const args = m[1] ?? ''
  const onlyUnstages = /(?:^|\s)(?:--staged|-S)\b/.test(args) && !/(?:^|\s)(?:--worktree|-W)\b/.test(args)
  return onlyUnstages ? [] : [[/\bgit\s+restore\b/, 'git restore discards working-tree changes']]
}

/** @param {string} s */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A script that writes, moves or deletes files (node, python, ruby, perl).
const SCRIPT_WRITE =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|renameSync|copyFileSync|write_text|write_bytes|os\.remove|os\.unlink|shutil\.\w+|File\.write)\b|\bopen\([^)]*,\s*["'][wax]/

/**
 * Whether a shell command writes `target`: redirects into it, or names it
 * as an argument of a command that modifies files. Reading it (cat, jq,
 * require) is fine, as are redirects and arrows elsewhere in the command.
 *
 * @param {string} cmd
 * @param {string} target
 */
function writesTo(cmd, target) {
  if (!cmd.includes(target)) return false
  const t = escapeRe(target)
  return (
    new RegExp(`>>?\\s*["']?[^\\s"';&|]*${t}`).test(cmd) ||
    new RegExp(`\\btee\\b[^;&|]*${t}`).test(cmd) ||
    new RegExp(`\\b(?:sed|perl)\\b[^;&|]*\\s-[a-zA-Z]*i[^;&|]*${t}`).test(cmd) ||
    new RegExp(`\\b(?:mv|cp|rm|truncate|dd|install|ln)\\b[^;&|]*${t}`).test(cmd) ||
    SCRIPT_WRITE.test(cmd)
  )
}

/**
 * @typedef {{
 *   tool: string,
 *   input: Record<string, any>,
 *   root: string,
 *   loopStatus: string | null,
 *   protectedPaths: string[],
 *   blockDestructive: boolean,
 *   hillclimbActive: boolean,
 * }} GuardInput
 */

/** @param {string} root @param {string} file */
function relative(root, file) {
  const f = normalizePath(file)
  const r = normalizePath(root).replace(/\/$/, '')
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f
}

/**
 * @param {GuardInput} g
 * @returns {string | null} the reason to deny, or null to allow
 */
export function evaluateGuard(g) {
  const isLoopActive = g.loopStatus === 'active'
  const protectedPaths = [...g.protectedPaths]
  if (g.hillclimbActive) protectedPaths.push('.quality-loop/evals/**')

  if (g.tool === 'Bash') {
    const cmd = String(g.input.command ?? '')
    // Only the user may raise the round cap or restart over a running loop.
    if (/\bql(?:\.mjs)?\b[^;&|]*\bextend\b/.test(cmd)) {
      return 'quality-loop: only the user may extend a capped or stalled loop. Report to the user and let them run `! ql extend` themselves.'
    }
    if (isLoopActive && /\bql(?:\.mjs)?\b[^;&|]*\bstart\b[^;&|]*--force\b/.test(cmd)) {
      return 'quality-loop: a loop is active; restarting it would discard its limits and ledger. Finish it or ask the user.'
    }
    if (isLoopActive || g.hillclimbActive) {
      if (g.blockDestructive) {
        for (const [re, why] of [...DESTRUCTIVE, ...restoreRule(cmd)]) {
          if (re.test(cmd)) {
            return `quality-loop: blocked during an active loop (${why}). The loop reverts its own rounds with checkpoints; if you really need this, pause the loop and ask the user.`
          }
        }
      }
      for (const p of protectedPaths) {
        const literal = p.replace(/\/?\*\*.*$/, '').replace(/\*.*$/, '')
        if (literal && writesTo(cmd, literal)) {
          return `quality-loop: ${literal} is protected while the loop runs; change it only through \`ql\` commands or ask the user.`
        }
      }
    }
    return null
  }

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(g.tool) && (isLoopActive || g.hillclimbActive)) {
    const file = String(g.input.file_path ?? g.input.notebook_path ?? '')
    if (file && matchesAny(relative(g.root, file), protectedPaths)) {
      return `quality-loop: ${relative(g.root, file)} is protected while the loop runs (loop limits, state and eval answer keys are not the agent's to change). Use \`ql\` commands or ask the user.`
    }
  }
  return null
}
