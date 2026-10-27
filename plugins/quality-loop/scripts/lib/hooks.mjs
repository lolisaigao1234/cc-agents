// Classic (settings-style) hook handlers: each reads the hook's JSON on
// stdin and answers on stdout. Every handler fails open: a hook that cannot
// read its state says nothing rather than breaking the session.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { DEFAULTS, resolveConfig } from './config.mjs'
import { LOOP_DIR } from './git.mjs'
import { evaluateGuard, qlInvocations } from './guard.mjs'
import { restartRefusal, saveState } from './loop.mjs'
import { isActive, nextAction, statusLine } from './report.mjs'
import { paths, readJson } from './store.mjs'

/**
 * The nearest directory at or above `start` that holds `.quality-loop/`.
 *
 * @param {string} start
 */
export function findLoopRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, LOOP_DIR))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const MAX_CONTEXT = 6000
// No configuration keeps a session from stopping more often than this.
const HARD_MAX_NUDGES = 50
// A `ql start` seen by the guard claims the loop it creates if the loop
// starts within this long (the permission prompt may wait on the user).
const CLAIM_WINDOW_MS = 10 * 60 * 1000
// ql commands that drive a loop: the session running them is the one running the loop.
const DRIVING = new Set(['round', 'ingest', 'vote', 'mark', 'resume', 'pause', 'finish'])

/**
 * Where a session's claim on the loop it is starting is kept: in the git
 * directory, so a `ql start` that never runs leaves nothing in the working
 * tree. Found without running git: the nearest `.git` directory, or the one
 * a `.git` file (a worktree, a submodule) points to.
 *
 * @param {string} start
 */
export function claimFile(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    try {
      if (statSync(dotGit).isDirectory()) return join(dotGit, 'quality-loop-claim.json')
      const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      return to ? join(resolve(dir, to), 'quality-loop-claim.json') : null
    } catch {
      if (dirname(dir) === dir) return null
    }
  }
}

/** @param {string | null} file */
const readClaim = file => {
  try {
    return file ? readJson(file) : null
  } catch {
    return null
  }
}

// A claim is a hint: failing to keep one only means the loop binds to the
// first session that reports in, so it never stops a hook (or the guard).

/** @param {string | null} file @param {string} sid */
const writeClaim = (file, sid) => {
  try {
    if (file) writeFileSync(file, JSON.stringify({ sessionId: sid, at: new Date().toISOString() }))
  } catch {}
}

/** @param {string | null} file */
const dropClaim = file => {
  try {
    if (file) rmSync(file, { force: true })
  } catch {}
}

/**
 * A `ql start` that would create or replace a loop (the agent's own: not
 * --help, and not one ql will refuse).
 *
 * @param {ReturnType<typeof qlInvocations>[number]} q
 * @param {any} state
 */
const claimsLoop = (q, state) => q.sub === 'start' && !q.flags.has('help') && (q.flags.has('force') || !restartRefusal(state))

/** @param {any} input */
const sessionOf = input => (typeof input?.session_id === 'string' && input.session_id ? input.session_id : null)

/**
 * Whether `sid` is the session running the loop. The loop is bound to a
 * session when the guard sees that session run `ql start` (a claim), or else
 * to the first session whose hook reports in after the start. Hooks without
 * a session id are treated as the loop's own.
 *
 * @param {string} root
 * @param {any} state
 * @param {string | null} sid
 */
function ownsLoop(root, state, sid) {
  if (!sid) return true
  if (!state.sessionId) {
    const file = claimFile(root)
    const claim = readClaim(file)
    const at = Date.parse(claim?.at ?? '')
    const started = Date.parse(state.startedAt ?? '')
    const fresh = typeof claim?.sessionId === 'string' && started >= at && started - at <= CLAIM_WINDOW_MS
    state.sessionId = fresh ? claim.sessionId : sid
    saveState(root, state)
    if (claim) dropClaim(file)
  }
  return state.sessionId === sid
}

/**
 * Drops `sid`'s claim once that session has moved on and no loop started
 * after it: the `ql start` was declined, failed or only printed help, and
 * must not bind a loop someone starts later.
 *
 * @param {string} cwd
 * @param {any} state
 * @param {string} sid
 */
function settleClaim(cwd, state, sid) {
  const file = claimFile(cwd)
  const claim = readClaim(file)
  if (!claim || claim.sessionId !== sid) return
  if (!(Date.parse(state?.startedAt ?? '') >= Date.parse(claim.at ?? ''))) dropClaim(file)
}

