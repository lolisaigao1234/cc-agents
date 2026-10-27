// The findings ledger: every issue a bug hunter reported, deduplicated across
// lenses and rounds, with the votes that confirmed or rejected it. Pure: the
// caller injects file contents and the parsed diff.

import { rangeTouches } from './diff.mjs'
import { matchesAny, normalizePath } from './glob.mjs'

export const SEVERITIES = /** @type {const} */ (['important', 'nit'])

/**
 * @typedef {'candidate' | 'confirmed' | 'rejected' | 'fixed' | 'wontfix' | 'stuck'} FindingStatus
 * @typedef {{ voter: string, verdict: 'confirm' | 'reject', reason: string, severity?: 'important' | 'nit' }} Vote
 * @typedef {{
 *   id: string, fingerprint: string, title: string, file: string, line: number, endLine: number,
 *   quote: string, category: string, severity: 'important' | 'nit', bugClass: string,
 *   explanation: string, failureScenario: string, suggestedFix: string, confidence: number,
 *   origin: 'introduced' | 'pre-existing', status: FindingStatus, lenses: string[],
 *   votes: Vote[], attempts: number, reopens: number, firstRound: number, lastRound: number,
 *   resolution: string, confirmedRound?: number,
 * }} Finding
 * @typedef {{ nextId: number, findings: Record<string, Finding> }} Ledger
 * @typedef {{ skipPaths?: string[], dropCategories?: string[], maxNitsPerRound?: number }} IngestConfig
 * @typedef {{
 *   round: number, lens: string, diffFiles: import('./diff.mjs').DiffFile[],
 *   readLines: (path: string) => string[] | null, config: IngestConfig,
 * }} IngestContext
 */

/** @returns {Ledger} */
export function newLedger() {
  return { nextId: 1, findings: {} }
}

/** @param {unknown} s */
const isText = s => typeof s === 'string' && s.trim() !== ''

/**
 * @param {any} raw
 * @returns {{ ok: true, errors: [] } | { ok: false, errors: string[] }}
 */
