#!/usr/bin/env node
// Entry point for the plugin's hooks: `node hook.mjs <event>`, with the hook
// input as JSON on stdin and the hook output as JSON on stdout.

import { readFileSync } from 'node:fs'

import { guard } from './lib/guard.mjs'

/**
 * @param {string | undefined} event
 * @param {{ tool_name?: string, tool_input?: { command?: unknown } }} input
 * @returns {object | null} the hook output, or null to say nothing
 */
function handle(event, input) {
  if (event !== 'pre-tool-use' || input.tool_name !== 'Bash') return null
  const why = guard(String(input.tool_input?.command ?? ''))
  if (!why) return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `trace guard: ${why}. If it is really needed, ask the user to run it.`,
    },
  }
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
try {
  const out = handle(process.argv[2], input ?? {})
  if (out) process.stdout.write(JSON.stringify(out))
} catch (err) {
  // Fail open: a broken hook must never wedge the session.
  process.stderr.write(`trace hook: ${/** @type {Error} */ (err).message}\n`)
}
