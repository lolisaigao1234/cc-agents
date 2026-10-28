#!/usr/bin/env node
// Entry point for the plugin's hooks: `node hook.mjs <event>`, with the hook
// input as JSON on stdin and the hook output as JSON on stdout.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { archiveBlock } from './lib/archive.mjs'
import { guard } from './lib/guard.mjs'
import { real, untilde } from './lib/paths.mjs'
import { editVerdict, switchVerdict } from './lib/trace.mjs'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * @param {string | undefined} event
 * @param {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} input
 * @returns {object | null} the hook output, or null to say nothing
 */
function hookOutput(event, input) {
  if (event !== 'pre-tool-use' || !input.tool_name) return null
  const toolInput = input.tool_input ?? {}
  const guardReason = () => {
    const why = input.tool_name === 'Bash' ? guard(String(toolInput.command ?? '')) : null
    return why && `trace guard: ${why}. If it is really needed, ask the user to run it.`
  }
  const cwd = input.cwd ?? process.cwd()
  const traceReason = () => {
    const raw = toolInput.file_path ?? toolInput.notebook_path
    if (!EDIT_TOOLS.has(String(input.tool_name)) || typeof raw !== 'string') return null
    const path = real(resolve(cwd, untilde(raw, cwd)))
    try {
      const why = switchVerdict(String(input.tool_name), toolInput, path) ?? editVerdict(path)
      return why && `trace: ${why}`
    } catch (err) {
      // Failing open here would let an untraced edit through.
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
