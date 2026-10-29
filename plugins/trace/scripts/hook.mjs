#!/usr/bin/env node
// Entry point for the plugin's hooks: `node hook.mjs <event>`, with the hook
// input as JSON on stdin and the hook output as JSON on stdout. The event
// `status` is the band's: it prints the trace's status, or the halt.

import { readFileSync } from 'node:fs'

import { archiveBlock } from './lib/archive.mjs'
import { issueContext, stopNudge } from './lib/context.mjs'
import { readsOf, storeVerdict } from './lib/docs.mjs'
import { guard } from './lib/guard.mjs'
import { Unanswered, haltOf, haltOutput, haltReason, unansweredStatus } from './lib/halt.mjs'
import { toolPath } from './lib/paths.mjs'
import { traceStatus } from './lib/status.mjs'
import { commandVerdict, editVerdict, readRecord, switchVerdict, worldFor } from './lib/trace.mjs'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// The tools the gates, the guard and the archive block judge. PreToolUse sees
// every tool, so that a halt stops them all; the rest it only halts.
const JUDGED = new Set(['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Grep', 'Glob', 'LS'])
// A prompt Claude Code sends when a background agent finishes, which the human did not write.
const NOTIFICATION = /^\s*<task-notification>/

/**
 * @typedef {{ tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown, cwd?: string, session_id?: unknown, agent_id?: unknown, source?: unknown, stop_hook_active?: unknown, prompt?: unknown }} HookInput
 */

/**
 * @param {string | undefined} event
 * @param {HookInput} input
 * @returns {object | null} the hook output, or null to say nothing
 */
function hookOutput(event, input) {
  // The next prompt lifts a halt, and starting or resuming the session does;
  // a call that still gets no answer halts again. The hook cannot tell the
  // human's prompt from a scheduled task's or another session's, only from
  // a background agent's report.
  if (event === 'user-prompt-submit') {
    if (!NOTIFICATION.test(String(input.prompt ?? ''))) haltOf(input).clear()
    return null
  }
  if (event === 'session-start' && ['startup', 'resume', 'clear'].includes(String(input.source))) haltOf(input).clear()
  // A compacted context no longer holds what the agent read, so it reads again, halted or not.
  if (event === 'post-compact' || (event === 'session-start' && input.source === 'compact')) readsOf(input).clear()
  if (event === 'post-compact') return null
  // While a halt stands, every hook call of the session halts at once, in every agent.
  const halted = haltOf(input).reason()
  if (halted) return event === 'status' ? { halt: halted } : haltOutput(event, halted)
  if (event === 'session-start' || event === 'subagent-start') {
    // The issue is the record that survives compaction (ADR 0006): each agent is told it at start.
    const context = issueContext(input.cwd ?? process.cwd(), worldFor(readsOf(input)))
    const hookEventName = event === 'session-start' ? 'SessionStart' : 'SubagentStart'
    return context ? { hookSpecificOutput: { hookEventName, additionalContext: context } } : null
  }
  if (event === 'stop') {
    const why = stopNudge(input, worldFor(readsOf(input)))
    return why ? { decision: 'block', reason: `trace: ${why}` } : null
  }
  if (event === 'status') {
    // For the band and /trace: the main agent's view of the trace (ADR 0005).
    return traceStatus(input.cwd ?? process.cwd(), worldFor(readsOf({ session_id: input.session_id })))
  }
  if (event === 'post-tool-use') {
    // What the agent read, for the edit and commit gates to check (ADR 0007).
    const reads = readsOf(input)
    for (const record of readRecord(input, worldFor(reads))) reads.add(record)
    return null
  }
  if (event !== 'pre-tool-use' || !input.tool_name || !JUDGED.has(input.tool_name)) return null
  const toolInput = input.tool_input ?? {}
  const world = worldFor(readsOf(input))
  const guardReason = () => {
    const why = input.tool_name === 'Bash' ? guard(String(toolInput.command ?? ''), input.cwd ?? process.cwd()) : null
    return why && `trace guard: ${why}. If it is really needed, ask the user to run it.`
  }
  const cwd = input.cwd ?? process.cwd()
  const verdict = () => {
    if (input.tool_name === 'Bash') {
      const command = String(toolInput.command ?? '')
      return storeVerdict({ command }) ?? commandVerdict(command, cwd, world)
    }
    const raw = toolInput.file_path ?? toolInput.notebook_path
    if (!EDIT_TOOLS.has(String(input.tool_name)) || typeof raw !== 'string') return null
    const path = toolPath(raw, cwd)
    return storeVerdict({ path }) ?? switchVerdict(String(input.tool_name), toolInput, path) ?? editVerdict(path, world)
  }
  const traceReason = () => {
    try {
      const why = verdict()
      return why && `trace: ${why}`
    } catch (err) {
      // git or GitHub not answering halts the session (see `halting`). Failing
      // open on anything else would let an untraced edit, commit or PR through.
      if (err instanceof Unanswered) throw err
      return `trace: the trace could not be checked (${/** @type {Error} */ (err).message}). To work untraced, the human can launch Claude Code with TRACE_BYPASS=1.`
    }
  }
  // The hook call's deadline bounds the archive block's git calls as well as the gates' git and GitHub calls.
  const reason = archiveBlock(input.tool_name, toolInput, cwd, world.timeLeft) ?? traceReason() ?? guardReason()
  if (!reason) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

/**
 * The hook output, or the halt when git or GitHub did not answer: the trace
 * cannot work without them, so the session halts, every agent of it. The
 * band's status only shows that: it is not a hook, and a halt it recorded
 * would stop calls that ask git nothing.
 *
 * @param {string | undefined} event @param {HookInput} input
 * @returns {object | null}
 */
function halting(event, input) {
  try {
    return hookOutput(event, input)
  } catch (err) {
    if (!(err instanceof Unanswered)) throw err
    if (event === 'status') return { halt: unansweredStatus(err) }
    const reason = haltReason(err)
    haltOf(input).set(reason)
    return haltOutput(event, reason)
  }
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
const event = process.argv[2]
try {
  const out = halting(event, input ?? {})
  if (out) process.stdout.write(JSON.stringify(out))
  // A PreToolUse halt also exits 2, which blocks the tool call whatever `continue` makes of the deny.
  if (event === 'pre-tool-use' && out && 'stopReason' in out) {
    process.stderr.write(`${out.stopReason}\n`)
    process.exitCode = 2
  }
} catch (err) {
  // Fail open: a broken hook must never wedge the session. The band's
  // status is not a hook: a failure there is not "untraced".
  process.stderr.write(`trace hook: ${/** @type {Error} */ (err).message}\n`)
  if (event === 'status') process.exitCode = 1
}
