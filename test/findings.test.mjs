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
