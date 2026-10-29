#!/usr/bin/env node
// Entry point for the plugin's hooks: `node hook.mjs <event>`, with the hook
// input as JSON on stdin and the hook output as JSON on stdout. The event
// `status` is the band's: it prints the trace's status.

import { readFileSync } from 'node:fs'

import { archiveBlock } from './lib/archive.mjs'
import { issueContext, stopNudge } from './lib/context.mjs'
import { readsOf, storeVerdict } from './lib/docs.mjs'
import { guard } from './lib/guard.mjs'
import { toolPath } from './lib/paths.mjs'
import { traceStatus } from './lib/status.mjs'
import { commandVerdict, editVerdict, readRecord, switchVerdict, worldFor } from './lib/trace.mjs'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * @typedef {{ tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown, cwd?: string, session_id?: unknown, agent_id?: unknown, source?: unknown, stop_hook_active?: unknown }} HookInput
 */

/**
 * @param {string | undefined} event
 * @param {HookInput} input
 * @returns {object | null} the hook output, or null to say nothing
 */
function hookOutput(event, input) {
  if (event === 'session-start' || event === 'subagent-start') {
    // The issue is the record that survives compaction (ADR 0006): each agent is told it at start.
    if (input.source === 'compact') readsOf(input).clear()
    const context = issueContext(input.cwd ?? process.cwd(), worldFor(readsOf(input)))
    const hookEventName = event === 'session-start' ? 'SessionStart' : 'SubagentStart'
    return context ? { hookSpecificOutput: { hookEventName, additionalContext: context } } : null
  }
  if (event === 'post-compact') {
    // A compacted context no longer holds what the agent read, so it reads again.
    readsOf(input).clear()
    return null
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
  if (event !== 'pre-tool-use' || !input.tool_name) return null
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
      // Failing open here would let an untraced edit, commit or PR through.
      return `trace: the trace could not be checked (${/** @type {Error} */ (err).message}). To work untraced, the human can launch Claude Code with TRACE_BYPASS=1.`
    }
  }
  // The hook call's deadline bounds the archive block's git calls as well as the gates' git and GitHub calls.
  const reason = archiveBlock(input.tool_name, toolInput, cwd, world.timeLeft) ?? traceReason() ?? guardReason()
  if (!reason) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
try {
  const out = hookOutput(process.argv[2], input ?? {})
  if (out) process.stdout.write(JSON.stringify(out))
} catch (err) {
  // Fail open: a broken hook must never wedge the session. The band's
  // status is not a hook: a failure there is not "untraced".
  process.stderr.write(`trace hook: ${/** @type {Error} */ (err).message}\n`)
  if (process.argv[2] === 'status') process.exitCode = 1
}
