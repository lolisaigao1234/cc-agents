#!/usr/bin/env node
// Required checks (eval variant v1, idea checks-block-pr): red blocks the PR,
// enforced by a gate rather than prose. `node checks.mjs <event>`:
//
//   pre-tool-use  denies `gh pr create` and `gh pr ready` while the checks are red at HEAD.
//   stop          blocks the agent from handing the PR over while they are red at HEAD:
//                 once per head commit, so a head it cannot make green still lets it stop
//                 and explain, and every new red head is refused again.
//
// The checks are the repository's full check suite (each step of package.json's
// `check` script, run one by one so an early failure does not hide a later one),
// run like CI: on a clean checkout of the commit. Red means a failure the
// branch's base does not also have, so a check the base already fails, for a
// reason outside the PR, does not trap the agent. Results are cached per
// commit in git's own directory.
//
// Any input it does not expect, and any failure of its own, lets the call through.

import { join } from 'node:path'

import { baseOf, clip, compare, finish, git, readInput, readJson, resultsAt, stateDir, tracedRepo, writeJson } from './common.mjs'

const PER_STEP_MS = 240_000
// Inside the hook's 1200 s timeout in hooks.json, with room to clean up.
const DEADLINE = Date.now() + 1_100_000
// At a command's start, after quoted text is taken out, so a commit message or
// comment body that mentions it is not taken for it.
const PR_HANDOFF = /(?:^|[;&|({\n]|\$\()\s*(?:\w+=\S*\s+)*gh\s+pr\s+(?:create|ready)\b(?![^;&|\n]*--undo)/
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g

/** @param {Record<string, string>} scripts @returns {string[]} the full suite's steps */
function steps(scripts) {
  if (typeof scripts.check === 'string' && scripts.check.trim()) {
    return scripts.check.split('&&').map(s => s.trim()).filter(Boolean)
  }
  return ['typecheck', 'test', 'lint', 'build']
    .filter(s => typeof scripts[s] === 'string')
    .map(s => (s === 'test' ? 'npm test' : `npm run ${s}`))
}

/**
 * What is red at HEAD that is not red at its base, or null when nothing is
 * (or when it cannot tell).
 *
 * @param {string} root
 * @returns {{ head: string, text: string } | null}
 */
function redAtHead(root) {
  const head = git(['rev-parse', 'HEAD'], root)
  const state = stateDir(root)
  if (!head || !state) return null
  const base = baseOf(root, head)
  if (!base || base === head) return null
  const atHead = resultsAt(root, head, state, 'suite', steps, PER_STEP_MS, DEADLINE)
  if (!atHead || atHead.steps.every(s => s.ok)) return null
  const atBase = resultsAt(root, base, state, 'suite', steps, PER_STEP_MS, DEADLINE)
  const { red, already } = compare(atHead.steps, atBase?.steps)
  if (!red.length) return null
  const parts = red.map(s => [
    `\`${s.step}\` fails${s.fresh.length ? `, newly at this head:\n${s.fresh.slice(0, 15).map(l => `  ${l}`).join('\n')}` : ''}`,
    `Its output ends:\n${clip(s.tail, 3_000)}`,
  ].join('\n'))
  const note = already.length ? `\n\nAlso failing at the branch's base, so not blocking: ${already.map(s => `\`${s}\``).join(', ')}.` : ''
  return {
    head,
    text: `Required checks are red at ${head.slice(0, 7)} (run on a clean checkout of that commit; uncommitted changes are not part of it).\n\n${parts.join('\n\n')}${note}`,
  }
}

/** @param {string | undefined} event @param {any} input @returns {object | null} */
function output(event, input) {
  if (!input) return null
  if (event === 'pre-tool-use') {
    if (input.tool_name !== 'Bash') return null
    const command = String(input.tool_input?.command ?? '')
    if (!PR_HANDOFF.test(command.replace(QUOTED, "''"))) return null
    const root = tracedRepo(input.cwd)
    const red = root && redAtHead(root)
    if (!red) return null
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `trace checks: ${red.text}\n\nReview step: make them green and commit before the PR is ready.`,
      },
    }
  }
  if (event === 'stop') {
    const root = tracedRepo(input.cwd)
    const red = root && redAtHead(root)
    if (!red || !root) return null
    const state = stateDir(root)
    if (!state) return null
    const asked = join(state, 'stop-blocked.json')
    const heads = readJson(asked)
    const seen = Array.isArray(heads) ? heads : []
    if (seen.includes(red.head)) return null
    writeJson(asked, [...seen, red.head])
    return {
      decision: 'block',
      reason: `trace checks: ${red.text}\n\nReview step: the PR is not ready while its checks are red. Fix them, commit and push, and say in the progress comment what you ran and what it printed. If one cannot be made green in this PR, say why in the progress comment.`,
    }
  }
  return null
}

let out = null
try {
  out = output(process.argv[2], readInput())
} catch {
  out = null
}
finish(out)
