#!/usr/bin/env node
// Variant v6 (F-convergence): the review round cap, and a review bound to the
// commit it ran on. `node rounds.mjs <event>`, with the hook input as JSON on
// stdin and the hook output as JSON on stdout.
//
// - pre-tool-use, Skill `code-review` (Claude Code's /code-review, not Matt's):
//   counts the session's review rounds and records the HEAD each one ran on. A
//   fourth round is denied until the human's next prompt.
// - pre-tool-use, Bash `gh pr ready`: denied once per HEAD when commits landed
//   after the last review.
// - stop: blocks stopping once per HEAD when commits landed after the last review.
// - user-prompt-submit: the human's prompt lifts the cap.
//
// Acts only in traced repositories (`.claude/trace.json` at the root), and not
// under TRACE_BYPASS=1. It fails open: when git does not answer or the input is
// unexpected it says nothing, since the trace's own hook owns the halt.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CAP = 3
const BUG_REVIEW = /^\/?code-review\b/
// A background agent's report arrives as a prompt the human did not write.
const NOTIFICATION = /^\s*<task-notification>/

/** @param {string} cwd @param {string[]} args @returns {string | null} */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })
  return r.status === 0 ? r.stdout.trim() : null
}

/** @param {string} cwd @returns {string | null} the traced repository's root */
function tracedRoot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  return root && existsSync(join(root, '.claude/trace.json')) ? root : null
}

/** @param {unknown} session @param {string} root */
function stateFile(session, root) {
  const key = createHash('sha256').update(`${String(session)}\0${root}`).digest('hex').slice(0, 32)
  return join(tmpdir(), 'trace-variant-rounds', `${key}.json`)
}

/** @param {string} file @returns {{ rounds: number, reviewed: string | null, nudged: string[] }} */
function load(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return {
      rounds: Number.isInteger(s.rounds) && s.rounds >= 0 ? s.rounds : 0,
      reviewed: typeof s.reviewed === 'string' ? s.reviewed : null,
      nudged: Array.isArray(s.nudged) ? s.nudged.filter(x => typeof x === 'string') : [],
    }
  } catch {
    return { rounds: 0, reviewed: null, nudged: [] }
  }
}

/** @param {string} file @param {object} state */
function save(file, state) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}

const short = (/** @type {string} */ sha) => sha.slice(0, 7)

/** @param {string} root @param {string} reviewed @param {string} head */
function unreviewed(root, reviewed, head) {
  const n = git(root, ['rev-list', '--count', `${reviewed}..${head}`])
  return n && n !== '0' ? `${n} commit${n === '1' ? '' : 's'} (${short(reviewed)}..${short(head)})` : `HEAD ${short(head)} (the last review ran on ${short(reviewed)})`
}

/** @param {string} reason */
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

/**
 * @param {string | undefined} event
 * @param {{ tool_name?: unknown, tool_input?: any, cwd?: unknown, session_id?: unknown, prompt?: unknown, stop_hook_active?: unknown }} input
 * @returns {object | null}
 */
function handle(event, input) {
  if (process.env.TRACE_BYPASS === '1') return null
  if (typeof input.session_id !== 'string' || !input.session_id) return null
  const root = tracedRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd())
  if (!root) return null
  const file = stateFile(input.session_id, root)

  if (event === 'user-prompt-submit') {
    if (NOTIFICATION.test(String(input.prompt ?? ''))) return null
    const state = load(file)
    if (state.rounds) save(file, { ...state, rounds: 0 })
    return null
  }

  const head = git(root, ['rev-parse', 'HEAD'])
  if (!head) return null

  if (event === 'pre-tool-use' && input.tool_name === 'Skill') {
    const ti = input.tool_input ?? {}
    if (!BUG_REVIEW.test(String(ti.skill ?? ti.command ?? '').trim())) return null
    const state = load(file)
    if (state.rounds >= CAP) {
      return deny(`trace: ${state.rounds} review rounds have run (the last on ${state.reviewed ? short(state.reviewed) : 'an unknown commit'}), and the cap is ${CAP}. Step back and reconsider the approach instead of reviewing again. Answer every open finding with a fix or, in the progress comment, a reason; if another round is still needed, ask the human in the progress comment. The human's reply lifts the cap.`)
    }
    save(file, { ...state, rounds: state.rounds + 1, reviewed: head })
    return null
  }

  if (event === 'pre-tool-use' && input.tool_name === 'Bash') {
    const command = String(input.tool_input?.command ?? '')
    // gh's flags may come before `pr` (`gh -R o/r pr ready`).
    if (!/(?:^|[\s;&|(])gh(?:\s+-{1,2}\w[\w-]*(?:[=\s]+[^\s-]\S*)?)*\s+pr\s+ready\b/.test(command) || /--undo\b/.test(command)) return null
    const state = load(file)
    if (!state.reviewed || state.reviewed === head || state.nudged.includes(`ready:${head}`)) return null
    save(file, { ...state, nudged: [...state.nudged, `ready:${head}`] })
    return deny(`trace: a review covers the commit it ran on, and ${unreviewed(root, state.reviewed, head)} landed after the last review. Review step: review them, or say in the progress comment why they need none. This asks once.`)
  }

  if (event === 'stop') {
    // No `stop_hook_active` early return: in `claude -p` it stays true after any
    // Stop block, which would hide every later commit. The once-per-HEAD key
    // below bounds the loop, since each further block needs a new commit.
    const state = load(file)
    if (!state.reviewed || state.reviewed === head || state.nudged.includes(`stop:${head}`)) return null
    save(file, { ...state, nudged: [...state.nudged, `stop:${head}`] })
    const capped = state.rounds >= CAP ? ` The round cap stands (${state.rounds} rounds), so name those commits as unreviewed in the progress comment and ask the human for another round.` : ''
    return { decision: 'block', reason: `trace: a review covers the commit it ran on, and ${unreviewed(root, state.reviewed, head)} landed after the last review, so the PR is not ready. Review step: review them, or say in the progress comment why they need none.${capped} This asks once.` }
  }
  return null
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
try {
  const out = input && typeof input === 'object' ? handle(process.argv[2], input) : null
  if (out) process.stdout.write(JSON.stringify(out))
} catch (err) {
  // Fail open: a broken variant hook must never wedge the session.
  process.stderr.write(`trace variant rounds: ${/** @type {Error} */ (err)?.message}\n`)
}
