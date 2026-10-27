// The loop's lifecycle: start, rounds (begin, review scope, ingest, vote,
// mark, end), pause, resume, abort. Each operation loads the state, checks
// it is in the right phase, changes it and saves it with LOOP.md.

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { compareRuns, runChecks } from './checks.mjs'
import { detectChecks, lensFocus, resolveConfig, validateConfig } from './config.mjs'
import { decideRound, scoreOf } from './decide.mjs'
import { parseUnifiedDiff } from './diff.mjs'
import { checkEvidence, ingestFindings, newLedger, normalizeQuote, recordVotes } from './findings.mjs'
import { diffTrees, resolveBase, restoreTree, snapshotTree } from './git.mjs'
import { counts, currentRound, inScope, phaseOf, renderLoopMd } from './report.mjs'
import { GITIGNORE, paths, readJson, writeJson, writeText } from './store.mjs'
import { scanWeakening } from './weakening.mjs'

/** @typedef {import('./findings.mjs').Finding} Finding */

export class LoopError extends Error {}

const REVIEW_TEMPLATE = `# REVIEW.md

Guidance for the quality-loop reviewers in this repository. Keep it short;
every line here is read by every bug hunter. Fix recurring findings at the
source: add the rule here, a lint rule, or a line in CLAUDE.md.

## What failure looks like here

- (e.g. "an API handler that returns 200 on a failed write", "a migration that is not reversible")

## Always flag

-

## Never flag

- Formatting and naming: the formatter and linter own those.

## Paths to skip

- (globs also go in .quality-loop/config.json under review.skipPaths)
`

/**
 * Creates `.quality-loop/` with a config whose checks are detected from the
 * repository, a REVIEW.md template and a .gitignore for runtime files.
 *
 * @param {string} root
 * @param {{ force?: boolean }} [opts]
 */
export function init(root, opts = {}) {
  const p = paths(root)
  const created = []
  if (!existsSync(p.config) || opts.force) {
    writeJson(p.config, { version: 1, checks: detectChecks(root), review: { depth: 'standard' } })
    created.push(p.config)
  }
  if (!existsSync(p.reviewMd)) {
    writeText(p.reviewMd, REVIEW_TEMPLATE)
    created.push(p.reviewMd)
  }
  if (!existsSync(p.gitignore)) {
    writeText(p.gitignore, GITIGNORE)
    created.push(p.gitignore)
  }
  return { created, config: loadConfig(root) }
}

/**
 * @param {string} root
 * @param {{ depth?: string }} [overrides]
 */
export function loadConfig(root, overrides = {}) {
  const file = readJson(paths(root).config) ?? {}
  if (overrides.depth) {
    if (!['quick', 'standard', 'deep'].includes(overrides.depth)) throw new LoopError('--depth must be quick, standard or deep')
    // An explicit depth replaces the file's lens and voting choices with the preset.
    file.review = { ...file.review, depth: overrides.depth, lenses: null, verifiers: null, quorum: null }
  }
  const c = resolveConfig(file)
  const errors = validateConfig(c)
  if (errors.length) throw new LoopError(`invalid .quality-loop/config.json: ${errors.join('; ')}`)
  return c
}

/** @param {string} root */
export function loadState(root) {
  return readJson(paths(root).state)
}

/** @param {string} root @param {any} s */
export function saveState(root, s) {
  s.updatedAt = new Date().toISOString()
  writeJson(paths(root).state, s)
  writeText(paths(root).loopMd, renderLoopMd(s))
}

/** @param {string} root */
function requireState(root) {
  const s = loadState(root)
  if (!s) throw new LoopError('no loop has been started here: run `ql start` first')
  return s
}

/**
 * @param {any} s
 * @param {string[]} phases
 * @param {string} what
 */
function requirePhase(s, phases, what) {
  const phase = phaseOf(s)
  if (!phases.includes(phase)) {
    throw new LoopError(`cannot ${what} in phase "${phase}" (status ${s.status}); run \`ql next\` for what to do now`)
  }
}

/** @param {any} s */
function checkSpecs(s) {
  const specs = [...s.config.checks]
  if (s.repro) specs.push({ name: 'repro', cmd: s.repro, required: true, timeoutSec: 600 })
  return specs
}

/** @param {any} run */
const failingRequired = run => (run?.results ?? []).filter((/** @type {any} */ r) => !r.ok && r.required).map((/** @type {any} */ r) => r.name)

