// Classic (settings-style) hook handlers: each reads the hook's JSON on
// stdin and answers on stdout. Every handler fails open: a hook that cannot
// read its state says nothing rather than breaking the session.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULTS, resolveConfig } from './config.mjs'
import { LOOP_DIR, repoRoot } from './git.mjs'
import { evaluateGuard, qlInvocations } from './guard.mjs'
import { restartRefusal, saveState } from './loop.mjs'
import { isActive, nextAction, statusLine } from './report.mjs'
import { paths, readJson, writeJson } from './store.mjs'

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

/** @param {ReturnType<typeof paths>} p */
const claimFile = p => join(p.work, 'session-claim.json')

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
    const p = paths(root)
    const claim = readJson(claimFile(p))
    const at = Date.parse(claim?.at ?? '')
    const started = Date.parse(state.startedAt ?? '')
    const fresh = typeof claim?.sessionId === 'string' && started >= at && started - at <= CLAIM_WINDOW_MS
    state.sessionId = fresh ? claim.sessionId : sid
    saveState(root, state)
    if (claim) rmSync(claimFile(p), { force: true })
  }
  return state.sessionId === sid
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
  if (!root) {
    // The first `ql start` in a repository creates `.quality-loop/`: claim it at the git root.
    const sid = sessionOf(input)
    const command = input?.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : ''
    if (event === 'pre-tool-use' && sid && qlInvocations(command).some(q => q.sub === 'start')) {
      const top = repoRoot(cwd)
      if (top) writeJson(claimFile(paths(top)), { sessionId: sid, at: new Date().toISOString() })
    }
    return { stdout: '' }
  }
  const p = paths(root)
  const state = readJson(p.state)
  const sid = sessionOf(input)

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
          if (q.sub === 'start' && (q.flags.has('force') || !restartRefusal(state))) {
            // The new loop does not exist yet: leave a claim for it.
            writeJson(claimFile(p), { sessionId: sid, at: new Date().toISOString() })
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
