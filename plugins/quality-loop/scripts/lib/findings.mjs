// The findings ledger: every issue a bug hunter reported, deduplicated across
// lenses and rounds, with the votes that confirmed or rejected it. Pure: the
// caller injects file contents, the parsed diff and a line translator
// between snapshot trees (see ADR 0002 and track.mjs).

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
 *   resolution: string, confirmedRound?: number, tree?: string, copies?: number,
 * }} Finding `line` and `endLine` are where the finding was last seen, in the
 *   snapshot `tree` (absent in ledgers from before line tracking); `copies`
 *   is how many times its quote occurred in the file then
 * @typedef {{ nextId: number, findings: Record<string, Finding> }} Ledger
 * @typedef {{ skipPaths?: string[], dropCategories?: string[], maxNitsPerRound?: number }} IngestConfig
 * @typedef {{ line: number, endLine: number }} Span
 * @typedef {(file: string, line: number, endLine: number, fromTree: string) => Span | null} Translate
 *   where lines [line, endLine] of `file` in the snapshot `fromTree` are in
 *   the current tree, or null when any of them was changed or deleted
 * @typedef {{
 *   round: number, lens: string, diffFiles: import('./diff.mjs').DiffFile[],
 *   readLines: (path: string) => string[] | null, config: IngestConfig,
 *   tree?: string, translate?: Translate,
 * }} IngestContext `tree` is the snapshot the files are read from
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
 * A line-insensitive summary of a finding (file, offending code, bug class),
 * kept for the record. It does not decide identity: copies of the same code
 * share it. The ledger tracks each finding's lines instead (see matchKnown).
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
 * @param {string} rawQuote
 * @param {string[]} lines
 * @returns {(start: number) => boolean} whether the quote starts at a 1-based line
 */