/**
 * @param {string} root
 * @param {{ mode: 'review' | 'debug', goal?: string, base?: string, repro?: string, force?: boolean, reviewOnly?: boolean, depth?: string }} opts
 */
export async function start(root, opts) {
  if (opts.mode !== 'review' && opts.mode !== 'debug') throw new LoopError('--mode must be review or debug')
  if (opts.mode === 'debug' && !opts.repro) throw new LoopError('debug mode needs --repro "<command that fails while the bug exists>"')
  const p = paths(root)
  if (!existsSync(p.config)) init(root)
  const config = loadConfig(root, { depth: opts.depth })
  const prev = loadState(root)
  if (prev && prev.status === 'active' && !opts.force) {
    throw new LoopError(`a loop is already active (${prev.id}, round ${prev.round}); finish it, \`ql abort\`, or pass --force`)
  }
  if (prev) {
    // Keep the old run for the record.
    mkdirSync(p.history, { recursive: true })
    renameSync(p.state, join(p.history, `${prev.id}.json`))
  }
  const baseCommit = resolveBase(root, opts.base ?? config.baseRef)
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const s = {
    version: 1,
    id,
    mode: opts.mode,
    goal:
      opts.goal ??
      (opts.mode === 'debug'
        ? `the repro command passes, no required check regresses, and the fix's review has no open important findings`
        : 'every required check passes (no new failures) and no important finding introduced by the change remains open'),
    status: 'active',
    statusReasons: /** @type {string[]} */ ([]),
    baseCommit,
    repro: opts.repro ?? null,
    config,
    startedAt: new Date().toISOString(),
    updatedAt: '',
    round: 0,
    rounds: /** @type {any[]} */ ([]),
    ledger: newLedger(),
    baseline: { checkpoint: snapshotTree(root), run: /** @type {any} */ (null) },
    lastRun: /** @type {any} */ (null),
    stopNudges: 0,
    warnings: /** @type {string[]} */ ([]),
    reviewOnly: !!opts.reviewOnly,
    reproPassedAtStart: false,
    extendedAt: 0,
  }
  if (s.reviewOnly) {
    if (s.mode !== 'review') throw new LoopError('--review-only applies to review mode')
    s.goal = opts.goal ?? 'report verified findings for the change; no fixes'
    s.config.loop.maxRounds = 1
    s.baseline.run = { label: 'baseline', results: [] }
    s.lastRun = s.baseline.run
    saveState(root, s)
    return s
  }
  const specs = checkSpecs(s)
  if (!config.checks.length) {
    s.warnings.push('no checks are configured: regressions cannot be detected. Add checks to .quality-loop/config.json.')
  }
  s.baseline.run = await runChecks(specs, { cwd: root, logDir: join(p.runs, id, 'baseline'), label: 'baseline' })
  s.lastRun = s.baseline.run
  if (s.repro) {
    const repro = s.baseline.run.results.find((/** @type {any} */ r) => r.name === 'repro')
    if (repro?.ok) {
      // Not a pause the user can answer: the loop has nothing to fix until a
      // new repro fails. `resume` refuses it; `ql start` replaces it.
      s.status = 'paused'
      s.reproPassedAtStart = true
      s.statusReasons = ['the repro command passes before any fix: the bug does not reproduce. Fix the repro command, then `ql start` again.']
    }
  }
  saveState(root, s)
  return s
}

/** @param {string} root */
export function beginRound(root) {
  const s = requireState(root)
  requirePhase(s, ['begin'], 'begin a round')
  s.round += 1
  s.rounds.push({
    n: s.round,
    startCheckpoint: snapshotTree(root),
    startedAt: new Date().toISOString(),
    ingests: 0,
    fixedIds: [],
    ended: false,
  })
  saveState(root, s)
  return { round: s.round, scope: scope(root) }
}

/**
 * What this round's reviewers look at: the whole change against the base
 * for the first rounds, then only what changed since the last kept round
 * started (diff-only re-review), so later rounds do not re-litigate old code.
 *
 * @param {string} root
 */
export function scope(root) {
  const s = requireState(root)
  const r = currentRound(s)
  if (!r) throw new LoopError('no round in progress: run `ql round begin`')
  const { diffOnly, from, diff } = scopeDiff(root, s)
  if (dropStaleEmptyScope(s, diff)) saveState(root, s)
  const files = parseUnifiedDiff(diff).map(f => ({ path: f.path, status: f.status, added: f.added.length, removed: f.removed.length }))
  const diffFile = join(paths(root).work, `round-${s.round}`, 'scope.diff')
  writeText(diffFile, diff)
  const lenses = s.config.review.lenses.map((/** @type {string} */ name) => ({ name, focus: lensFocus(name, s.config.review.customLenses) }))
  return { round: s.round, diffOnly, from, diffFile, files, empty: files.length === 0, reviewMd: paths(root).reviewMd, lenses }
}

