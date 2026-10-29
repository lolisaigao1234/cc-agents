// The halt (ADR 0006): the trace rests on git and GitHub, so when a hook
// needs an answer from them and gets none, it stops the whole session and
// asks the human to restore them, rather than guess. Git or GitHub saying
// no (no such commit, no such issue, no PR) is an answer, not a halt.

/** @typedef {'git' | 'GitHub' | 'git and GitHub'} Who */

/** Thrown when git or GitHub does not answer a question the trace asks. */
export class Unanswered extends Error {
  /** @param {Who} who @param {string} why */
  constructor(who, why) {
    super(`${who} did not answer: ${why}`)
    this.who = who
  }
}

// git's words when it fails before it can say anything of what was asked: an
// untrusted, locked, corrupt or unreadable repository. It exits 128 for these
// and for some answers alike ("path 'x' does not exist in 'HEAD'").
const GIT_FAILS = /dubious ownership|safe\.directory|not a git repository|cannot change to|unable to (?:access|read|open|create)|\.lock'?: File exists|corrupt|object file .* is empty|inflate:|bad config|repository format version|repo version|Permission denied/i

// gh's words, and its exit code 4, when it is not logged in or cannot reach
// GitHub. "Not Found (HTTP 404)" and "no pull requests found" are answers.
const GH_FAILS = /gh auth login|HTTP (?:401|5\d\d)|rate limit|error connecting to|check your internet connection|dial tcp|no such host|could not resolve host|connection (?:refused|reset)|i\/o timeout|TLS handshake|network is unreachable/i

/**
 * `r`, when git or gh ran and answered; throws Unanswered when it could not
 * run, timed out, was killed, or failed in its own way rather than answer.
 *
 * @template {import('node:child_process').SpawnSyncReturns<string | Buffer>} R
 * @param {'git' | 'GitHub'} who @param {R} r @returns {R}
 */
export function answered(who, r) {
  const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code
  if (code === 'ENOENT') throw new Unanswered(who, `${who === 'git' ? 'git' : 'gh'} is not on PATH`)
  if (code === 'ETIMEDOUT') throw new Unanswered(who, 'it timed out')
  if (r.error) throw new Unanswered(who, r.error.message)
  if (r.signal) throw new Unanswered(who, `it was killed by ${r.signal}`)
  const stderr = String(r.stderr ?? '').trim()
  const fails = who === 'git' ? GIT_FAILS.test(stderr) : r.status === 4 || GH_FAILS.test(stderr)
  if (r.status !== 0 && fails) throw new Unanswered(who, stderr.split('\n')[0] || `exit ${r.status}`)
  return r
}

const REMEDY = {
  git: 'git (`git status` in the repository: git on PATH, the repository readable and trusted)',
  GitHub: 'the connection to GitHub (`gh auth status`, the network)',
  'git and GitHub': 'git and the connection to GitHub (`git status`, `gh auth status`, the network)',
}

/** @param {Unanswered} err @returns {string} what the human is told: what failed, and what to restore */
export const haltReason = err => `trace halted the session: ${err.message}. Restore ${REMEDY[err.who]}, then reply to continue.`

/** @param {Unanswered} err @returns {string} what the band says when its own status gets no answer: it halts nothing */
export const unansweredStatus = err => `trace: ${err.message}. Restore ${REMEDY[err.who]}: until then, each hook that asks halts the session.`

/**
 * The hook output that halts the session: Claude stops, and the human is
 * shown `reason`. A PreToolUse halt also denies the tool call.
 *
 * @param {string | undefined} event @param {string} reason
 */
export function haltOutput(event, reason) {
  const stop = { continue: false, stopReason: reason }
  if (event !== 'pre-tool-use') return stop
  return { ...stop, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}
