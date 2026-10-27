// The loop's lifecycle: start, rounds (begin, review scope, ingest, vote,
// mark, end), pause, resume, abort. Each operation loads the state, checks
// it is in the right phase, changes it and saves it with LOOP.md.

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { compareRuns, runChecks } from './checks.mjs'
import { detectChecks, lensFocus, resolveConfig, validateConfig } from './config.mjs'
import { decideRound, scoreOf } from './decide.mjs'
import { parseUnifiedDiff, rangeTouches } from './diff.mjs'
import { checkEvidence, decodeGitPath, ingestFindings, newLedger, recordVotes } from './findings.mjs'
import { checkpointTree, diffTrees, resolveBase, restoreTree, snapshotTree } from './git.mjs'
import { normalizePath } from './glob.mjs'
import { counts, currentRound, inScope, phaseOf, renderLoopMd } from './report.mjs'
import { GITIGNORE, paths, readJson, writeJson, writeText } from './store.mjs'
import { holdsCap, readTombstone, recordLoop } from './tombstone.mjs'
import { scanWeakening } from './weakening.mjs'

// Statuses the record keeps until the user extends the loop or starts over.
const STOPPED = ['capped', 'stalled', 'aborted']

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

/**
 * @param {string} root
 * @param {any} s
 * @param {'start' | 'extend' | 'end'} [how] `ql start` records a new loop, `ql extend` lifts its cap, `ql round end` and `ql finish` decide its status (see recordLoop)
 */
export function saveState(root, s, how) {
  s.updatedAt = new Date().toISOString()
  writeJson(paths(root).state, s)
  writeText(paths(root).loopMd, renderLoopMd(s))
  recordLoop(root, s, how)
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
 * Why `ql start` without --force must not replace `prev`, or null when it
 * may. Starting over resets the round cap, which only the user may lift, so
 * a loop that spent rounds without finishing (capped, stalled, paused,
 * aborted) is replaced only with --force, which the guard keeps from the
 * agent. A loop that never began a round, or a review-only one, has no cap
 * to dodge.
 *
 * @param {any} prev
 */
export function restartRefusal(prev) {
  if (!prev) return null
  if (prev.status === 'active') {
    return `a loop is already active (${prev.id}, round ${prev.round}); continue it (\`ql next\`). Only the user may start over (\`! ql start --force ...\`).`
  }
  if (prev.status === 'done' || prev.reviewOnly) return null
  if (!(prev.round > 0) && !['capped', 'stalled'].includes(prev.status)) return null
  if (prev.status === 'paused') {
    return `the loop ${prev.id} is paused at round ${prev.round}: \`ql resume\` it once the user has answered. Starting over would reset its round cap, which only the user may do (\`! ql start --force ...\`).`
  }
  return `the loop ${prev.id} ended ${prev.status} after ${prev.round} round(s) without reaching its finish line. Starting over would reset its round cap, which only the user may do: report to the user, who can run \`! ql extend\` or \`! ql start --force ...\`.`
}

/**
 * Why `ql start` without --force must not start a loop in `root`, given its
 * state file (`prev`, possibly gone). The tombstone in the git directory
 * holds the status ql last saved, so it speaks for a loop whose state was
 * deleted, replaced or edited outside ql: removing `.quality-loop/`, or
 * marking the state done by hand, does not reset the cap.
 *
 * @param {string} root
 * @param {any} prev
 */
export function startRefusal(root, prev) {
  const own = restartRefusal(prev)
  if (own) return own
  const t = readTombstone(root)
  if (!t || !holdsCap(t)) return null
  const how = t.id === prev?.id ? 'edited outside ql' : prev ? 'replaced' : 'deleted'
  return `the loop ${t.id} was ${t.status} at round ${t.round}${t.maxRounds ? ` of ${t.maxRounds}` : ''} when its state in .quality-loop/ was ${how}. Starting over would reset its round cap, which only the user may do: report to the user, who can run \`! ql start --force ...\`.`
}

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
  const refusal = opts.force ? null : startRefusal(root, prev)
  if (refusal) throw new LoopError(refusal)
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
    // The Claude Code session running the loop; bound by the hooks (hooks.mjs).
    sessionId: /** @type {string | null} */ (null),
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
    saveState(root, s, 'start')
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
  saveState(root, s, 'start')
  return s
}

