#!/usr/bin/env node
// Eval variant v5 (E-author-response): a PR is not ready while a finding of
// the bug review or the security review is still open.
//
//   node findings.mjs record   PostToolUse on Skill|ReportFindings: number each
//                              finding /code-review or /security-review reports
//                              (F1, F2, ...) in a ledger in the repository's git dir
//   node findings.mjs gate     PreToolUse on Bash: deny `gh pr create|ready|merge`
//                              while a finding is open
//   node findings.mjs stop     Stop: block stopping while a finding is open, once a
//                              session (like the trace's own Stop nudge), so a stop
//                              to ask the human is not pushed into another round
//
// A finding is answered by a line of a comment on the linked issue that starts
// with its id, `F3: fixed in <sha>` (a commit on this branch made after the
// review that raised it) or `F3: declined: <reason>`. Other prose never answers one.
// Fails open: an input, git or GitHub it cannot read lets the call through.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STOP_BLOCKS = 1
const REVIEWS = /^\/?(code-review|security-review)$/

/** @param {string} cmd @param {string[]} args @param {string} cwd @returns {string | null} */
function out(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null
}
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => out('git', args, cwd)?.trim() || null

/** The traced repository at `cwd`, its branch and its issue number; null when there is none. */
function place(/** @type {string} */ cwd) {
  if (process.env.TRACE_BYPASS === '1') return null
  const root = git(cwd, 'rev-parse', '--show-toplevel')
  if (!root || !existsSync(join(root, '.claude/trace.json'))) return null
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir')
  const branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  if (!gitDir || !branch) return null
  const n = /^(\d+)-/.exec(branch)?.[1]
  return { root, ledgerPath: join(gitDir, 'trace-findings.json'), branch, n: n ? Number(n) : null }
}

/** `head` is the commit the review ran on; ledgers written before it was kept have none. */
/** @typedef {{ id: string, file: string, line: number | null, summary: string, source: string, head?: string }} Finding */
/** @typedef {{ branches: Record<string, { next: number, findings: Finding[] }>, stops: Record<string, number> }} Ledger */

/** @returns {Ledger} */
function load(/** @type {string} */ p) {
  try {
    const l = JSON.parse(readFileSync(p, 'utf8'))
    if (l && typeof l === 'object' && l.branches && typeof l.branches === 'object' && l.stops && typeof l.stops === 'object') return l
  } catch {}
  return { branches: {}, stops: {} }
}
function save(/** @type {string} */ p, /** @type {Ledger} */ l) {
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n')
  renameSync(tmp, p)
}

/** Every string inside a tool response, however it is nested. */
function strings(/** @type {unknown} */ v, depth = 0, /** @type {string[]} */ acc = []) {
  if (depth > 6) return acc
  if (typeof v === 'string') acc.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, depth + 1, acc)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, depth + 1, acc)
  return acc
}

/** The findings in a review's JSON output: arrays of objects with a summary. */
function findingsIn(/** @type {string} */ text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1])
  if (!blocks.length) {
    const a = text.indexOf('['), b = text.lastIndexOf(']')
    if (a >= 0 && b > a) blocks.push(text.slice(a, b + 1))
  }
  /** @type {{ file: string, line: number | null, summary: string }[]} */
  const found = []
  for (const block of blocks) {
    let parsed
    try { parsed = JSON.parse(block) } catch { continue }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : []
    for (const f of list) {
      const summary = typeof f?.summary === 'string' ? f.summary : typeof f?.description === 'string' ? f.description : typeof f?.title === 'string' ? f.title : ''
      if (!summary.trim()) continue
      const line = Number.isInteger(f.line) ? f.line : Number.isInteger(Number(f.line)) && f.line !== '' && f.line != null ? Number(f.line) : null
      found.push({ file: typeof f.file === 'string' ? f.file : '', line, summary: summary.trim() })
    }
  }
  return found
}

/**
 * An answer line, as announced: an optional list bullet and bold, the ids
 * (`F3`, `F3, F4`, `F3 and F4`), then `fixed in <sha>` or `declined: <reason>`.
 */
const ANSWER = /^\s*(?:[-*+]\s+)?(?:\*\*)?(F\d+(?:\s*(?:,|and|&)\s*F\d+)*)(?:\*\*)?\s*[:\u2013\u2014-]?\s*(?:\*\*)?\s*(?:fixed in\s+`?([0-9a-f]{7,40})\b`?|declined\b\s*:?\s*(.*\S)?)/i

const label = (/** @type {Finding} */ f) => `${f.id} (${f.file || '?'}${f.line != null ? `:${f.line}` : ''}: ${f.summary.length > 140 ? `${f.summary.slice(0, 140)}…` : f.summary})`
const howTo = (/** @type {number | null} */ n) => `answer each in a progress comment on #${n ?? '<n>'}, one line per finding, starting with its id: \`F3: fixed in <sha>\` (a commit on this branch made after the review that raised it) or \`F3: declined: <reason>\``