/**
 * The current round's review diff: against the base, or diff-only since the
 * last kept round started.
 *
 * @param {string} root
 * @param {any} s
 */
function scopeDiff(root, s) {
  const kept = s.rounds.filter((/** @type {any} */ x) => x.ended && !x.reverted)
  const diffOnly = s.round > s.config.loop.diffOnlyAfterRound && kept.length > 0
  const from = diffOnly ? kept.at(-1).startCheckpoint : s.baseCommit
  return { diffOnly, from, diff: diffTrees(root, from, snapshotTree(root)) }
}

/**
 * An empty scope recorded with `ingest --none --lens scope` closes the review
 * only while the scope stays empty. In debug mode the fix lands after `round
 * begin`; once anything changes, the record no longer holds and every lens
 * must review the change. Returns whether the record was dropped.
 *
 * @param {any} s
 * @param {string} diff the current scope diff
 */
function dropStaleEmptyScope(s, diff) {
  const r = currentRound(s)
  if (!r?.lensesDone?.includes('scope') || !diff.trim()) return false
  r.lensesDone = r.lensesDone.filter((/** @type {string} */ l) => l !== 'scope')
  r.scopeChanged = true
  return true
}

/**
 * The state with a stale empty-scope record dropped (and saved), so `ql next`
 * and `ql status` describe the tree as it is now.
 *
 * @param {string} root
 */
export function syncState(root) {
  const s = loadState(root)
  if (s && currentRound(s) && dropStaleEmptyScope(s, scopeDiff(root, s).diff)) saveState(root, s)
  return s
}

/** @param {string} root @param {string} file */
function readLines(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8').split('\n')
  } catch {
    return null
  }
}

/**
 * @param {string} root
 * @param {any[] | null} raws null: the reviewer found nothing (or the scope was empty)
 * @param {string} lens
 */
export function ingest(root, raws, lens) {
  const s = requireState(root)
  requirePhase(s, ['review', 'investigate', 'verify', 'fix', 'end', 'report'], 'ingest findings')
  const r = currentRound(s)
  // Review completeness is counted by lens name, so a `--none` must name the
  // configured lens it stands for; `scope` stands for all of them and is
  // only true of an empty scope.
  const lenses = /** @type {string[]} */ (s.config.review.lenses)
  const scopeNow = scopeDiff(root, s).diff
  dropStaleEmptyScope(s, scopeNow)
  if (lens === 'scope') {
    if (raws !== null) throw new LoopError('the lens "scope" only records an empty scope: `ql ingest --none --lens scope`')
    if (scopeNow.trim()) {
      throw new LoopError(`the scope is not empty: review it with one bug hunter per lens (${lenses.join(', ')}) and ingest each`)
    }
  } else if (raws === null && !lenses.includes(lens)) {
    throw new LoopError(`\`ql ingest --none\` needs --lens naming a configured lens (${lenses.join(', ')}), or --lens scope for an empty scope; got "${lens || '(none)'}"`)
  }
  const diffFiles = parseUnifiedDiff(diffTrees(root, s.baseCommit, snapshotTree(root), { context: 0 }))
  const { report } = ingestFindings(s.ledger, raws ?? [], {
    round: s.round,
    lens,
    diffFiles,
    readLines: f => readLines(root, f),
    config: s.config.review,
  })
  r.ingests += 1
  r.lensesDone = [...new Set([...(r.lensesDone ?? []), lens])]
  saveState(root, s)
  return report
}

/** @param {string} root */
export function pending(root) {
  const s = requireState(root)
  const { verifiers, quorum } = s.config.review
  return {
    verifiers,
    quorum,
    findings: /** @type {Finding[]} */ (Object.values(s.ledger.findings))
      .filter(f => f.status === 'candidate')
      .map(f => ({ ...f, votesNeeded: Math.max(0, verifiers - f.votes.length) })),
  }
}

