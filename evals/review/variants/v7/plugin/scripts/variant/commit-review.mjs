#!/usr/bin/env node
// Variant v7 (continuous-review-per-commit): review runs like spellcheck, not
// only as a gate at the end. After a Bash call that made a commit in a traced
// repository, this PostToolUse hook asks the agent to run `/code-review` on
// that commit alone and fix what it finds before moving on.
//
// A nudge, not a gate: it asks once per commit, and whenever it cannot tell
// (no git, no repository, an input it does not know) it says nothing. It never
// halts and never fails the session.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// How recent the commit must be to be the one this call made.
const FRESH_S = 600

// `git commit` at the start of a command (the line, or after a separator), past
// any `VAR=value` prefixes and an optional `-C <dir>` or other global options.
// A `git commit` mid-sentence, as in quoted text, is not one.
const COMMIT = /(?:^|[\n;&|(`]|\$\()\s*(?:\w+=\S*\s+)*git((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?|-[pP]))*)\s+commit(?=\s|$|[;&|)`])/

/** @param {string} cwd @param {string[]} args @returns {string | null} git's stdout, or null when git gives no clean answer */
function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/** @param {string} s */
const unquote = s => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

/**
 * Where the commit was made: the call's cwd, moved by a leading `cd <dir> &&`
 * and by git's own `-C <dir>`.
 *
 * @param {string} command @param {string} cwd @param {string} globals
 */
function commitDir(command, cwd, globals) {
  let dir = cwd
  const cd = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/.exec(command)
  if (cd?.[1]) dir = resolve(dir, unquote(cd[1]))
  for (const m of globals.matchAll(/-C\s+("[^"]*"|'[^']*'|\S+)/g)) dir = resolve(dir, unquote(m[1] ?? ''))
  return dir
}

/** @param {unknown} sessionId @param {string} sha @returns {boolean} true the first time this session sees `sha` */
function firstTime(sessionId, sha) {
  try {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : 'no-session'
    const dir = join(tmpdir(), 'trace-variant-commit-review')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`)
    let seen = []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) seen = parsed.filter(x => typeof x === 'string')
    } catch {}
    if (seen.includes(sha)) return false
    writeFileSync(file, JSON.stringify([...seen, sha].slice(-500)))
    return true
  } catch {
    // A record that cannot be kept still asks; asking twice is the lesser harm.
    return true
  }
}

/** @param {any} input @returns {object | null} */
function commitReview(input) {
  if (process.env.TRACE_BYPASS === '1') return null
  if (!input || typeof input !== 'object' || input.tool_name !== 'Bash') return null
  const command = input.tool_input?.command
  if (typeof command !== 'string') return null
  const m = COMMIT.exec(command)
  if (!m) return null
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd()
  const dir = commitDir(command, cwd, m[1] ?? '')
  const root = git(dir, ['rev-parse', '--show-toplevel'])
  if (!root || !existsSync(join(root, '.claude', 'trace.json'))) return null
  // HEAD's newest reflog entry says whether a commit was made, and when.
  const entry = git(root, ['reflog', '-1', '--date=unix', '--format=%H%x09%gd%x09%gs', 'HEAD'])
  const [sha, selector, subject] = (entry ?? '').split('\t')
  if (!sha || !/^[0-9a-f]{7,64}$/.test(sha) || !subject?.startsWith('commit')) return null
  const at = Number(/@\{(\d+)\}/.exec(selector ?? '')?.[1])
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > FRESH_S) return null
  if (!firstTime(input.session_id, sha)) return null
  const short = sha.slice(0, 12)
  return {
    decision: 'block',
    reason: `trace (spellcheck review): you just committed ${short}. Run \`/code-review\` on that commit alone (its diff against its parent, \`git show ${short}\`) now, before you move on, and answer each finding with a fix or a reason. This review is part of the current round, not a new one; a commit whose review finds nothing to fix ends the chain.`,
  }
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
try {
  if (process.argv[2] === 'seed') {
    // SessionStart: HEAD as the session finds it was not made by this session,
    // so it must never read as "just committed".
    const cwd = typeof input?.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd()
    const head = git(cwd, ['rev-parse', 'HEAD'])
    if (head && /^[0-9a-f]{7,64}$/.test(head)) firstTime(input?.session_id, head)
    process.exit(0)
  }
  const out = commitReview(input)
  if (out) process.stdout.write(JSON.stringify(out))
} catch (err) {
  // Fail safe: a broken nudge must never wedge the session.
  process.stderr.write(`trace variant hook: ${/** @type {Error} */ (err)?.message ?? err}\n`)
}