/** @param {unknown} v the configured limit, which may be anything after a hand edit */
function nudgeLimit(v) {
  const n = Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : DEFAULTS.loop.maxStopNudges
  return Math.min(n, HARD_MAX_NUDGES)
}

/** @param {string} root @param {any} state */
const elsewhere = (root, state) => `A quality loop is running in another session in ${root} (${statusLine(state)}); it is not this session's task.`

/**
 * @param {string} event pre-tool-use | stop | session-start | user-prompt-submit
 * @param {any} input the hook's stdin JSON
 * @returns {{ stdout: string } }
 */
export function handleHook(event, input) {
  const cwd = input?.cwd || process.cwd()
  const root = findLoopRoot(cwd)
  const sid = sessionOf(input)
  const command = event === 'pre-tool-use' && input?.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : ''
  const p = root ? paths(root) : null
  const state = p ? readJson(p.state) : null
  const starts = sid ? qlInvocations(command).filter(q => claimsLoop(q, state)) : []
  if (sid && !starts.length) settleClaim(root ?? cwd, state, sid)

  if (!root || !p) {
    // The first `ql start` in a repository creates `.quality-loop/`: claim the loop it will start.
    if (starts.length && sid) writeClaim(claimFile(cwd), sid)
    return { stdout: '' }
  }

  if (event === 'pre-tool-use') {
    const config = state?.config ?? resolveConfig(readJson(p.config))
    const hillclimb = readJson(join(p.evals, 'hillclimb.json'))
    const tool = String(input.tool_name ?? '')
    const reason = evaluateGuard({
      tool,
      input: input.tool_input ?? {},
      root,
      cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : root,
      loopStatus: state?.status ?? null,
      protectedPaths: config.guard.protectedPaths,
      blockDestructive: config.guard.blockDestructive,
      hillclimbActive: !!hillclimb?.active,
    })
    if (reason) {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
        }),
      }
    }
    if (sid) {
      if (isActive(state)) ownsLoop(root, state, sid)
      if (tool === 'Bash') {
        for (const q of qlInvocations(String(input.tool_input?.command ?? ''))) {
          if (claimsLoop(q, state)) {
            // The new loop does not exist yet: leave a claim for it.
            writeClaim(claimFile(root), sid)
          } else if (q.sub && DRIVING.has(q.sub) && state && state.status !== 'done' && state.sessionId !== sid) {
            state.sessionId = sid
            saveState(root, state)
          }
        }
      }
    }
    return { stdout: '' }
  }

  if (!isActive(state)) return { stdout: '' }
  const owner = ownsLoop(root, state, sid)

  if (event === 'stop') {
    // Only the session running the loop is kept going.
    if (!owner) return { stdout: '' }
    // Waiting on background subagents is not stopping early.
    if (Array.isArray(input.background_tasks) && input.background_tasks.length) return { stdout: '' }
    const max = nudgeLimit(state.config?.loop?.maxStopNudges)
    const used = state.stopNudges === undefined ? 0 : state.stopNudges
    // A counter that is not a count fails open.
    if (!Number.isInteger(used) || used < 0 || used >= max) return { stdout: '' }
    state.stopNudges = used + 1
    saveState(root, state)
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason:
          `The quality loop is still active (${statusLine(state)}). Next: ${nextAction(state)} ` +
          `Keep going without asking. If you genuinely need the user, run \`ql pause --reason "<what you need>"\` first. ` +
          `(continuation ${state.stopNudges} of ${max})`,
      }),
    }
  }

  if (event === 'session-start') {
    if (!owner) {
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: elsewhere(root, state) } }) }
    }
    // After a compaction or resume, re-anchor on the files, not the summary.
    let loopMd = ''
    try {
      loopMd = readFileSync(p.loopMd, 'utf8')
    } catch {
      loopMd = statusLine(state)
    }
    const text =
      `A quality loop is active in ${root}. Its durable state is ${p.loopMd} (rendered below; trust it over any summary). ` +
      `Run \`ql next\` when unsure what to do.\n\n${loopMd}`
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, MAX_CONTEXT) },
      }),
    }
  }

  if (event === 'user-prompt-submit') {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: owner ? `[${statusLine(state)}] Next: ${nextAction(state)} Goal: ${state.goal}` : elsewhere(root, state),
        },
      }),
    }
  }
  return { stdout: '' }
}