/** @param {string} root @param {any[]} votes */
export function vote(root, votes) {
  const s = requireState(root)
  requirePhase(s, ['verify', 'review', 'investigate'], 'record votes')
  const { verifiers, quorum } = s.config.review
  const out = recordVotes(s.ledger, votes, { verifiers, quorum })
  for (const [id, verdict] of Object.entries(out.outcome)) {
    if (verdict === 'confirmed') s.ledger.findings[id].confirmedRound = s.round
  }
  saveState(root, s)
  return out
}

/** @param {string} root */
export function openByClass(root) {
  const s = requireState(root)
  /** @type {Record<string, Finding[]>} */
  const groups = {}
  for (const f of /** @type {Finding[]} */ (Object.values(s.ledger.findings))) {
    if (f.status !== 'confirmed' || !inScope(s, f)) continue
    ;(groups[f.bugClass] ??= []).push(f)
  }
  return groups
}

/**
 * @param {string} root
 * @param {string} id
 * @param {'fixed' | 'wontfix'} status
 * @param {string} reason
 */
export function mark(root, id, status, reason) {
  const s = requireState(root)
  requirePhase(s, ['fix', 'end'], 'mark findings')
  const f = s.ledger.findings[id]
  if (!f) throw new LoopError(`no finding ${id}`)
  if (status !== 'fixed' && status !== 'wontfix') throw new LoopError('status must be fixed or wontfix')
  if (!reason || !reason.trim()) throw new LoopError('a reason is required: the evidence for the fix, or why it will not be fixed')
  if (f.status !== 'confirmed' && !(status === 'wontfix' && f.status === 'stuck')) {
    throw new LoopError(`${id} is ${f.status}; only confirmed findings can be marked`)
  }
  f.status = status
  f.resolution = reason.trim()
  if (status === 'fixed') currentRound(s).fixedIds.push(id)
  saveState(root, s)
  return f
}

/**
 * Where a finding's quote starts in `lines`, anywhere in the file: the
 * occurrence nearest its recorded line, or null when the code is gone.
 *
 * @param {Finding} f
 * @param {string[] | null} lines
 * @returns {number | null}
 */
function findQuote(f, lines) {
  if (!lines) return null
  const quote = normalizeQuote(f.quote)
  if (!quote) return null
  const span = Math.max(1, f.quote.trim().split('\n').length)
  /** @type {number | null} */
  let best = null
  for (let i = 1; i <= lines.length; i++) {
    if (!normalizeQuote(lines.slice(i - 1, i - 1 + span).join(' ')).includes(quote)) continue
    if (best === null || Math.abs(i - f.line) < Math.abs(best - f.line)) best = i
  }
  return best
}

/**
 * Validates the round: runs the checks, compares against the run the round
 * started from, scans the round's own diff for weakened tests, reverts the
 * round on regression, counts fix attempts and decides how the loop goes on.
 *
 * @param {string} root
 * @param {{ allowWeakening?: boolean }} [opts]
 */
