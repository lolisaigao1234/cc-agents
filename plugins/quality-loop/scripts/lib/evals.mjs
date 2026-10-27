// Grading and comparing reviewer eval runs. Pure: the runner that produces
// trials lives in evalrun.mjs.

import { normalizePath } from './glob.mjs'
import { bootstrapCI, mean } from './stats.mjs'

/**
 * @typedef {{ file: string, line: number, endLine?: number, description?: string, quote?: string }} ExpectedBug
 * @typedef {{ kind: 'bug' | 'clean', bugs: ExpectedBug[] }} Expected
 * @typedef {{ file: string, line: number, endLine?: number, severity?: string }} Predicted
 * @typedef {{ caseId: string, repeat: number, pass: boolean, tp: number, fp: number, fn: number, infraError: string | null }} Trial
 */

/**
 * Programmatic grader: a predicted finding matches an expected bug in the
 * same file whose line range it falls within, give or take `tolerance`
 * lines. Matching is one-to-one; a second report of an already-matched bug
 * is a duplicate, not a false positive. Nits never count either way.
 *
 * @param {Expected} expected
 * @param {Predicted[]} predicted
 * @param {{ tolerance: number }} opts
 */
export function gradeCase(expected, predicted, opts) {
  const important = predicted.filter(p => (p.severity ?? 'important') === 'important')
  const bugs = expected.kind === 'clean' ? [] : expected.bugs
  const matched = new Set()
  let fp = 0
  let duplicates = 0
  for (const p of important) {
    const file = normalizePath(p.file)
    const pEnd = p.endLine ?? p.line
    const hits = bugs
      .map((b, i) => ({ b, i }))
      .filter(
        ({ b }) =>
          normalizePath(b.file) === file && p.line <= (b.endLine ?? b.line) + opts.tolerance && pEnd >= b.line - opts.tolerance,
      )
    const free = hits.find(({ i }) => !matched.has(i))
    if (free) matched.add(free.i)
    else if (hits.length) duplicates++
    else fp++
  }
  const tp = matched.size
  const fn = bugs.length - tp
  return { tp, fp, fn, duplicates, pass: fn === 0 && fp === 0 }
}

/** FNV-1a hash as an unsigned int. @param {string} s */
function hashInt(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * Deterministic train/test split, stratified by case kind so both sides see
 * bug cases and should-not-fire cases.
 *
 * @param {{ id: string, kind: string }[]} cases
 * @param {{ seed: number, testFraction: number }} opts
 */
export function splitCases(cases, opts) {
  /** @type {Map<string, { id: string, kind: string }[]>} */
  const strata = new Map()
  for (const c of cases) strata.set(c.kind, [...(strata.get(c.kind) ?? []), c])
  /** @type {string[]} */ const train = []
  /** @type {string[]} */ const test = []
  for (const group of strata.values()) {
    const sorted = [...group].sort((a, b) => hashInt(`${opts.seed}:${a.id}`) - hashInt(`${opts.seed}:${b.id}`))
    let k = Math.round(sorted.length * opts.testFraction)
    if (sorted.length >= 2) k = Math.min(Math.max(k, 1), sorted.length - 1)
    else k = 0
    sorted.forEach((c, i) => (i < k ? test : train).push(c.id))
  }
  return { seed: opts.seed, train: train.sort(), test: test.sort() }
}

/**
 * Aggregates trials. Infrastructure errors (timeouts, crashes, missing
 * output) are counted apart so plumbing noise is not read as model failure.
 * The pass-rate interval bootstraps over cases, not trials, since repeats of
 * one case are not independent.
 *
 * @param {Trial[]} trials
 * @param {{ seed: number }} opts
 */
export function summarize(trials, opts) {
  const valid = trials.filter(t => !t.infraError)
  /** @type {Map<string, Trial[]>} */
  const byCase = new Map()
  for (const t of valid) byCase.set(t.caseId, [...(byCase.get(t.caseId) ?? []), t])
  /** @type {Record<string, number>} */
  const perCase = {}
  let flips = 0
  for (const [id, ts] of byCase) {
    perCase[id] = mean(ts.map(t => (t.pass ? 1 : 0)))
    if (ts.some(t => t.pass) && ts.some(t => !t.pass)) flips++
  }
  const tp = valid.reduce((a, t) => a + t.tp, 0)
  const fp = valid.reduce((a, t) => a + t.fp, 0)
  const fn = valid.reduce((a, t) => a + t.fn, 0)
  const precision = tp + fp ? tp / (tp + fp) : 1
  const recall = tp + fn ? tp / (tp + fn) : 1
  return {
    trials: valid.length,
    infraErrors: trials.length - valid.length,
    cases: byCase.size,
    passRate: bootstrapCI(Object.values(perCase), { seed: opts.seed }),
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    flipRate: byCase.size ? flips / byCase.size : 0,
    perCase,
  }
}

/**
 * The hill-climbing keep/revert rule:
 *   any regression beyond noise -> revert
 *   train up, test flat         -> revert (suspected overfitting)
 *   test up                     -> keep
 *   otherwise                   -> no change (within noise; do not merge)
 *
 * @param {{ train: ReturnType<typeof summarize>, test: ReturnType<typeof summarize> }} base
 * @param {{ train: ReturnType<typeof summarize>, test: ReturnType<typeof summarize> }} cand
 * @param {{ minDelta: number }} opts
 */
export function decideHillclimb(base, cand, opts) {
  const dTrain = cand.train.passRate.mean - base.train.passRate.mean
  const dTest = cand.test.passRate.mean - base.test.passRate.mean
  const d = { dTrain, dTest }
  if (dTrain <= -opts.minDelta || dTest <= -opts.minDelta) {
    return { decision: 'revert-regression', ...d, reason: 'a split got worse by at least the noise threshold' }
  }
  if (dTest >= opts.minDelta) return { decision: 'keep', ...d, reason: 'held-out test set improved' }
  if (dTrain >= opts.minDelta) {
    return { decision: 'revert-overfit', ...d, reason: 'train improved but held-out test stayed flat' }
  }
  return { decision: 'no-change', ...d, reason: 'difference is within noise' }
}

/** @param {string} s */
const words = s => s.toLowerCase().match(/[a-z0-9_]+/g) ?? []

const SHINGLE = 6

/**
 * Finds eval answers copied into a tuned surface (REVIEW.md, a lens prompt):
 * an expected bug's file path, or six consecutive words of its description
 * or quote. Pasting failures into the prompt is the most direct overfit.
 *
 * @param {string} text
 * @param {{ id: string, expected: { bugs: ExpectedBug[] } }[]} cases
 */
export function leakCheck(text, cases) {
  const haystack = ` ${words(text).join(' ')} `
  /** @type {{ caseId: string, kind: 'path' | 'phrase', match: string }[]} */
  const leaks = []
  for (const c of cases) {
    for (const b of c.expected.bugs) {
      const path = normalizePath(b.file)
      if (path.includes('/') && text.includes(path)) leaks.push({ caseId: c.id, kind: 'path', match: path })
      for (const source of [b.description, b.quote]) {
        const w = words(source ?? '')
        for (let i = 0; i + SHINGLE <= w.length; i++) {
          const phrase = w.slice(i, i + SHINGLE).join(' ')
          if (haystack.includes(` ${phrase} `)) {
            leaks.push({ caseId: c.id, kind: 'phrase', match: phrase })
            break
          }
        }
      }
    }
  }
  return leaks
}