function quoteMatcher(rawQuote, lines) {
  const quote = normalizeQuote(rawQuote)
  const quoteLines = Math.max(1, rawQuote.trim().split('\n').length)
  // Normalising touches only whitespace, so the quote's longest token appears
  // verbatim on one of the lines wherever the quote matches: a cheap filter
  // before the full comparison.
  const token = quote.split(' ').reduce((a, b) => (b.length > a.length ? b : a), '')
  return start => {
    if (start < 1 || start > lines.length) return false
    const window = lines.slice(start - 1, start - 1 + quoteLines)
    return window.some(l => l.includes(token)) && normalizeQuote(window.join(' ')).includes(quote)
  }
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

/** @param {string} quote */
const quoteHeight = quote => Math.max(1, quote.trim().split('\n').length)

/** @param {Span} a @param {Span} b */
const overlaps = (a, b) => a.line <= b.endLine && b.line <= a.endLine

/** @param {Span} inner @param {Span} outer */
const within = (inner, outer) => outer.line <= inner.line && inner.endLine <= outer.endLine

/**
 * The lines its quote occupies when it starts at `line`.
 *
 * @param {string} quote
 * @param {number} line
 * @returns {Span}
 */
const quoteSpan = (quote, line) => ({ line, endLine: line + quoteHeight(quote) - 1 })

/**
 * The start lines of every occurrence of each quote in each file, computed
 * once per ingest.
 *
 * @param {(path: string) => string[] | null} readLines
 */
function occurrenceIndex(readLines) {
  /** @type {Map<string, number[]>} */
  const memo = new Map()
  /** @type {Map<string, string[] | null>} */
  const files = new Map()
  /** @param {string} file @param {string} quote @returns {number[]} */
  return (file, quote) => {
    const key = `${file}\0${quoteHeight(quote)}\0${normalizeQuote(quote)}`
    let at = memo.get(key)
    if (!at) {
      at = []
      if (!files.has(file)) files.set(file, readLines(file))
      const lines = files.get(file)
      if (lines) {
        const startsAt = quoteMatcher(quote, lines)
        for (let l = 1; l <= lines.length; l++) if (startsAt(l)) at.push(l)
      }
      memo.set(key, at)
    }
    return at
  }
}

/**
 * Where a recorded finding's quoted code starts in the current file, or null
 * when that cannot be told for certain (see ADR 0002):
 *
 * - its lines are translated from the tree it was last seen in through the
 *   real diff of the file, so the copy it was is followed whatever happened
 *   to its siblings;
 * - when those lines were changed or deleted, or the finding has no tree
 *   (an older ledger), its quote is relocated only if it is the one copy in
 *   the file now and was the one copy when last seen. Any other case is
 *   ambiguous, and ambiguity means "not this finding".
 *
 * @param {Finding} known
 * @param {IngestContext} ctx
 * @param {(file: string, quote: string) => number[]} occurrences
 * @returns {number | null}
 */
function whereNow(known, ctx, occurrences) {
  const own = quoteSpan(known.quote, known.line)
  if (known.tree && ctx.tree) {
    const t = known.tree === ctx.tree ? own : ctx.translate?.(known.file, own.line, own.endLine, known.tree) ?? null
    if (t && occurrences(known.file, known.quote).includes(t.line)) return t.line
  }
  // A ledger from before line tracking knew the count from its anchor.
  const copies = known.copies ?? /** @type {any} */ (known).anchor?.copies
  if (copies !== undefined && copies !== 1) return null
  const now = occurrences(known.file, known.quote)
  return now.length === 1 ? (now[0] ?? null) : null
}

/**
 * How strongly a report (its line current) matches recorded code that now
 * starts at `at`, or null when they are different issues. Lower is stronger.
 * Both line numbers are exact quote starts (the report's from checkEvidence,
 * the known one's from whereNow), so places must agree exactly:
 *
 * - 0: the same code at the same line, under the same bug class or category
 *   (two lenses naming one bug with different labels);
 * - 1: one quote contains the other (a trimmed or extended quote) and lies
 *   within the other's lines, under the same bug class or category;
 * - 2: different code of the same bug class on overlapping lines.
 *
 * The same code at another line is another instance; different code on
 * adjacent lines is another bug.
 *
 * @param {Pick<Finding, 'quote' | 'bugClass' | 'category'>} known
 * @param {number} at
 * @param {Pick<Finding, 'quote' | 'bugClass' | 'category' | 'line'>} report
 * @returns {number | null}
 */
function matchRank(known, at, report) {
  const kq = normalizeQuote(known.quote)
  const rq = normalizeQuote(report.quote)
  const k = quoteSpan(known.quote, at)
  const r = quoteSpan(report.quote, report.line)
  const labelled = known.bugClass === report.bugClass || known.category === report.category
  if (kq === rq) return k.line === r.line && labelled ? 0 : null
  if (labelled && ((rq.includes(kq) && within(k, r)) || (kq.includes(rq) && within(r, k)))) return 1
  return known.bugClass === report.bugClass && overlaps(k, r) ? 2 : null
}

/**
 * Pairs each report with the recorded finding it is, if any. Nearest first:
 * a finding is claimed by at most one report of the batch, and a report that
 * loses it to a nearer one is new.
 *
 * @param {Finding[]} known
 * @param {Finding[]} reports current lines
 * @param {IngestContext} ctx
 * @param {(file: string, quote: string) => number[]} occurrences
 * @returns {Map<Finding, { finding: Finding, at: number }>} by report
 */
function matchKnown(known, reports, ctx, occurrences) {
  /** @type {Map<Finding, number | null>} */
  const where = new Map()
  /** @type {{ report: Finding, finding: Finding, at: number, rank: number, dist: number, order: number }[]} */
  const pairs = []
  reports.forEach((report, order) => {
    for (const finding of known) {
      if (normalizePath(finding.file) !== report.file) continue
      if (!where.has(finding)) where.set(finding, whereNow(finding, ctx, occurrences))
      const at = where.get(finding)
      if (at === null || at === undefined) continue
      const rank = matchRank(finding, at, report)
      if (rank !== null) pairs.push({ report, finding, at, rank, dist: Math.abs(at - report.line), order })
    }
  })
  pairs.sort((a, b) => a.dist - b.dist || a.rank - b.rank || a.order - b.order)
  /** @type {Map<Finding, { finding: Finding, at: number }>} */
  const claims = new Map()
  const taken = new Set()
  for (const p of pairs) {
    if (claims.has(p.report) || taken.has(p.finding)) continue
    claims.set(p.report, { finding: p.finding, at: p.at })
    taken.add(p.finding)
  }
  return claims
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
  /** @type {Finding[]} the batch's valid reports, their lines current */
  const reports = []
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
    f.fingerprint = fingerprint(f)
    reports.push(f)
  }

  const occurrences = occurrenceIndex(ctx.readLines)
  /** Records where a finding is seen now: its lines in the current tree. @param {Finding} f */
  const seenNow = f => {
    if (ctx.tree) f.tree = ctx.tree
    else delete f.tree
    f.copies = occurrences(f.file, f.quote).length
    delete (/** @type {any} */ (f).anchor)
  }
  const claims = matchKnown(Object.values(ledger.findings), reports, ctx, occurrences)
  /** @type {Finding[]} */
  const fresh = []
  for (const f of reports) {
    const match = claims.get(f)
    if (match) {
      const existing = match.finding
      existing.lastRound = ctx.round
      if (!existing.lenses.includes(ctx.lens)) existing.lenses.push(ctx.lens)
      // Keep the recorded location current, so later rounds translate from it.
      existing.endLine = match.at + Math.max(0, existing.endLine - existing.line)
      existing.line = match.at
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
      seenNow(existing)
      continue
    }
    // The same report twice in one batch: the nearest earlier one at the same
    // place. The same code elsewhere is another instance.
    let dup = null
    let dist = Infinity
    for (const g of fresh) {
      if (g.file !== f.file || matchRank(g, g.line, f) === null) continue
      if (Math.abs(g.line - f.line) < dist) [dup, dist] = [g, Math.abs(g.line - f.line)]
    }
    if (dup) {
      if (!dup.lenses.includes(ctx.lens)) dup.lenses.push(ctx.lens)
      continue
    }
    seenNow(f)
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
 * are kept for the record and do not change the verdict. A confirmed
 * finding's severity is the majority (ties: important) of all its confirm
 * votes that name one, including those that arrive after it settled.
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
    if (f.status === 'candidate') {
      const verdict = tallyVotes(f.votes, opts)
      if (verdict === 'confirmed') f.status = 'confirmed'
      else if (verdict === 'rejected') f.status = 'rejected'
      if (verdict !== 'undecided') settledNow.add(f.id)
      outcome[f.id] = verdict
    } else if (!settledNow.has(f.id)) {
      outcome[f.id] = `already ${f.status}`
    }
    // Severity is not part of the settling: every confirm vote of a confirmed
    // finding counts, so the order the vote files arrive in cannot change it.
    if (f.status === 'confirmed') {
      const sev = f.votes.filter(o => o.verdict === 'confirm' && o.severity)
      const important = sev.filter(o => o.severity === 'important').length
      if (sev.length) f.severity = important * 2 >= sev.length ? 'important' : 'nit'
    }
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
