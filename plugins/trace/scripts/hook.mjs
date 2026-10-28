#!/usr/bin/env node
// Entry point for the plugin's hooks: `node hook.mjs <event>`, with the hook
// input as JSON on stdin and the hook output as JSON on stdout.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { archiveBlock } from './lib/archive.mjs'
import { readsOf, storeVerdict } from './lib/docs.mjs'
import { guard } from './lib/guard.mjs'
import { real } from './lib/paths.mjs'
import { commandVerdict, editVerdict, readRecord, switchVerdict, worldFor } from './lib/trace.mjs'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * @typedef {{ tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown, cwd?: string, session_id?: unknown, agent_id?: unknown }} HookInput
 */

/**
 * @param {string | undefined} event
 * @param {HookInput} input
 * @returns {object | null} the hook output, or null to say nothing
 */
function hookOutput(event, input) {
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
    const why = input.tool_name === 'Bash' ? guard(String(toolInput.command ?? '')) : null
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
    // The edit tools expand only `~` and `~/`.
    const path = real(resolve(cwd, raw.replace(/^~(?=\/|$)/, homedir())))
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
  const reason = archiveBlock(input.tool_name, toolInput, cwd) ?? traceReason() ?? guardReason()
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
  // Fail open: a broken hook must never wedge the session.
  process.stderr.write(`trace hook: ${/** @type {Error} */ (err).message}\n`)
}