/** @param {string} root */
export function beginRound(root) {
  const s = requireState(root)
  requirePhase(s, ['begin'], 'begin a round')
  // The record, not the state, says whether the loop may run on: a state
  // edited back to active, or put in place of a loop that holds the cap,
  // runs no rounds (see recordLoop).
  const t = readTombstone(root)
  const held = t && (t.id === s.id ? STOPPED.includes(t.status) : holdsCap(t))
  if (t && held) {
    throw new LoopError(
      `ql records the loop here (${t.id}) as ${t.status} at round ${t.round}; the state in .quality-loop/ says otherwise, so it was edited outside ql. Only the user may extend it (\`! ql extend\`) or start over (\`! ql start --force ...\`). Report to the user.`,
    )
  }
  s.round += 1
  s.rounds.push({
    n: s.round,
    startCheckpoint: checkpointTree(root),
    // The ledger as the round found it, for a revert to put back a finding
    // the round re-reported on code of its own (see endRound). Dropped when
    // the round ends.
    preRound: structuredClone(s.ledger.findings),
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
  const { diffOnly, from, diff, tree } = scopeDiff(root, s)
  if (dropStaleEmptyScope(s, diff, tree)) saveState(root, s)
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
  const tree = snapshotTree(root)
  return { diffOnly, from, tree, diff: diffTrees(root, from, tree) }
}

/**
 * Whether an important confirmed in-scope finding is open: the fix step an
 * empty-scope record is kept for. An open nit never blocks the finish line,
 * so it does not keep the fix step (and its exemption from review) going.
 *
 * @param {any} s
 */
const fixPending = s =>
  /** @type {Finding[]} */ (Object.values(s.ledger.findings)).some(f => f.status === 'confirmed' && f.severity === 'important' && inScope(s, f))

/**
 * An empty scope recorded with `ingest --none --lens scope` closes the review
 * only while the scope stays empty. In debug mode the fix lands after `round
 * begin`; once anything changes, the record no longer holds and every lens
 * must review the change. Returns whether the record was dropped.
 *
 * The one exception is the round's fix step: recorded while important
 * findings were open (and no debug fix was still to come), the review closed
 * and `ql next` went on to ask for fixes, which are reviewed next round as in
 * any round. The fix step ends when the last open important finding is
 * marked (`fixEndTree`); a change after that is unreviewed again, and `ql
 * next` says so (`editsNeedReview`).
 *
 * @param {any} s
 * @param {string} diff the current scope diff
 * @param {string} tree the current tree
 */
function dropStaleEmptyScope(s, diff, tree) {
  const r = currentRound(s)
  if (!r?.lensesDone?.includes('scope') || !diff.trim()) return false
  if (r.scopeEmptyBeforeFix && (r.fixEndTree ? r.fixEndTree === tree : fixPending(s))) return false
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
  if (s && currentRound(s)) {
    const { diff, tree } = scopeDiff(root, s)
    if (dropStaleEmptyScope(s, diff, tree)) saveState(root, s)
  }
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
  const { diff: scopeNow, tree } = scopeDiff(root, s)
  dropStaleEmptyScope(s, scopeNow, tree)
  if (lens === 'scope') {
    if (raws !== null) throw new LoopError('the lens "scope" only records an empty scope: `ql ingest --none --lens scope`')
    if (scopeNow.trim()) {
      throw new LoopError(`the scope is not empty: review it with one bug hunter per lens (${lenses.join(', ')}) and ingest each`)
    }
    // With important findings open, `ql next` goes on to the fix step, whose
    // changes must not make the record stale (see dropStaleEmptyScope). With
    // none, any change is unreviewed, and `ql next` says so
    // (editsNeedReview). A debug round whose repro still fails has its
    // root-cause fix still to come, and that fix is reviewed this round
    // whatever else is open.
    const debugFixToCome = !!s.repro && !s.lastRun?.results?.find((/** @type {any} */ x) => x.name === 'repro')?.ok
    r.scopeEmptyBeforeFix = !debugFixToCome && fixPending(s)
    delete r.fixEndTree
  } else if (raws === null && !lenses.includes(lens)) {
    throw new LoopError(`\`ql ingest --none\` needs --lens naming a configured lens (${lenses.join(', ')}), or --lens scope for an empty scope; got "${lens || '(none)'}"`)
  }
  const diffFiles = parseUnifiedDiff(diffTrees(root, s.baseCommit, tree, { context: 0 }))
  const { report } = ingestFindings(s.ledger, raws ?? [], {
    round: s.round,
    lens,
    diffFiles,
    readLines: f => readLines(root, f),
    config: s.config.review,
  })
  // Where each finding reported now sits in the round-start tree, decided by
  // the round's diff so far, for a revert to put it back (see endRound).
  const reported = [...report.accepted, ...report.merged, ...report.repeats, ...report.reopened]
  if (reported.length) {
    const sinceStart = parseUnifiedDiff(diffTrees(root, r.startCheckpoint, tree, { context: 0 }))
    r.startLines ??= {}
    for (const id of reported) {
      const f = s.ledger.findings[id]
      if (f) r.startLines[id] = lineAtRoundStart(f, diffOf(sinceStart, f.file))
    }
  }
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
  const r = currentRound(s)
  if (status === 'fixed') r.fixedIds.push(id)
  // The last open important finding marked ends the fix step an empty-scope
  // record was kept for: from here on, a change is unreviewed
  // (dropStaleEmptyScope).
  // Once nothing is left to fix, an empty-scope record that does not cover
  // the tree as it is now goes, so the `next:` line asks for the review
  // `round end` would (dropStaleEmptyScope).
  if (r.lensesDone?.includes('scope') && !fixPending(s)) {
    const { diff, tree } = scopeDiff(root, s)
    if (r.scopeEmptyBeforeFix && !r.fixEndTree) r.fixEndTree = tree
    dropStaleEmptyScope(s, diff, tree)
  }
  saveState(root, s)
  return f
}

/** @param {Finding} f the number of lines its quote spans */
const quoteHeight = f => Math.max(1, f.quote.trim().split('\n').length)

/**
 * The old-side line that the unchanged new-side `line` came from. A diff
 * keeps unchanged lines in order, so the k-th unchanged line on one side is
 * the k-th on the other.
 *
 * @param {import('./diff.mjs').DiffFile} df
 * @param {number} line
 */
function toOldLine(df, line) {
  const removed = new Set(df.removed.map(x => x.line))
  let k = line - df.added.filter(a => a.line < line).length
  let old = 0
  while (k > 0) {
    old++
    if (!removed.has(old)) k--
  }
  return old
}

/**
 * Where a finding, just reported on the current tree, sits in the tree the
 * round started from, or null when any line of its quote was added by the
 * round so far (its code is the round's own, typically a debug fix). Decided
 * by the round's diff, never by the quote text, so a revert neither drops a
 * finding on older code the fixer later moved or re-indented, nor moves one
 * on the round's own code onto an unrelated copy of the same text.
 *
 * @param {Finding} f
 * @param {import('./diff.mjs').DiffFile | undefined} df the round's diff of the file so far
 * @returns {number | null}
 */
function lineAtRoundStart(f, df) {
  if (!df) return f.line
  if (df.status === 'added') return null
  const added = new Set(df.added.map(a => a.line))
  for (let l = f.line; l < f.line + quoteHeight(f); l++) if (added.has(l)) return null
  return toOldLine(df, f.line)
}

/**
 * @param {import('./diff.mjs').DiffFile[]} files
 * @param {string} file
 */
const diffOf = (files, file) => files.find(d => d.path === file || normalizePath(decodeGitPath(d.path)) === file)

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
  const now = currentRound(s) && scopeDiff(root, s)
  if (now && dropStaleEmptyScope(s, now.diff, now.tree)) {
    saveState(root, s)
    throw new LoopError(
      `the scope was recorded empty, but the tree has changed since: review the change (\`ql scope\`) with one bug hunter per lens (${s.config.review.lenses.join(', ')}) and ingest each before \`ql round end\``,
    )
  }
  requirePhase(s, ['fix', 'end'], 'end the round')
  // The tombstone holds the round count and budget as ql last saved them
  // (see the decision below); a state that is not the loop it records was
  // put in place outside ql, and its rounds count for nothing.
  const t = readTombstone(root)
  if (t && t.id !== s.id && holdsCap(t)) {
    throw new LoopError(
      `the loop state in .quality-loop/ (${s.id}) is not the loop ql last recorded here (${t.id}, ${t.status} at round ${t.round}): it was replaced outside ql. Report to the user; only they can start over (\`! ql start --force ...\`).`,
    )
  }
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
    // Findings reported this round go back to where they sat at round
    // start, as their ingest recorded it from the round's diff.
    /** @type {Record<string, number | null>} */
    const startLines = r.startLines ?? {}
    const baseDiff = parseUnifiedDiff(diffTrees(root, s.baseCommit, snapshotTree(root), { context: 0 }))
    for (const f of all) {
      if (!(f.id in startLines) || !['candidate', 'confirmed'].includes(f.status)) continue
      const start = startLines[f.id]
      const lines = readLines(root, f.file)
      const was = r.preRound?.[f.id]
      if ((start === null || lines === null) && was) {
        // An older finding re-reported (or reopened) on the round's own
        // code: what the round did to it goes with that code, so it is as
        // the round found it (a fixed one stays fixed).
        s.ledger.findings[f.id] = was
        continue
      }
      if ((start === null || lines === null) && f.firstRound === r.n) {
        // Reported on the round's own code (typically the reverted fix),
        // which no longer exists: keeping it open would block the loop on
        // nothing. If the code comes back, the next review reports it afresh.
        discarded.push({ id: f.id, title: f.title, file: f.file, line: f.line, reason: 'its code was the reverted round\'s own' })
        delete s.ledger.findings[f.id]
        continue
      }
      if (lines === null) continue
      // Its round-start line; without a record of the ledger at round start
      // (a round begun by an older ql), an older finding re-reported on the
      // round's code is looked for near the line it had.
      const ev = checkEvidence(start === null ? f : { ...f, line: start }, lines)
      const at = ev.ok ? ev.line : start
      if (at === null) continue
      f.endLine = at + (f.endLine - f.line)
      f.line = at
      // Whether the change touches it depends on what the revert left.
      const df = diffOf(baseDiff, f.file)
      f.origin = df && rangeTouches(df, f.line, f.endLine, 1) ? 'introduced' : 'pre-existing'
    }
  }
  delete r.preRound
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
  // A state edited outside ql neither winds the round back nor raises the cap.
  const own = t?.id === s.id ? t : null
  const decided = decideRound({
    mode: s.mode,
    round: own ? Math.max(s.round, Number(own.round) || 0) : s.round,
    limits: {
      maxRounds: typeof own?.maxRounds === 'number' ? Math.min(s.config.loop.maxRounds, own.maxRounds) : s.config.loop.maxRounds,
      stallRounds: s.config.loop.stallRounds,
    },
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
  // What a revert could not undo (a moved HEAD, nested repositories, write
  // failures) needs a human before another round builds on it: the decision
  // itself says paused, so nothing reads it as "the edits are gone".
  const incomplete = restored?.problems ?? []
  const decision = incomplete.length
    ? {
        ...decided,
        status: decided.status === 'continue' ? /** @type {const} */ ('paused') : decided.status,
        reasons: [...decided.reasons, ...incomplete.map(p => `revert incomplete: ${p}`)],
      }
    : decided

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
  saveState(root, s, 'end')
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
  saveState(root, s, 'end')
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
  // A state edited out of capped or stalled is still the loop its record holds.
  const t = readTombstone(root)
  const recorded = !!t && t.id === s.id && ['capped', 'stalled'].includes(t.status)
  if (!['capped', 'stalled'].includes(s.status) && !recorded) throw new LoopError(`loop is ${s.status}; only a capped or stalled loop can be extended`)
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
  saveState(root, s, 'extend')
  return s
}
