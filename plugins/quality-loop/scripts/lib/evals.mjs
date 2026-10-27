// Grading and comparing reviewer eval runs. Pure: the runner that produces
// trials lives in evalrun.mjs.

import { normalizePath } from './glob.mjs'
import { bootstrapCI, mean } from './stats.mjs'

/**
 * @typedef {{ file: string, line: number, endLine?: number, description?: string, quote?: string }} ExpectedBug
 * @typedef {{ kind: 'bug' | 'clean', bugs: ExpectedBug[] }} Expected
 * @typedef {{ file: string, line: number, endLine?: number, severity?: string, tag?: string, origin?: string }} Predicted
 * @typedef {{ caseId: string, repeat: number, pass: boolean, tp: number, fp: number, fn: number, infraError: string | null }} Trial
 */

/**
 * Programmatic grader: a predicted finding matches an expected bug in the
 * same file whose line range its own range overlaps, give or take
 * `tolerance` lines. Matching is one-to-one and maximum (the most expected
 * bugs any assignment could cover), so the grade does not depend on the
 * order findings are listed in. A finding that overlaps only bugs other
 * findings already cover is a duplicate, not a false positive. Nits and
 * findings tagged pre-existing (outside the change) never count either way.
 *
 * @param {Expected} expected
 * @param {Predicted[]} predicted
 * @param {{ tolerance: number }} opts
 */
export function gradeCase(expected, predicted, opts) {
  const scored = predicted.filter(p => (p.severity ?? 'important') === 'important' && p.tag !== 'pre-existing' && p.origin !== 'pre-existing')
  const bugs = expected.kind === 'clean' ? [] : expected.bugs
  const hits = scored.map(p => {
    const file = normalizePath(p.file)
    const pEnd = Math.max(p.endLine ?? p.line, p.line)
    /** @type {number[]} */
    const out = []
    bugs.forEach((b, i) => {
      if (normalizePath(b.file) === file && p.line <= Math.max(b.endLine ?? b.line, b.line) + opts.tolerance && pEnd >= b.line - opts.tolerance) out.push(i)
    })
    return out
  })
  // Maximum bipartite matching (augmenting paths); the sets are tiny.
  /** @type {number[]} bug index -> finding index */
  const owner = bugs.map(() => -1)
  /** @param {number} u @param {Set<number>} seen @returns {boolean} */
  const augment = (u, seen) => {
    for (const b of hits[u] ?? []) {
      if (seen.has(b)) continue
      seen.add(b)
      const o = /** @type {number} */ (owner[b])
      if (o === -1 || augment(o, seen)) {
        owner[b] = u
        return true
      }
    }
    return false
  }
  let tp = 0
  for (let u = 0; u < scored.length; u++) if (augment(u, new Set())) tp++
  const fp = hits.filter(h => !h.length).length
  const duplicates = scored.length - fp - tp
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
 * Places cases that are new since a split was written, without moving any
 * case already placed (moving one would leak test cases into training). Each
 * new case, in a stable hash order, goes to whichever side keeps its kind's
 * test share at round(n × testFraction), so the test split keeps growing
 * when cases are added one at a time.
 *
 * @param {{ seed: number, train: string[], test: string[] }} existing
 * @param {{ id: string, kind: string }[]} cases every current case
 * @param {{ testFraction: number }} opts
 */
export function extendSplit(existing, cases, opts) {
  const train = new Set(existing.train)
  const test = new Set(existing.test)
  const isPlaced = (/** @type {{ id: string }} */ c) => train.has(c.id) || test.has(c.id)
  /** @type {Map<string, { id: string, kind: string }[]>} */
  const strata = new Map()
  for (const c of cases) strata.set(c.kind, [...(strata.get(c.kind) ?? []), c])
  for (const group of strata.values()) {
    let n = group.filter(isPlaced).length
    let k = group.filter(c => test.has(c.id)).length
    const fresh = group.filter(c => !isPlaced(c))
    fresh.sort((a, b) => hashInt(`${existing.seed}:${a.id}`) - hashInt(`${existing.seed}:${b.id}`) || (a.id < b.id ? -1 : 1))
    for (const c of fresh) {
      n++
      let target = Math.round(n * opts.testFraction)
      target = n >= 2 ? Math.min(Math.max(target, 1), n - 1) : 0
      if (k < target) {
        test.add(c.id)
        k++
      } else train.add(c.id)
    }
  }
  return { seed: existing.seed, train: [...train].sort(), test: [...test].sort() }
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
 *   infra errors in either run, or the
 *   runs scored different cases -> invalid (fix plumbing, rerun)
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
  // Infra-error trials are left out of the pass rates, so a candidate that
  // crashes or times out on exactly the hard cases would look better. Pass
  // rates are only comparable over the same cases with no plumbing noise.
  /** @type {string[]} */
  const problems = []
  for (const side of /** @type {const} */ (['train', 'test'])) {
    const infra = base[side].infraErrors + cand[side].infraErrors
    if (infra) problems.push(`${infra} infra error(s) on ${side} (base ${base[side].infraErrors}, candidate ${cand[side].infraErrors})`)
    const a = Object.keys(base[side].perCase).sort().join('\n')
    const b = Object.keys(cand[side].perCase).sort().join('\n')
    if (a !== b) problems.push(`the runs scored different ${side} cases`)
  }
  if (problems.length) {
    return { decision: 'invalid', ...d, reason: `cannot compare: ${problems.join('; ')}. Fix the cause and rerun; do not adopt the candidate` }
  }
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
