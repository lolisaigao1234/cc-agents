import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseUnifiedDiff } from '../plugins/quality-loop/scripts/lib/diff.mjs'
import {
  checkEvidence,
  fingerprint,
  ingestFindings,
  recordVotes,
  tallyVotes,
  validateFinding,
} from '../plugins/quality-loop/scripts/lib/findings.mjs'
import { newLedger } from '../plugins/quality-loop/scripts/lib/findings.mjs'

const FILE = [
  'function total(items) {',
  '  let sum = 0',
  '  for (let i = 0; i <= items.length; i++) {',
  '    sum += items[i].price',
  '  }',
  '  return sum',
  '}',
]

const DIFF = parseUnifiedDiff(`diff --git a/src/cart.js b/src/cart.js
--- a/src/cart.js
+++ b/src/cart.js
@@ -3 +3 @@
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
`)

const base = {
  title: 'Loop reads one past the end',
  file: 'src/cart.js',
  line: 3,
  quote: 'for (let i = 0; i <= items.length; i++) {',
  category: 'correctness',
  severity: 'important',
  bugClass: 'off-by-one',
  explanation: '`<=` makes the last iteration read items[items.length], which is undefined.',
  failureScenario: 'total([{price:1}]) throws TypeError',
}

const ctx = (overrides = {}) => ({
  round: 1,
  lens: 'correctness',
  diffFiles: DIFF,
  readLines: (/** @type {string} */ p) => (p === 'src/cart.js' ? FILE : null),
  config: { skipPaths: ['dist/**'], dropCategories: ['style'], maxNitsPerRound: 1 },
  ...overrides,
})