export async function endRound(root, opts = {}) {
  const s = requireState(root)
  if (s.reviewOnly) throw new LoopError('a review-only loop changes nothing and is not validated: close it with `ql finish`')
  // Only a fully reviewed and verified round can be validated: every lens
  // ingested (or an empty scope recorded, and still empty) and no candidate
  // left unvoted.
  if (currentRound(s) && dropStaleEmptyScope(s, scopeDiff(root, s).diff)) {
    saveState(root, s)
    throw new LoopError(
      `the scope was recorded empty, but the tree has changed since: review the change (\`ql scope\`) with one bug hunter per lens (${s.config.review.lenses.join(', ')}) and ingest each before \`ql round end\``,
    )
  }
  requirePhase(s, ['fix', 'end'], 'end the round')
  const r = currentRound(s)
  const specs = checkSpecs(s)
  const logDir = join(paths(root).runs, s.id, `round-${r.n}`)
  const run = await runChecks(specs, { cwd: root, logDir, label: `round-${r.n}` })

  // A check that fails once and passes on a re-run is flaky, not a regression.
  let cmp = compareRuns(s.lastRun, run)
  const flaky = []
  for (let attempt = 0; attempt < s.config.loop.retryFailedChecks && cmp.newlyFailingRequired.length; attempt++) {
    const again = await runChecks(
      specs.filter(c => cmp.newlyFailingRequired.includes(c.name)),
      { cwd: root, logDir: join(logDir, `retry-${attempt + 1}`), label: `round-${r.n}-retry` },
    )
    for (const res of again.results) {
      if (res.ok) {
        flaky.push(res.name)
        const i = run.results.findIndex(x => x.name === res.name)
        run.results[i] = { ...res, flaky: true }
      }
    }
    cmp = compareRuns(s.lastRun, run)
  }

  const roundDiff = parseUnifiedDiff(diffTrees(root, r.startCheckpoint, snapshotTree(root), { context: 0 }))
  const weakening = scanWeakening(roundDiff)
  const blockingWeakening = weakening.filter(w => w.blocking).map(w => `${w.kind}:${w.file}${w.line ? `:${w.line}` : ''}`)
  const regressions = { newlyFailingRequired: cmp.newlyFailingRequired, testCountDrops: cmp.testCountDrops, blockingWeakening }
  const willRevert =
    regressions.newlyFailingRequired.length > 0 ||
    regressions.testCountDrops.length > 0 ||
    (!opts.allowWeakening && blockingWeakening.length > 0)

  const all = /** @type {Finding[]} */ (Object.values(s.ledger.findings))
  const fixedThisRound = all.filter(f => r.fixedIds.includes(f.id))
  const startCounts = counts(s)
  const startScore = scoreOf({
    failingRequired: failingRequired(s.lastRun).filter((/** @type {string} */ n) => !failingRequired(s.baseline.run).includes(n)).length,
    important: startCounts.important + fixedThisRound.filter(f => f.severity === 'important').length,
    nit: startCounts.nit + fixedThisRound.filter(f => f.severity === 'nit').length,
    pending: startCounts.pending,
  })

  let restored = null
  /** @type {{ id: string, title: string, file: string, line: number, reason: string }[]} */
  const discarded = []
  if (willRevert) {
    restored = restoreTree(root, r.startCheckpoint)
    for (const f of fixedThisRound) {
      f.status = 'confirmed'
      f.resolution = ''
    }
    // Findings reported this round on code the revert removed (typically on
    // the reverted fix itself) describe code that no longer exists; keeping
    // them open would block the loop on nothing. If the code comes back, the
    // next review reports it afresh.
    for (const f of all) {
      if (f.firstRound !== r.n || !['candidate', 'confirmed'].includes(f.status)) continue
      // The reverted fix may have moved the code far from the finding's
      // line: the code is gone only if its quote is nowhere in the file.
      const lines = readLines(root, f.file)
      const ev = checkEvidence(f, lines)
      const at = ev.ok ? ev.line : findQuote(f, lines)
      if (at != null) {
        f.endLine = at + (f.endLine - f.line)
        f.line = at
        continue
      }
      discarded.push({ id: f.id, title: f.title, file: f.file, line: f.line, reason: `${ev.ok ? 'quote-not-found' : ev.reason} after the revert` })
      delete s.ledger.findings[f.id]
    }
  }
  const live = /** @type {Finding[]} */ (Object.values(s.ledger.findings))
  // An attempt counts against important findings only: nits never block the
  // finish line, so leaving one open is not being stuck on it.
  for (const f of live) {
    if (f.status === 'confirmed' && f.severity === 'important' && inScope(s, f)) {
      f.attempts += 1
      if (f.attempts >= s.config.loop.maxAttemptsPerFinding) f.status = 'stuck'
    }
  }
  const c = counts(s)
  const decision = decideRound({
    mode: s.mode,
    round: s.round,
    limits: { maxRounds: s.config.loop.maxRounds, stallRounds: s.config.loop.stallRounds },
    regressions,
    allowWeakening: !!opts.allowWeakening,
    requiredFailingNow: failingRequired(willRevert ? s.lastRun : run),
    baselineRequiredFailing: failingRequired(s.baseline.run),
    reproOk: s.repro ? !!(willRevert ? s.lastRun : run).results.find((/** @type {any} */ x) => x.name === 'repro')?.ok : null,
    open: { important: c.important, nit: c.nit, pending: c.pending, stuck: c.stuck },
    // Oscillation: a finding still in play that keeps coming back. One later
    // rejected or accepted as won't-fix is no longer fighting a fix.
    maxReopens: Math.max(0, ...live.filter(f => f.status !== 'rejected' && f.status !== 'wontfix').map(f => f.reopens)),
    // Stall and divergence look only at rounds since the user last extended.
    history: s.rounds
      .filter((/** @type {any} */ x) => x.ended && x.n > (s.extendedAt ?? 0))
      .map((/** @type {any} */ x) => ({ startScore: x.startScore, endScore: x.endScore, reverted: x.reverted, found: x.found })),
    startScore,
    found: live.filter(f => f.confirmedRound === r.n).length,
  })

  Object.assign(r, {
    ended: true,
    endedAt: new Date().toISOString(),
    reverted: decision.revert,
    restored,
    run,
    compare: cmp,
    flaky,
    weakening,
    startScore,
    endScore: decision.endScore,
    found: live.filter(f => f.confirmedRound === r.n).length,
    discarded,
    reasons: decision.reasons,
    status: decision.status,
  })
  if (!decision.revert) s.lastRun = run
  if (decision.status !== 'continue') s.status = decision.status
  s.statusReasons = decision.reasons
  s.stopNudges = 0
  saveState(root, s)
  return { round: r.n, decision, compare: cmp, flaky, weakening, restored, discarded, run }
}

