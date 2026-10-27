// Classic (settings-style) hook handlers: each reads the hook's JSON on
// stdin and answers on stdout. Every handler fails open: a hook that cannot
// read its state says nothing rather than breaking the session.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveConfig } from './config.mjs'
import { LOOP_DIR } from './git.mjs'
import { evaluateGuard } from './guard.mjs'
import { saveState } from './loop.mjs'
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

/**
 * @param {string} event pre-tool-use | stop | session-start | user-prompt-submit
 * @param {any} input the hook's stdin JSON
 * @returns {{ stdout: string } }
 */
export function handleHook(event, input) {
  const root = findLoopRoot(input?.cwd || process.cwd())
  if (!root) return { stdout: '' }
  const p = paths(root)
  const state = readJson(p.state)

  if (event === 'pre-tool-use') {
    const config = state?.config ?? resolveConfig(readJson(p.config))
    const hillclimb = readJson(join(p.evals, 'hillclimb.json'))
    const reason = evaluateGuard({
      tool: String(input.tool_name ?? ''),
      input: input.tool_input ?? {},
      root,
      loopStatus: state?.status ?? null,
      protectedPaths: config.guard.protectedPaths,
      blockDestructive: config.guard.blockDestructive,
      hillclimbActive: !!hillclimb?.active,
    })
    if (!reason) return { stdout: '' }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }),
    }
  }

  if (!isActive(state)) return { stdout: '' }

  if (event === 'stop') {
    // Waiting on background subagents is not stopping early.
    if (Array.isArray(input.background_tasks) && input.background_tasks.length) return { stdout: '' }
    const max = state.config.loop.maxStopNudges
    if (state.stopNudges >= max) return { stdout: '' }
    state.stopNudges += 1
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
          additionalContext: `[${statusLine(state)}] Next: ${nextAction(state)} Goal: ${state.goal}`,
        },
      }),
    }
  }
  return { stdout: '' }
}