test('validateFinding: requires evidence fields and known severity', () => {
  assert.equal(validateFinding(base).ok, true)
  const bad = validateFinding({ ...base, line: 0, quote: '', severity: 'critical' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /line/)
  assert.match(bad.errors.join(' '), /quote/)
  assert.match(bad.errors.join(' '), /severity/)
})

test('checkEvidence: accepts a quote near the line, relocates a drifted one, rejects an invented one', () => {
  assert.deepEqual(checkEvidence(base, FILE), { ok: true, line: 3 })
  assert.deepEqual(checkEvidence({ ...base, line: 6, endLine: 6 }, FILE), { ok: true, line: 3 })
  assert.deepEqual(checkEvidence({ ...base, quote: 'items.forEach(x => x)' }, FILE), { ok: false, reason: 'quote-not-found' })
  assert.deepEqual(checkEvidence({ ...base, line: 99 }, FILE), { ok: false, reason: 'line-out-of-range' })
  assert.deepEqual(checkEvidence(base, null), { ok: false, reason: 'file-missing' })
})

test('fingerprint: stable across line shifts and whitespace', () => {
  assert.equal(fingerprint(base), fingerprint({ ...base, line: 10, quote: '  for (let i = 0;  i <= items.length; i++) {' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, bugClass: 'null-deref' }))
})

test('ingest: accepts, classifies origin, filters skip paths, dropped categories and bad evidence', () => {
  const ledger = newLedger()
  const { report } = ingestFindings(
    ledger,
    [
      base,
      { ...base, file: 'dist/bundle.js' },
      { ...base, category: 'style', bugClass: 'naming', title: 'name' },
      { ...base, quote: 'nonexistent code', bugClass: 'x' },
      { ...base, line: 6, quote: 'return sum', bugClass: 'unused', title: 'Old smell', severity: 'important', category: 'correctness' },
    ],
    ctx(),
  )
  assert.equal(report.accepted.length, 2)
  assert.equal(report.rejected.length, 3)
  const reasons = report.rejected.map(r => r.reason).sort()
  assert.deepEqual(reasons, ['dropped-category', 'quote-not-found', 'skip-path'])
  const [f1, f2] = report.accepted.map(id => ledger.findings[id])
  assert.equal(f1?.origin, 'introduced')
  assert.equal(f1?.status, 'candidate')
  assert.equal(f2?.origin, 'pre-existing')
})

test('ingest: merges duplicates across lenses and never repeats a rejected finding', () => {
  const ledger = newLedger()
  ingestFindings(ledger, [base], ctx())
  const second = ingestFindings(ledger, [{ ...base, title: 'Off by one in loop' }], ctx({ lens: 'regressions' }))
  assert.equal(second.report.accepted.length, 0)
  assert.equal(second.report.merged.length, 1)
  const [only] = Object.values(ledger.findings)
  assert.deepEqual(only?.lenses, ['correctness', 'regressions'])

  if (only) only.status = 'rejected'
  const third = ingestFindings(ledger, [base], ctx({ round: 2 }))
  assert.equal(third.report.repeats.length, 1)
  assert.equal(Object.keys(ledger.findings).length, 1)
})

test('ingest: a fixed finding that comes back is reopened and counted', () => {
  const ledger = newLedger()
  ingestFindings(ledger, [base], ctx())
  const [f] = Object.values(ledger.findings)
  if (!f) throw new Error('no finding')
  f.status = 'fixed'
  const again = ingestFindings(ledger, [base], ctx({ round: 3 }))
  assert.deepEqual(again.report.reopened, [f.id])
  assert.equal(f.status, 'candidate')
  assert.equal(f.reopens, 1)
  assert.deepEqual(f.votes, [])
})

test('ingest: caps nits per round, keeping the most confident', () => {
  const ledger = newLedger()
  const nit = { ...base, severity: 'nit', category: 'maintainability' }
  const { report } = ingestFindings(
    ledger,
    [
      { ...nit, bugClass: 'a', confidence: 0.2, line: 2, quote: 'let sum = 0' },
      { ...nit, bugClass: 'b', confidence: 0.9, line: 6, quote: 'return sum' },
    ],
    ctx(),
  )
  assert.equal(report.accepted.length, 1)
  assert.equal(ledger.findings[report.accepted[0] ?? '']?.bugClass, 'b')
  assert.equal(report.rejected[0]?.reason, 'nit-cap')
})

test('tallyVotes: quorum confirms, impossible quorum rejects, otherwise undecided', () => {
  const opts = { verifiers: 3, quorum: 2 }
  const v = (/** @type {'confirm'|'reject'} */ verdict, voter = Math.random().toString()) => ({ verdict, voter, reason: 'r' })
  assert.equal(tallyVotes([v('confirm'), v('confirm')], opts), 'confirmed')
  assert.equal(tallyVotes([v('reject'), v('reject')], opts), 'rejected')
  assert.equal(tallyVotes([v('confirm'), v('reject')], opts), 'undecided')
  assert.equal(tallyVotes([v('confirm', 'same'), v('confirm', 'same')], opts), 'undecided', 'one voter counts once')
})

test('recordVotes: applies quorum, takes majority severity, needs a reason', () => {
  const ledger = newLedger()
  const { report } = ingestFindings(ledger, [base], ctx())
  const id = report.accepted[0] ?? ''
  const out = recordVotes(
    ledger,
    [
      { id, verdict: 'confirm', voter: 'v1', reason: 'reproduced: TypeError', severity: 'important' },
      { id, verdict: 'confirm', voter: 'v2', reason: 'traced the loop bound', severity: 'nit' },
      { id, verdict: 'confirm', voter: 'v3', reason: 'same', severity: 'important' },
      { id, verdict: 'reject', voter: 'v4', reason: '' },
      { id: 'F404', verdict: 'confirm', voter: 'v1', reason: 'x' },
    ],
    { verifiers: 3, quorum: 2 },
  )
  assert.equal(ledger.findings[id]?.status, 'confirmed')
  assert.equal(ledger.findings[id]?.severity, 'important')
  assert.equal(out.invalid.length, 2)
})

test('ingest: distinct bugs on adjacent lines stay distinct (seen live: boundary + formula bug)', () => {
  const lines = [
    '/** Lines with a quantity of 10 or more get 10% off their unit price. */',
    'export function bulkDiscount(lines) {',
    '  return lines.map(line => {',
    '    if (line.qty > 10) {',
    '      return { ...line, price: Math.round(line.price * 0.1) }',
    '    }',
  ]
  const diff = parseUnifiedDiff(`diff --git a/src/p.js b/src/p.js
--- a/src/p.js
+++ b/src/p.js
@@ -0,0 +1,6 @@
${lines.map(l => `+${l}`).join('\n')}
`)
  const c = { ...ctx(), diffFiles: diff, readLines: (/** @type {string} */ p) => (p === 'src/p.js' ? lines : null) }
  const factor = { ...base, file: 'src/p.js', line: 5, quote: lines[4] ?? '', bugClass: 'wrong-discount-factor' }
  const bound = { ...base, file: 'src/p.js', line: 4, quote: lines[3] ?? '', bugClass: 'off-by-one-threshold' }
  const ledger = newLedger()
  ingestFindings(ledger, [factor, bound], c)
  // a second lens names both with different labels: they merge into the right ones
  const second = ingestFindings(ledger, [{ ...factor, bugClass: 'wrong-discount-multiplier' }, { ...bound, bugClass: 'boundary-off-by-one' }], { ...c, lens: 'security' })
  assert.equal(Object.keys(ledger.findings).length, 2)
  assert.equal(second.report.merged.length, 2)
  assert.deepEqual(Object.values(ledger.findings).map(f => f.lenses.length), [2, 2])
})

test('recordVotes: votes after a finding settles are kept but change nothing', () => {
  const ledger = newLedger()
  const id = ingestFindings(ledger, [base], ctx()).report.accepted[0] ?? ''
  const opts = { verifiers: 3, quorum: 2 }
  recordVotes(ledger, [{ id, verdict: 'confirm', voter: 'a', reason: 'x' }, { id, verdict: 'confirm', voter: 'b', reason: 'y' }], opts)
  const late = recordVotes(ledger, [{ id, verdict: 'reject', voter: 'c', reason: 'guarded upstream' }], opts)
  assert.deepEqual(late.invalid, [])
  assert.equal(late.outcome[id], 'already confirmed')
  assert.equal(ledger.findings[id]?.status, 'confirmed')
  assert.equal(ledger.findings[id]?.votes.length, 3)
})

// ---------------------------------------------------------------------------
// Ledger dedupe: only the same issue merges.

/** A file of `n` filler lines with code placed at the given 1-based lines. */
const fileOf = (/** @type {number} */ n, /** @type {Record<number, string>} */ code) =>
  Array.from({ length: n }, (_, i) => code[i + 1] ?? `  step(${i + 1})`)

/** An ingest context over one file, `src/m.js`, that the diff does not touch. */
const ctxFor = (/** @type {string[]} */ lines, overrides = {}) =>
  ctx({ diffFiles: [], readLines: (/** @type {string} */ p) => (p === 'src/m.js' ? lines : null), ...overrides })

const at = (/** @type {number} */ line, /** @type {string} */ quote, extra = {}) => ({
  ...base,
  file: 'src/m.js',
  line,
  quote,
  title: `bug at ${line}`,
  ...extra,
})

test('ingest: a different bug of the same class near a rejected finding is new, not a repeat', () => {
  const lines = fileOf(40, { 30: '  if (x > 10) {', 32: '  y = items[i + 1]' })
  const ledger = newLedger()
  ingestFindings(ledger, [at(30, 'if (x > 10) {')], ctxFor(lines))
  const f1 = ledger.findings.F1
  if (!f1) throw new Error('no F1')
  f1.status = 'rejected'
  const r2 = ingestFindings(ledger, [at(32, 'y = items[i + 1]')], ctxFor(lines, { round: 2 }))
  assert.deepEqual(r2.report.repeats, [])
  assert.deepEqual(r2.report.accepted, ['F2'])
  assert.equal(ledger.findings.F2?.line, 32)
})

test('ingest: two instances of one bug class on adjacent lines stay separate in one batch', () => {
  const lines = fileOf(40, { 30: '  a = xs[i + 1]', 31: '  b = ys[i + 1]' })
  const ledger = newLedger()
  const { report } = ingestFindings(ledger, [at(30, 'a = xs[i + 1]'), at(31, 'b = ys[i + 1]')], ctxFor(lines))
  assert.deepEqual(report.accepted, ['F1', 'F2'])
})

test('ingest: two lenses quoting different parts of one line with one bug class merge', () => {
  const lines = fileOf(40, { 30: '  for (let i = 0; i <= n; i++) {' })
  const ledger = newLedger()
  ingestFindings(ledger, [at(30, 'for (let i = 0; i <= n; i++) {')], ctxFor(lines))
  const r2 = ingestFindings(ledger, [at(30, 'i <= n')], ctxFor(lines, { lens: 'security' }))
  assert.deepEqual(r2.report.merged, ['F1'])
})

test('ingest: identical code at two lines is two instances, kept apart across rounds and stable under edits', () => {
  const quote = 'const cap = order.total'
  const lines = fileOf(60, { 10: `  ${quote}`, 40: `  ${quote}` })
  const ledger = newLedger()
  const r1 = ingestFindings(ledger, [at(10, quote), at(40, quote)], ctxFor(lines))
  assert.deepEqual(r1.report.accepted, ['F1', 'F2'])
  assert.deepEqual(Object.values(ledger.findings).map(f => f.line), [10, 40])
  assert.notEqual(ledger.findings.F1?.fingerprint, ledger.findings.F2?.fingerprint)

  // F1 is guarded at line 10; the instance at 40 is still its own finding.
  const f1 = ledger.findings.F1
  if (f1) f1.status = 'rejected'
  // A fix elsewhere inserts three lines above both instances.
  const edited = [...lines.slice(0, 5), '  a()', '  b()', '  c()', ...lines.slice(5)]
  const r2 = ingestFindings(
    ledger,
    [at(13, quote), at(43, quote, { title: 'again', category: 'security' })],
    ctxFor(edited, { round: 2, lens: 'security' }),
  )
  assert.deepEqual(r2.report.repeats, ['F1'])
  assert.deepEqual(r2.report.merged, ['F2'])
  assert.deepEqual(r2.report.accepted, [])
  assert.equal(Object.keys(ledger.findings).length, 2)
})

test('ingest: a rejected instance does not swallow a later report of the other instance', () => {
  const quote = 'const cap = order.total'
  const lines = fileOf(60, { 10: `  ${quote}`, 40: `  ${quote}` })
  const ledger = newLedger()
  ingestFindings(ledger, [at(10, quote)], ctxFor(lines))
  const f1 = ledger.findings.F1
  if (f1) f1.status = 'rejected'
  const r2 = ingestFindings(ledger, [at(40, quote)], ctxFor(lines, { round: 2 }))
  assert.deepEqual(r2.report.repeats, [])
  assert.deepEqual(r2.report.accepted, ['F2'])
})

test('ingest: when one copy is fixed, a report of the other copy goes to its own finding', () => {
  const quote = 'const cap = order.total'
  const lines = fileOf(60, { 10: `  ${quote}`, 30: `  ${quote}` })
  const ledger = newLedger()
  ingestFindings(ledger, [at(10, quote), at(30, quote)], ctxFor(lines))
  const [f1, f2] = [ledger.findings.F1, ledger.findings.F2]
  if (!f1 || !f2) throw new Error('missing findings')
  f1.status = 'fixed'
  f2.status = 'rejected'
  const fixed = fileOf(60, { 10: '  const cap = toUsd(order.total)', 30: `  ${quote}` })
  const r2 = ingestFindings(ledger, [at(30, quote)], ctxFor(fixed, { round: 2 }))
  assert.deepEqual(r2.report.reopened, [])
  assert.deepEqual(r2.report.repeats, ['F2'])
  assert.equal(f1.status, 'fixed')
})

test('ingest: the same short quote elsewhere in the file is not a repeat of a rejected finding', () => {
  const lines = fileOf(60, { 20: '  return null', 50: '  return null' })
  const ledger = newLedger()
  ingestFindings(ledger, [at(20, 'return null', { bugClass: 'missing-error' })], ctxFor(lines))
  const f1 = ledger.findings.F1
  if (f1) f1.status = 'rejected'
  const r2 = ingestFindings(
    ledger,
    [at(50, 'return null', { bugClass: 'null-contract-violation', title: 'real bug' })],
    ctxFor(lines, { round: 2 }),
  )
  assert.deepEqual(r2.report.repeats, [])
  assert.deepEqual(r2.report.accepted, ['F2'])
  // The same code at the same place under another label is still the rejected finding.
  const r3 = ingestFindings(ledger, [at(20, 'return null', { bugClass: 'null-contract-violation' })], ctxFor(lines, { round: 3 }))
  assert.deepEqual(r3.report.repeats, ['F1'])
})

test('ingest: a reopened finding takes the new report, and a new bug near a fixed one is not a reopen', () => {
  const lines = fileOf(80, { 30: '  if (x > 10) {', 32: '  y = items[i + 1]' })
  const ledger = newLedger()
  ingestFindings(
    ledger,
    [at(30, 'if (x > 10) {', { title: 'threshold should be >=', explanation: 'boundary', severity: 'nit' })],
    ctxFor(lines),
  )
  const f1 = ledger.findings.F1
  if (!f1) throw new Error('no F1')
  f1.status = 'fixed'
  const oldPrint = f1.fingerprint

  const near = ingestFindings(ledger, [at(32, 'y = items[i + 1]', { title: 'reads one past the end of items' })], ctxFor(lines, { round: 2 }))
  assert.deepEqual(near.report.reopened, [])
  assert.deepEqual(near.report.accepted, ['F2'])
  assert.equal(f1.status, 'fixed')

  // The fix did not hold: the same code is reported again, moved far down by an edit.
  const moved = [...fileOf(40, {}), ...lines]
  const back = ingestFindings(
    ledger,
    [
      at(70, '  if (x  > 10) {', {
        title: 'still > instead of >=',
        explanation: 'the fix was reverted',
        failureScenario: 'qty 10 gets no discount',
        severity: 'important',
      }),
    ],
    ctxFor(moved, { round: 3 }),
  )
  assert.deepEqual(back.report.reopened, ['F1'])
  assert.equal(f1.status, 'candidate')
  assert.equal(f1.line, 70)
  assert.equal(f1.title, 'still > instead of >=')
  assert.equal(f1.explanation, 'the fix was reverted')
  assert.equal(f1.failureScenario, 'qty 10 gets no discount')
  assert.equal(f1.severity, 'important')
  assert.equal(f1.quote, '  if (x  > 10) {')
  assert.equal(f1.fingerprint, oldPrint)
})

test('ingest: a finding in a git-quoted non-ASCII path is classified against the diff', () => {
  const lines = ['export const price = 1', 'export const tax = price * 0.2']
  const diff = parseUnifiedDiff(`diff --git "a/src/caf\\303\\251.js" "b/src/caf\\303\\251.js"
new file mode 100644
--- /dev/null
+++ "b/src/caf\\303\\251.js"
@@ -0,0 +1,2 @@
+${lines[0]}
+${lines[1]}
`)
  const ledger = newLedger()
  const { report } = ingestFindings(
    ledger,
    [{ ...base, file: 'src/café.js', line: 2, quote: lines[1] }],
    ctx({ diffFiles: diff, readLines: (/** @type {string} */ p) => (p === 'src/café.js' ? lines : null) }),
  )
  assert.deepEqual(report.accepted, ['F1'])
  assert.equal(ledger.findings.F1?.origin, 'introduced')
})

test('recordVotes: a vote without a voter is invalid, so re-recording a vote file cannot reach quorum', () => {
  const ledger = newLedger()
  const id = ingestFindings(ledger, [base], ctx()).report.accepted[0] ?? ''
  const opts = { verifiers: 3, quorum: 2 }
  const anon = { id, verdict: 'confirm', reason: 'x' }
  const first = recordVotes(ledger, [anon], opts)
  const second = recordVotes(ledger, [anon], opts)
  assert.equal(first.invalid.length, 1)
  assert.match(first.invalid[0]?.reason ?? '', /voter/)
  assert.equal(second.invalid.length, 1)
  assert.equal(ledger.findings[id]?.status, 'candidate')
  assert.deepEqual(ledger.findings[id]?.votes, [])
})

test('recordVotes: a batch settles in arrival order, as if its votes were recorded one by one', () => {
  const opts = { verifiers: 3, quorum: 2 }
  const batch = (/** @type {string} */ id) =>
    ['confirm', 'reject', 'reject', 'confirm'].map((verdict, i) => ({ id, verdict, voter: `v${i + 1}`, reason: 'r' }))

  const together = newLedger()
  const id = ingestFindings(together, [base], ctx()).report.accepted[0] ?? ''
  const out = recordVotes(together, batch(id), opts)

  const oneByOne = newLedger()
  ingestFindings(oneByOne, [base], ctx())
  for (const v of batch(id)) recordVotes(oneByOne, [v], opts)

  assert.equal(oneByOne.findings[id]?.status, 'rejected')
  assert.equal(together.findings[id]?.status, 'rejected')
  assert.equal(out.outcome[id], 'rejected')
  assert.equal(together.findings[id]?.votes.length, 4, 'the late vote is kept for the record')
})

test('checkEvidence: a cited line past the end of a shortened file is still relocated', () => {
  const lines = fileOf(60, { 50: '  return null' })
  assert.deepEqual(checkEvidence({ line: 62, quote: 'return null' }, lines), { ok: true, line: 50 })
  assert.deepEqual(checkEvidence({ line: 58, quote: 'return null' }, lines), { ok: true, line: 50 })
  assert.deepEqual(checkEvidence({ line: 62, quote: 'not here' }, lines), { ok: false, reason: 'quote-not-found' })
  assert.deepEqual(checkEvidence({ line: 99, quote: 'return null' }, lines), { ok: false, reason: 'line-out-of-range' })
})
