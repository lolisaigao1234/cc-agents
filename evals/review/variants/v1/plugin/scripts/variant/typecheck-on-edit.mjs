#!/usr/bin/env node
// PostToolUse on Edit, Write and MultiEdit (eval variant v1, idea
// format-lint-hooks): after an edit of a code or config file in a traced
// repository, run the repository's static checks (its type checks, and a
// linter or formatter check where package.json has one) on the working tree
// and hand any failure back to the agent at once, so those errors never reach
// review.
//
// It speaks only of failures that are its branch's own: a failure the branch's
// base has too (checked once, on a clean checkout of the base) is left out, and
// the same failures as last reported stay quiet, so an error the agent cannot
// fix here does not repeat on every edit. Any input it does not expect, and any
// failure of its own, says nothing.

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { baseOf, clip, compare, failureLines, finish, git, readInput, readJson, resultsAt, runCheck, scriptsOf, stateDir, tracedRepo, writeJson } from './common.mjs'

const STATIC = ['typecheck', 'typecheck:mod', 'lint', 'format:check']
const CODE = /\.(?:[cm]?[jt]sx?|json)$/i
const PER_SCRIPT_MS = 90_000
// Inside the hook's 300 s timeout in hooks.json, with room to clean up.
const DEADLINE = Date.now() + 270_000

// A script that is one plain `tsc` call (no build mode, no other commands).
const PLAIN_TSC = /^\s*tsc\b(?![^;&|<>]*\s(?:-b|--build)\b)[^;&|<>`$]*$/

/**
 * The static checks, each as a command. A plain tsc script is told not to
 * emit: these run in the agent's working tree, and a tsconfig without
 * `noEmit` would otherwise write compiled files into the PR on every edit.
 *
 * @param {Record<string, string>} scripts @returns {string[]}
 */
const commandsOf = scripts => STATIC.filter(s => typeof scripts[s] === 'string')
  .map(s => `npm run --silent ${JSON.stringify(s)}${PLAIN_TSC.test(scripts[s]) ? ' -- --noEmit' : ''}`)

/** @param {any} input @returns {object | null} */
function output(input) {
  if (!input || !['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) return null
  const raw = input.tool_input?.file_path
  if (typeof raw !== 'string' || !CODE.test(raw)) return null
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd()
  const file = resolve(cwd, raw)
  const root = tracedRepo(dirname(file)) ?? tracedRepo(cwd)
  if (!root) return null
  const rel = relative(root, file)
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).includes('node_modules')) return null
  const commands = commandsOf(scriptsOf(root))
  if (!commands.length) return null

  const now = []
  for (const step of commands) {
    const left = DEADLINE - Date.now()
    if (left < 5_000) return null
    const r = runCheck(step, root, Math.min(PER_SCRIPT_MS, left))
    if (r.timedOut && left < PER_SCRIPT_MS) return null
    now.push({ step, ok: r.ok, lines: r.ok ? [] : failureLines(r.output, root), tail: r.ok ? '' : r.output.trim() })
  }
  const state = stateDir(root)
  const memo = state && join(state, 'static-last.json')
  let red = now.filter(s => !s.ok).map(s => ({ ...s, fresh: s.lines }))
  if (red.length && state) {
    const head = git(['rev-parse', 'HEAD'], root)
    const base = head && baseOf(root, head)
    const atBase = base ? resultsAt(root, base, state, 'static', commandsOf, PER_SCRIPT_MS, DEADLINE) : null
    if (atBase) red = compare(now, atBase.steps).red
  }
  const key = red.map(s => `${s.step}\0${s.fresh.join('\n')}`).join('\0\0')
  const last = memo ? readJson(memo) : null
  if (memo) writeJson(memo, { key })
  if (!red.length || (last && last.key === key)) return null
  const shown = red.map(s => `\`${s.step.replace(' --silent', '').replace(' -- --noEmit', '').replace(/"/g, '')}\` failed:\n${clip(s.tail, 3_000)}`).join('\n\n')
  return {
    decision: 'block',
    reason: `Static checks after your edit of ${rel} (failures the branch's base also has are left out):\n\n${shown}\n\nFix these before review.`,
  }
}

let out = null
try {
  out = output(readInput())
} catch {
  out = null
}
finish(out)
