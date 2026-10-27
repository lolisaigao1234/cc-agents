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
 * Identity that survives line drift: the file, the offending code, the class
 * of bug and, when the same code appears more than once in the file, which
 * occurrence it is (0-based, counted from the top). Line numbers drift as
 * fixes land; the quoted code and its order among its copies do not. The
 * first occurrence carries no suffix, so a quote that appears once keeps the
 * plain file|quote|class identity.
 *
 * @param {Record<string, unknown> & { file: string, quote: string, bugClass?: string, category: string, occurrence?: number }} f
 */
export function fingerprint(f) {
  const occ = typeof f.occurrence === 'number' && f.occurrence > 0 ? `#${f.occurrence}` : ''
  return hash(`${normalizePath(f.file)}|${normalizeQuote(f.quote)}|${slug(f.bugClass || f.category)}${occ}`)
}

// A quote within this many lines of the cited line is relocated to where it
// actually is; further away, the finding is refused.
const RELOCATE_WINDOW = 25

/**
 * @param {string} rawQuote
 * @param {string[]} lines
 * @returns {(start: number) => boolean} whether the quote starts at a 1-based line
 */
function quoteMatcher(rawQuote, lines) {
  const quote = normalizeQuote(rawQuote)
  const quoteLines = Math.max(1, rawQuote.trim().split('\n').length)
  return start =>
    start >= 1 &&
    start <= lines.length &&
    normalizeQuote(lines.slice(start - 1, start - 1 + quoteLines).join(' ')).includes(quote)
}

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
  // A file that shrank since the hunter read it still gets the relocation
  // window; only a line no relocation could reach is out of range.
  if (f.line > lines.length + RELOCATE_WINDOW) return { ok: false, reason: 'line-out-of-range' }
  const startsAt = quoteMatcher(f.quote, lines)
  for (let d = 0; d <= RELOCATE_WINDOW; d++) {
    for (const cand of d === 0 ? [f.line] : [f.line - d, f.line + d]) {
      if (startsAt(cand)) return { ok: true, line: cand }
    }
  }
  return { ok: false, reason: 'quote-not-found' }
}

/**
 * Which copy of its quote a finding at `line` is: the number of earlier
 * lines where the same quote starts.
 *
 * @param {string} quote
 * @param {number} line 1-based, where the quote starts
 * @param {string[]} lines
 */
function occurrenceAt(quote, line, lines) {
  const startsAt = quoteMatcher(quote, lines)
  let n = 0
  for (let l = 1; l < line; l++) if (startsAt(l)) n++
  return n
}

/** @typedef {{ line: number, endLine: number }} Span */

/** @param {Span} a @param {Span} b */
const overlaps = (a, b) => a.line <= b.endLine && b.line <= a.endLine

// Statuses whose issue is still open. A settled finding (rejected, fixed,
// wontfix, stuck) absorbs a new report only when it quotes the same code.
const OPEN = ['candidate', 'confirmed']

/**
 * Where a recorded finding's code is now: its stored line is from the round
 * it was reported in, and fixes have moved code since. Null when the quote
 * is no longer near the stored line.
 *
 * @param {Pick<Finding, 'line' | 'endLine' | 'quote'>} f
 * @param {string[] | null} lines
 * @returns {Span | null}
 */
function locate(f, lines) {
  const ev = checkEvidence(f, lines)
  return ev.ok ? { line: ev.line, endLine: ev.line + Math.max(0, f.endLine - f.line) } : null
}

/**
 * @typedef {Pick<Finding, 'file' | 'fingerprint' | 'category' | 'bugClass' | 'line' | 'endLine' | 'quote' | 'status'>} Comparable
 */

/**
 * How `report` (a fresh finding, its lines current) matches the recorded
 * finding `known`, or null when they are different issues. Lower rank is a
 * stronger match. Known code is first relocated in the current file, so
 * stale line numbers never decide:
 *
 * - rank 0: the same code at the same place, under the same category or bug
 *   class (two lenses naming one bug with different labels);
 * - rank 1: different code of the same bug class on overlapping lines, while
 *   the known finding is still open. A rejected or fixed finding never
 *   absorbs different code: that is a new report, not a repeat;
 * - rank 2: the known code is no longer near its old line (it moved far, or
 *   it was rewritten), and the identity — file, code, class, occurrence — is
 *   the same.
 *
 * Different code on nearby lines is kept apart, and so is the same code at
 * another place: adjacent lines and repeated snippets often hold distinct
 * bugs, and a duplicate costs one extra vote where a wrong merge loses one.
 *
 * @param {Comparable} known
 * @param {Comparable} report
 * @param {string[] | null} lines the current contents of report.file
 * @returns {{ rank: number, at: Span | null } | null}
 */
function matchIssue(known, report, lines) {
  if (normalizePath(known.file) !== normalizePath(report.file)) return null
  const at = locate(known, lines)
  if (!at) return known.fingerprint === report.fingerprint ? { rank: 2, at } : null
  if (!overlaps(at, report)) return null
  if (normalizeQuote(known.quote) === normalizeQuote(report.quote)) {
    return known.category === report.category || known.bugClass === report.bugClass ? { rank: 0, at } : null
  }
  return known.bugClass === report.bugClass && OPEN.includes(known.status) ? { rank: 1, at } : null
}

