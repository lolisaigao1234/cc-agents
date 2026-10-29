// The halt (ADR 0006): the trace rests on git and GitHub, so when a hook
// needs an answer from them and gets none, it stops the whole session and
// asks the human to restore them, rather than guess. Git or GitHub saying
// no (no such commit, no such issue, no PR) is an answer, not a halt.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sessionDir } from './docs.mjs'

/** @typedef {'git' | 'GitHub' | 'git and GitHub'} Who */

/** Thrown when git or GitHub does not answer a question the trace asks. */
export class Unanswered extends Error {
  /** @param {Who} who @param {string} why */
  constructor(who, why) {
    super(`${who} did not answer: ${why}`)
    this.who = who
    /** @type {string | undefined} what else the agent can do: a form of the command that asks them nothing */
    this.hint = undefined
  }
}

// git's words when it fails before it can say anything of what was asked: an
// untrusted, locked, corrupt or unreadable repository. It exits 128 for these
// and for some answers alike ("path 'x' does not exist in 'HEAD'").
const GIT_FAILS = /dubious ownership|safe\.directory|not a git repository|cannot change to|unable to (?:access|read|open|create)|\.lock'?: File exists|corrupt|object file .* is empty|inflate:|bad config|repository format version|repo version|Permission denied/i

// gh's words, and its exit code 4, when it is not logged in or cannot reach
// GitHub. "Not Found (HTTP 404)" and "no pull requests found" are answers.
const GH_FAILS = /gh auth login|HTTP (?:401|5\d\d)|rate limit|error connecting to|check your internet connection|dial tcp|no such host|could not resolve host|connection (?:refused|reset)|i\/o timeout|TLS handshake|network is unreachable/i

// git's words when it says no to what the trace asks of it: no such path,
// revision, remote, upstream or commit yet. With LC_ALL=C (GIT_ENV) they are
// these words whatever the human's locale. A quiet exit 1 is a no as well.
export const GIT_NO = new RegExp([
  'does not exist in', 'invalid object name', 'not a valid object name', 'bad revision', 'unknown revision', 'ambiguous argument',
  'does not have any commits yet', 'no such remote', 'invalid key', 'does not contain a section',
  // A branch's upstream or push destination, as `<branch>@{upstream}` and `@{push}` resolve them (git's remote.c).
  'no upstream configured', 'not stored as a remote-tracking branch', 'has no local tracking branch', 'has no remote for pushing',
  'push refspecs for .* do not include', 'push has no destination', 'cannot resolve .* push to a single destination',
  'does not point to a branch', 'no such branch',
].join('|'), 'i')

/** The environment git runs in, so that what it says is in its own words. */
export const GIT_ENV = () => ({ ...process.env, LC_ALL: 'C' })

/**
 * `r`, when git or gh ran and answered; throws Unanswered when it could not
 * run, timed out, was killed, or failed in its own way rather than answer.
 * With `answers`, the words of every failure that is an answer (for git, a
 * quiet exit 1 also is), so any other failure throws: the trace's own
 * questions. Without, a failure halt.mjs does not list is left to the caller,
 * as for a command the agent wrote, whose failure may be its own mistake.
 *
 * @template {import('node:child_process').SpawnSyncReturns<string | Buffer>} R
 * @param {'git' | 'GitHub'} who @param {R} r @param {RegExp} [answers] @returns {R}
 */
export function answered(who, r, answers) {
  const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code
  if (code === 'ENOENT') throw new Unanswered(who, `${who === 'git' ? 'git' : 'gh'} is not on PATH`)
  if (code === 'ETIMEDOUT') throw new Unanswered(who, 'it timed out')
  if (r.error) throw new Unanswered(who, r.error.message)
  if (r.signal) throw new Unanswered(who, `it was killed by ${r.signal}`)
  if (r.status === 0) return r
  const stderr = String(r.stderr ?? '').trim()
  const fails = who === 'git' ? GIT_FAILS.test(stderr) : r.status === 4 || GH_FAILS.test(stderr)
  const isAnswer = !answers || (who === 'git' && r.status === 1 && !stderr) || answers.test(stderr)
  if (fails || !isAnswer) throw new Unanswered(who, stderr.split('\n')[0] || `exit ${r.status}`)
  return r
}

const REMEDY = {
  git: 'git (`git status` in the repository: git on PATH, the repository readable and trusted)',
  GitHub: 'the connection to GitHub (`gh auth status`, the network)',
  'git and GitHub': 'git and the connection to GitHub (`git status`, `gh auth status`, the network)',
}

/** @param {Unanswered} err @returns {string} what the human is told: what failed, and what to restore */
export const haltReason = err => `trace halted the session: ${err.message}. Restore ${REMEDY[err.who]}${err.hint ? `, or ${err.hint}` : ''}, then reply to continue.`

/** @param {Unanswered} err @returns {string} what the band says when its own status gets no answer: it halts nothing */
export const unansweredStatus = err => `trace: ${err.message}. Restore ${REMEDY[err.who]}: until then, each hook that asks halts the session.`

/**
 * The halt of the session a hook input comes from: one record for the main
 * session and all its subagents, kept beside their reads (docs.mjs), so a
 * halt in one stops them all. Unsigned: a forged halt only stops the
 * session. Without a session id, none can be kept.
 *
 * @param {{ session_id?: unknown }} input
 * @returns {{ reason(): string | null, set(reason: string): void, clear(): void }}
 */
export function haltOf(input) {
  const dir = sessionDir(input.session_id)
  if (!dir) return { reason: () => null, set() {}, clear() {} }
  // Agents' directories are named by ids without a dot, so none is this file.
  const path = join(dir, 'halt.json')
  return {
    reason() {
      try {
        const { reason } = JSON.parse(readFileSync(path, 'utf8'))
        return typeof reason === 'string' ? reason : null
      } catch {
        return null
      }
    },
    // Written whole, then moved in place, so another agent's hook never reads half of it.
    set(reason) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const part = join(dir, `halt-${randomUUID()}.part`)
      writeFileSync(part, JSON.stringify({ reason }), { mode: 0o600, flag: 'wx' })
      renameSync(part, path)
    },
    clear() {
      rmSync(path, { force: true })
    },
  }
}

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