/**
 * Verified findings in the shape the eval grader reads.
 *
 * @param {string} root
 * @param {{ all?: boolean }} [opts] all: every non-rejected finding, not just confirmed ones
 */
export function exportFindings(root, opts = {}) {
  const s = requireState(root)
  return /** @type {Finding[]} */ (Object.values(s.ledger.findings))
    .filter(f => (opts.all ? f.status !== 'rejected' : f.status === 'confirmed' || f.status === 'fixed'))
    .map(f => ({
      id: f.id,
      title: f.title,
      file: f.file,
      line: f.line,
      endLine: f.endLine,
      severity: f.severity,
      tag: f.origin === 'pre-existing' ? 'pre-existing' : f.severity,
      category: f.category,
      bugClass: f.bugClass,
      explanation: f.explanation,
      failureScenario: f.failureScenario,
      status: f.status,
      votes: f.votes.length,
      lenses: f.lenses,
    }))
}

/** Closes a review-only loop once its findings are verified. @param {string} root */
export function finish(root) {
  const s = requireState(root)
  if (!s.reviewOnly) throw new LoopError('`ql finish` closes review-only loops; a fixing loop ends through `ql round end`')
  requirePhase(s, ['report'], 'finish')
  const r = currentRound(s)
  if (r) Object.assign(r, { ended: true, endedAt: new Date().toISOString(), reverted: false, startScore: 0, endScore: 0, found: 0, reasons: [] })
  s.status = 'done'
  s.statusReasons = ['review complete']
  saveState(root, s)
  return s
}

/** @param {string} root @param {string} reason */
export function pause(root, reason) {
  const s = requireState(root)
  if (s.status !== 'active') throw new LoopError(`loop is ${s.status}, not active`)
  if (!reason?.trim()) throw new LoopError('say what you need from the user: --reason "..."')
  s.status = 'paused'
  s.statusReasons = [reason.trim()]
  saveState(root, s)
  return s
}

/** @param {string} root */
export function resume(root) {
  const s = requireState(root)
  if (s.status !== 'paused') throw new LoopError(`loop is ${s.status}, not paused`)
  if (s.reproPassedAtStart) {
    throw new LoopError('the repro passed before any fix, so there is nothing to resume: build a repro that fails while the bug exists, then `ql start --mode debug --repro "<command>"`')
  }
  s.status = 'active'
  s.statusReasons = []
  s.stopNudges = 0
  saveState(root, s)
  return s
}

/** @param {string} root @param {string} reason */
export function abort(root, reason) {
  const s = requireState(root)
  s.status = 'aborted'
  s.statusReasons = [reason?.trim() || 'aborted by request']
  saveState(root, s)
  return s
}

/**
 * Lets the user raise the round cap after reviewing a capped or stalled
 * loop. Only the user can do this: the guard hook refuses the command when
 * the agent runs it, so it is run from the prompt with `!`.
 *
 * @param {string} root
 * @param {number} extra
 */
export function extend(root, extra) {
  const s = requireState(root)
  if (!['capped', 'stalled'].includes(s.status)) throw new LoopError(`loop is ${s.status}; only a capped or stalled loop can be extended`)
  s.config.loop.maxRounds = s.round + Math.max(1, extra)
  // Start the convergence counters afresh, or the stall that led here ends
  // the first granted round: attempts, reopens (oscillation), and the round
  // history that stall and divergence detection read.
  for (const f of /** @type {Finding[]} */ (Object.values(s.ledger.findings))) {
    f.reopens = 0
    if (f.status === 'stuck') {
      f.status = 'confirmed'
      f.attempts = 0
    }
  }
  s.extendedAt = s.round
  s.status = 'active'
  s.statusReasons = []
  saveState(root, s)
  return s
}