/**
 * Whether a fresh report describes the same issue as a recorded finding.
 * See matchIssue for the rules.
 *
 * @param {Comparable} known
 * @param {Comparable} report
 * @param {string[] | null} lines the current contents of report.file
 */
export function isSameIssue(known, report, lines) {
  return matchIssue(known, report, lines) !== null
}

/**
 * The recorded finding that best matches a report: strongest rank, then the
 * one whose stored line is nearest.
 *
 * @template {Comparable} T
 * @param {T[]} known
 * @param {Comparable} report
 * @param {string[] | null} lines
 * @returns {{ finding: T, at: Span | null } | null}
 */
function bestMatch(known, report, lines) {
  /** @type {{ finding: T, at: Span | null, rank: number, dist: number } | null} */
  let best = null
  for (const finding of known) {
    const m = matchIssue(finding, report, lines)
    if (!m) continue
    const dist = Math.abs(finding.line - report.line)
    if (!best || m.rank < best.rank || (m.rank === best.rank && dist < best.dist)) {
      best = { finding, at: m.at, rank: m.rank, dist }
    }
  }
  return best && { finding: best.finding, at: best.at }
}

/**
 * Decodes the octal escapes git writes for non-ASCII bytes in a quoted path
 * (`caf\303\251.js` → `café.js`) when core.quotePath is on.
 *
 * @param {string} path
 */
export function decodeGitPath(path) {
  return path.replace(/(?:\\[0-7]{3})+/g, run =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split('\\'), o => parseInt(o, 8))),
  )
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
    const lines = ctx.readLines(file)
    const ev = checkEvidence(raw, lines)
    if (!ev.ok || !lines) {
      report.rejected.push({ ...label, reason: ev.ok ? 'file-missing' : ev.reason })
      continue
    }
    const span = Math.max(0, (raw.endLine ?? raw.line) - raw.line)
    const line = ev.line
    const endLine = line + span
    const diffFile = ctx.diffFiles.find(d => d.path === file || normalizePath(decodeGitPath(d.path)) === file)
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
    f.fingerprint = fingerprint({ ...f, occurrence: occurrenceAt(f.quote, line, lines) })

    const match = bestMatch(Object.values(ledger.findings), f, lines)
    if (match) {
      const existing = match.finding
      existing.lastRound = ctx.round
      if (!existing.lenses.includes(ctx.lens)) existing.lenses.push(ctx.lens)
      if (match.at) {
        // Keep the recorded location current, so later rounds compare against it.
        existing.line = match.at.line
        existing.endLine = match.at.endLine
      }
      if (existing.status === 'rejected' || existing.status === 'wontfix') {
        report.repeats.push(existing.id)
      } else if (existing.status === 'fixed') {
        // A fix that did not hold: verify it again from scratch, as the new
        // report describes it now.
        Object.assign(existing, {
          title: f.title,
          line: f.line,
          endLine: f.endLine,
          quote: f.quote,
          category: f.category,
          severity: f.severity,
          bugClass: f.bugClass,
          explanation: f.explanation,
          failureScenario: f.failureScenario,
          suggestedFix: f.suggestedFix,
          confidence: f.confidence,
          origin: f.origin,
          fingerprint: f.fingerprint,
        })
        existing.status = 'candidate'
        existing.votes = []
        existing.reopens += 1
        report.reopened.push(existing.id)
      } else {
        report.merged.push(existing.id)
      }
      continue
    }
    const dup = bestMatch(fresh, f, lines)?.finding
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
 * Records verifier votes and settles each finding they touch. Votes settle
 * in arrival order, so a batch decides exactly as the same votes recorded
 * one at a time would: once quorum is reached or out of reach, later votes
 * are kept for the record and change nothing.
 *
 * @param {Ledger} ledger
 * @param {any[]} votes
 * @param {{ verifiers: number, quorum: number }} opts
 */
export function recordVotes(ledger, votes, opts) {
  /** @type {{ vote: any, reason: string }[]} */
  const invalid = []
  /** @type {Set<string>} */
  const settledNow = new Set()
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
    // Independence is counted by voter name: a vote without one could not be
    // told apart from the same vote recorded twice.
    if (!isText(v.voter)) {
      invalid.push({ vote: v, reason: 'a vote needs its voter name' })
      continue
    }
    const voter = v.voter
    f.votes = f.votes.filter(o => o.voter !== voter)
    /** @type {Vote} */
    const vote = { voter, verdict: v.verdict, reason: v.reason }
    if (SEVERITIES.includes(v.severity)) vote.severity = v.severity
    f.votes.push(vote)
    // A vote arriving after the finding settled is kept for the record and
    // changes nothing: the quorum already decided.
    if (f.status !== 'candidate') {
      if (!settledNow.has(f.id)) outcome[f.id] = `already ${f.status}`
      continue
    }
    const verdict = tallyVotes(f.votes, opts)
    if (verdict === 'confirmed') {
      f.status = 'confirmed'
      const sev = f.votes.filter(o => o.verdict === 'confirm' && o.severity)
      const important = sev.filter(o => o.severity === 'important').length
      if (sev.length) f.severity = important * 2 >= sev.length ? 'important' : 'nit'
    } else if (verdict === 'rejected') {
      f.status = 'rejected'
    }
    if (verdict !== 'undecided') settledNow.add(f.id)
    outcome[f.id] = verdict
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