export function validateFinding(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] }
  for (const k of ['title', 'file', 'category', 'explanation']) {
    if (!isText(raw[k])) errors.push(`${k} is required`)
  }
  if (!isText(raw.quote)) errors.push('quote is required: copy the offending code exactly')
  if (!Number.isInteger(raw.line) || raw.line < 1) errors.push('line must be a positive integer')
  if (raw.endLine !== undefined && (!Number.isInteger(raw.endLine) || raw.endLine < raw.line)) {
    errors.push('endLine must be an integer >= line')
  }
  if (!SEVERITIES.includes(raw.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`)
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] }
}

/** @param {string} s */
export function normalizeQuote(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/** @param {string} s */
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** FNV-1a, 32-bit, as hex. @param {string} s */
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Line-insensitive identity: the file, the offending code and the class of
 * bug. Line numbers drift as fixes land; the quoted code does not.
 *
 * @param {Record<string, unknown> & { file: string, quote: string, bugClass?: string, category: string }} f
 */
export function fingerprint(f) {
  return hash(`${normalizePath(f.file)}|${normalizeQuote(f.quote)}|${slug(f.bugClass || f.category)}`)
}

// A quote within this many lines of the cited line is relocated to where it
// actually is; further away, the finding is refused.
const RELOCATE_WINDOW = 25

/**
 * Checks a finding's evidence against the file: the quoted code must appear
 * at (or near) the cited line. A quote that drifted is relocated to its
 * nearest occurrence; one that is not near the line at all is a
 * hallucination and is refused.
 *
 * @param {{ line: number, endLine?: number, quote: string }} f
 * @param {string[] | null} lines
 * @returns {{ ok: true, line: number } | { ok: false, reason: string }}
 */
export function checkEvidence(f, lines) {
  if (lines === null) return { ok: false, reason: 'file-missing' }
  if (f.line > lines.length) return { ok: false, reason: 'line-out-of-range' }
  const quote = normalizeQuote(f.quote)
  const quoteLines = Math.max(1, f.quote.trim().split('\n').length)
  /** @param {number} start 1-based */
  const startsAt = start =>
    normalizeQuote(lines.slice(start - 1, start - 1 + quoteLines).join(' ')).includes(quote)
  for (let d = 0; d <= RELOCATE_WINDOW; d++) {
    for (const cand of d === 0 ? [f.line] : [f.line - d, f.line + d]) {
      if (cand >= 1 && cand <= lines.length && startsAt(cand)) return { ok: true, line: cand }
    }
  }
  return { ok: false, reason: 'quote-not-found' }
}

/**
 * Whether two findings describe the same issue: the same identity; the same
 * offending code and category (two lenses naming one bug with different
 * labels); or the same bug class on overlapping lines. Different code on
 * nearby lines is kept apart: adjacent lines often hold distinct bugs, and
 * a duplicate costs one extra vote where a wrong merge loses a bug.
 *
 * @param {Pick<Finding, 'file' | 'fingerprint' | 'category' | 'bugClass' | 'line' | 'endLine' | 'quote'>} a
 * @param {Pick<Finding, 'file' | 'fingerprint' | 'category' | 'bugClass' | 'line' | 'endLine' | 'quote'>} b
 */
export function isSameIssue(a, b) {
  if (a.fingerprint === b.fingerprint) return true
  if (normalizePath(a.file) !== normalizePath(b.file)) return false
  if (normalizeQuote(a.quote) === normalizeQuote(b.quote) && a.category === b.category) return true
  return a.bugClass === b.bugClass && a.line <= b.endLine + 2 && b.line <= a.endLine + 2
}

/**
 * @param {Ledger} ledger
 * @param {any[]} raws
 * @param {IngestContext} ctx
 */
export function ingestFindings(ledger, raws, ctx) {
  const report = {
    /** @type {string[]} */ accepted: [],
    /** @type {string[]} */ merged: [],
    /** @type {string[]} */ repeats: [],
    /** @type {string[]} */ reopened: [],
    /** @type {{ title: string, file: string, reason: string, detail?: string }[]} */ rejected: [],
  }
  const skip = ctx.config.skipPaths ?? []
  const drop = (ctx.config.dropCategories ?? []).map(slug)
  /** @type {Finding[]} */
  const fresh = []

  for (const raw of raws) {
    const v = validateFinding(raw)
    const label = { title: String(raw?.title ?? '?'), file: String(raw?.file ?? '?') }
    if (!v.ok) {
      report.rejected.push({ ...label, reason: 'invalid', detail: v.errors.join('; ') })
      continue
    }
    const file = normalizePath(raw.file)
    if (matchesAny(file, skip)) {
      report.rejected.push({ ...label, reason: 'skip-path' })
      continue
    }
    if (drop.includes(slug(raw.category))) {
      report.rejected.push({ ...label, reason: 'dropped-category' })
      continue
    }
    const ev = checkEvidence(raw, ctx.readLines(file))
    if (!ev.ok) {
      report.rejected.push({ ...label, reason: ev.reason })
      continue
    }
    const span = Math.max(0, (raw.endLine ?? raw.line) - raw.line)
    const line = ev.line
    const endLine = line + span
    const diffFile = ctx.diffFiles.find(d => d.path === file)
    /** @type {Finding} */
    const f = {
      id: '',
      fingerprint: '',
      title: raw.title.trim(),
      file,
      line,
      endLine,
      quote: raw.quote,
      category: slug(raw.category),
      severity: raw.severity,
      bugClass: slug(raw.bugClass || raw.category),
      explanation: raw.explanation,
      failureScenario: String(raw.failureScenario ?? ''),
      suggestedFix: String(raw.suggestedFix ?? ''),
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
      origin: diffFile && rangeTouches(diffFile, line, endLine, 1) ? 'introduced' : 'pre-existing',
      status: 'candidate',
      lenses: [ctx.lens],
      votes: [],
      attempts: 0,
      reopens: 0,
      firstRound: ctx.round,
      lastRound: ctx.round,
      resolution: '',
    }
    f.fingerprint = fingerprint(f)

    const existing = Object.values(ledger.findings).find(o => isSameIssue(o, f))
    if (existing) {
      existing.lastRound = ctx.round
      if (!existing.lenses.includes(ctx.lens)) existing.lenses.push(ctx.lens)
      if (existing.status === 'rejected' || existing.status === 'wontfix') {
        report.repeats.push(existing.id)
      } else if (existing.status === 'fixed') {
        // A fix that did not hold: verify it again from scratch.
        existing.status = 'candidate'
        existing.votes = []
        existing.reopens += 1
        existing.line = f.line
        existing.endLine = f.endLine
        report.reopened.push(existing.id)
      } else {
        report.merged.push(existing.id)
      }
      continue
    }
    const dup = fresh.find(o => isSameIssue(o, f))
    if (dup) {
      if (!dup.lenses.includes(ctx.lens)) dup.lenses.push(ctx.lens)
      continue
    }
    fresh.push(f)
  }

  const maxNits = ctx.config.maxNitsPerRound ?? Infinity
  const alreadyThisRound = Object.values(ledger.findings).filter(
    o => o.severity === 'nit' && o.firstRound === ctx.round,
  ).length
  const nits = fresh.filter(f => f.severity === 'nit').sort((a, b) => b.confidence - a.confidence)
  const keptNits = new Set(nits.slice(0, Math.max(0, maxNits - alreadyThisRound)))
  for (const f of fresh) {
    if (f.severity === 'nit' && !keptNits.has(f)) {
      report.rejected.push({ title: f.title, file: f.file, reason: 'nit-cap' })
      continue
    }
    f.id = `F${ledger.nextId++}`
    ledger.findings[f.id] = f
    report.accepted.push(f.id)
  }
  return { ledger, report }
}

/**
 * @param {Vote[]} votes
 * @param {{ verifiers: number, quorum: number }} opts
 * @returns {'confirmed' | 'rejected' | 'undecided'}
 */
export function tallyVotes(votes, opts) {
  /** @type {Map<string, Vote>} */
  const byVoter = new Map()
  for (const v of votes) byVoter.set(v.voter, v)
  const all = [...byVoter.values()]
  const confirms = all.filter(v => v.verdict === 'confirm').length
  const rejects = all.filter(v => v.verdict === 'reject').length
  if (confirms >= opts.quorum) return 'confirmed'
  // Rejected once the remaining voters could no longer reach quorum.
  if (Math.max(opts.verifiers, all.length) - rejects < opts.quorum) return 'rejected'
  return 'undecided'
}

/**
 * Records verifier votes and settles each finding they touch.
 *
 * @param {Ledger} ledger
 * @param {any[]} votes
 * @param {{ verifiers: number, quorum: number }} opts
 */
export function recordVotes(ledger, votes, opts) {
  /** @type {{ vote: any, reason: string }[]} */
  const invalid = []
  const touched = new Set()
  /** @type {Record<string, string>} */
  const outcome = {}
  for (const v of votes) {
    const f = ledger.findings[v?.id]
    if (!f) {
      invalid.push({ vote: v, reason: 'unknown finding id' })
      continue
    }
    if (v.verdict !== 'confirm' && v.verdict !== 'reject') {
      invalid.push({ vote: v, reason: 'verdict must be confirm or reject' })
      continue
    }
    if (!isText(v.reason)) {
      invalid.push({ vote: v, reason: 'a vote needs its evidence in reason' })
      continue
    }
    const voter = isText(v.voter) ? v.voter : `voter-${f.votes.length + 1}`
    f.votes = f.votes.filter(o => o.voter !== voter)
    /** @type {Vote} */
    const vote = { voter, verdict: v.verdict, reason: v.reason }
    if (SEVERITIES.includes(v.severity)) vote.severity = v.severity
    f.votes.push(vote)
    // A vote arriving after the finding settled is kept for the record and
    // changes nothing: the quorum already decided.
    if (f.status === 'candidate') touched.add(f.id)
    else outcome[f.id] = `already ${f.status}`
  }
  for (const id of touched) {
    const f = ledger.findings[id]
    if (!f) continue
    const verdict = tallyVotes(f.votes, opts)
    if (verdict === 'confirmed') {
      f.status = 'confirmed'
      const sev = f.votes.filter(v => v.verdict === 'confirm' && v.severity)
      const important = sev.filter(v => v.severity === 'important').length
      if (sev.length) f.severity = important * 2 >= sev.length ? 'important' : 'nit'
    } else if (verdict === 'rejected') {
      f.status = 'rejected'
    }
    outcome[id] = verdict
  }
  return { outcome, invalid }
}

/**
 * Findings that still need fixing: confirmed, and introduced by the change
 * unless pre-existing ones are in scope.
 *
 * @param {Ledger} ledger
 * @param {{ includePreExisting?: boolean, severity?: 'important' | 'nit' }} [opts]
 */
export function openFindings(ledger, opts = {}) {
  return Object.values(ledger.findings).filter(
    f =>
      f.status === 'confirmed' &&
      (opts.includePreExisting || f.origin === 'introduced') &&
      (!opts.severity || f.severity === opts.severity),
  )
}