/** PostToolUse: number and record the findings a bug or security review reported. */
function record(/** @type {any} */ input) {
  const tool = String(input.tool_name ?? '')
  let source, texts
  if (tool === 'Skill') {
    const skill = String(input.tool_input?.skill ?? input.tool_input?.command ?? '').trim()
    const m = REVIEWS.exec(skill)
    if (!m) return null
    source = `/${m[1]}`
    texts = strings(input.tool_response)
  } else if (tool === 'ReportFindings') {
    source = '/code-review'
    texts = [JSON.stringify(input.tool_input?.findings ?? [])]
  } else return null
  const at = place(String(input.cwd ?? process.cwd()))
  if (!at) return null
  const found = texts.flatMap(findingsIn)
  if (!found.length) return null
  const ledger = load(at.ledgerPath)
  const mine = (ledger.branches[at.branch] ??= { next: 1, findings: [] })
  const head = git(at.root, 'rev-parse', 'HEAD') ?? undefined
  const key = (/** @type {{ file: string, line: number | null, summary: string }} */ f) => `${f.file}\0${f.line}\0${f.summary}`
  const known = new Set(mine.findings.map(key))
  /** @type {Finding[]} */
  const added = []
  for (const f of found) {
    if (known.has(key(f))) continue
    known.add(key(f))
    const finding = { id: `F${mine.next++}`, ...f, source, head }
    mine.findings.push(finding)
    added.push(finding)
  }
  if (!added.length) return null
  save(at.ledgerPath, ledger)
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `trace: ${source} findings recorded as ${added.map(f => f.id).join(', ')}: ${added.map(label).join('; ')}. The PR is not ready while one is open: ${howTo(at.n)}. The ledger is ${at.ledgerPath}.`,
    },
  }
}

/** The findings on this branch that no comment on the linked issue answers; null when that cannot be told. */
function open(/** @type {string} */ cwd) {
  const at = place(cwd)
  if (!at || at.n == null) return null
  const findings = load(at.ledgerPath).branches[at.branch]?.findings ?? []
  if (!findings.length) return { at, open: [] }
  const raw = out('gh', ['api', '--paginate', `repos/{owner}/{repo}/issues/${at.n}/comments`, '--jq', '.[].body'], at.root)
  if (raw == null) return null
  /** @type {Map<string, string[]>} id -> the SHAs its lines say fixed it */
  const fixedIn = new Map()
  /** @type {Set<string>} */
  const declined = new Set()
  for (const line of raw.split('\n')) {
    const m = ANSWER.exec(line)
    if (!m) continue
    const ids = [...m[1].matchAll(/F(\d+)/gi)].map(x => `F${Number(x[1])}`)
    if (m[2]) for (const id of ids) fixedIn.set(id, [...(fixedIn.get(id) ?? []), m[2]])
    else if (/[A-Za-z0-9]/.test(m[3] ?? '')) for (const id of ids) declined.add(id)
  }
  /** @type {Map<string, number | null>} */
  const asked = new Map()
  /** `git merge-base --is-ancestor a b`: 0 yes, 1 no, anything else unknown. */
  const ancestor = (/** @type {string} */ a, /** @type {string} */ b) => {
    const k = `${a}\0${b}`
    if (!asked.has(k)) asked.set(k, spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: at.root, timeout: 20_000 }).status)
    return asked.get(k)
  }
  /** A fix is a commit on this branch that the review which raised the finding had not seen (when git cannot tell, it counts). */
  const fixes = (/** @type {Finding} */ f, /** @type {string} */ sha) =>
    ancestor(sha, 'HEAD') === 0 && (typeof f.head !== 'string' || ancestor(sha, f.head) !== 0)
  const answered = new Set(findings.filter(f => declined.has(f.id) || (fixedIn.get(f.id) ?? []).some(sha => fixes(f, sha))).map(f => f.id))
  return { at, open: findings.filter(f => !answered.has(f.id)) }
}

/** PreToolUse on Bash: no PR is created, marked ready or merged over an open finding. */
function gate(/** @type {any} */ input) {
  const command = String(input.tool_input?.command ?? '')
  if (!/\bgh\s+pr\s+(create|ready|merge)\b/.test(command)) return null
  const o = open(String(input.cwd ?? process.cwd()))
  if (!o || !o.open.length) return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `trace: findings still open: ${o.open.map(label).join('; ')}. Review step: fix or decline them, then ${howTo(o.at.n)}.`,
    },
  }
}

/** Stop: the PR is not ready for the human while a finding is open. */
function stop(/** @type {any} */ input) {
  if (input.stop_hook_active === true) return null
  const o = open(String(input.cwd ?? process.cwd()))
  if (!o || !o.open.length) return null
  const ledger = load(o.at.ledgerPath)
  const session = String(input.session_id ?? 'unknown')
  const blocks = ledger.stops[session] ?? 0
  if (blocks >= STOP_BLOCKS) return null
  ledger.stops[session] = blocks + 1
  save(o.at.ledgerPath, ledger)
  return {
    decision: 'block',
    reason: `trace: the PR is not ready while findings are open: ${o.open.map(label).join('; ')}. Review step: fix or decline each, then ${howTo(o.at.n)}. If you are stopping to ask the human instead (the PR is not ready), name the open ids in your final message and stop.`,
  }
}

const HANDLERS = { record, gate, stop }

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const handler = HANDLERS[/** @type {keyof typeof HANDLERS} */ (process.argv[2])]
  const result = handler && input && typeof input === 'object' ? handler(input) : null
  if (result) process.stdout.write(JSON.stringify(result))
} catch (err) {
  // Fail open: a broken variant hook must never wedge the session.
  process.stderr.write(`trace findings hook: ${/** @type {Error} */ (err)?.message ?? err}\n`)
}
