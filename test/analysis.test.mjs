import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseUnifiedDiff } from '../plugins/quality-loop/scripts/lib/diff.mjs'
import { isTestFile, scanWeakening } from '../plugins/quality-loop/scripts/lib/weakening.mjs'
import { compareRuns, parseTestCounts } from '../plugins/quality-loop/scripts/lib/checks.mjs'
import { bootstrapCI, mulberry32 } from '../plugins/quality-loop/scripts/lib/stats.mjs'
import { gradeCase, splitCases, summarize, decideHillclimb, leakCheck } from '../plugins/quality-loop/scripts/lib/evals.mjs'

test('isTestFile recognises common conventions', () => {
  for (const p of ['src/a.test.ts', 'tests/x.py', 'pkg/a_test.go', 'test_util.py', 'src/__tests__/b.js', 'a.spec.js']) {
    assert.ok(isTestFile(p), p)
  }
  for (const p of ['src/testing.ts', 'src/contest.js', 'latest.go']) assert.ok(!isTestFile(p), p)
})

test('scanWeakening flags skips, focus, suppressions, deleted tests and dropped assertions', () => {
  const diff = parseUnifiedDiff(`diff --git a/src/a.test.js b/src/a.test.js
--- a/src/a.test.js
+++ b/src/a.test.js
@@ -1,4 +1,3 @@
-test('x', () => {
+test.skip('x', () => {
-  expect(f()).toBe(1)
-  expect(g()).toBe(2)
+  expect(f()).toBe(1)
 })
diff --git a/src/b.js b/src/b.js
--- a/src/b.js
+++ b/src/b.js
@@ -1 +1,2 @@
+// @ts-ignore
 const x = 1
diff --git a/tests/test_c.py b/tests/test_c.py
deleted file mode 100644
--- a/tests/test_c.py
+++ /dev/null
@@ -1 +0,0 @@
-def test_c(): assert True
diff --git a/src/d.test.js b/src/d.test.js
--- a/src/d.test.js
+++ b/src/d.test.js
@@ -1 +1 @@
-describe('d', () => {})
+describe.only('d', () => {})
`)
  const found = scanWeakening(diff)
  const kinds = found.map(f => `${f.kind}:${f.file}`).sort()
  assert.deepEqual(kinds, [
    'assertions-removed:src/a.test.js',
    'focus-added:src/d.test.js',
    'skip-added:src/a.test.js',
    'suppression-added:src/b.js',
    'test-file-deleted:tests/test_c.py',
  ])
  assert.equal(found.find(f => f.kind === 'suppression-added')?.blocking, false)
  assert.equal(found.find(f => f.kind === 'skip-added')?.blocking, true)
})

test('parseTestCounts reads jest, vitest, pytest, node:test, mocha, cargo and go', () => {
  assert.deepEqual(parseTestCounts('Tests:       1 failed, 2 skipped, 10 passed, 13 total'), { passed: 10, failed: 1, skipped: 2 })
  assert.deepEqual(parseTestCounts(' Tests  1 failed | 2 passed (3)'), { passed: 2, failed: 1, skipped: 0 })
  assert.deepEqual(parseTestCounts('==== 3 passed, 1 failed, 2 skipped in 0.12s ===='), { passed: 3, failed: 1, skipped: 2 })
  assert.deepEqual(parseTestCounts('ℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ skipped 0'), { passed: 4, failed: 1, skipped: 0 })
  assert.deepEqual(parseTestCounts('# pass 7\n# fail 0'), { passed: 7, failed: 0, skipped: 0 })
  assert.deepEqual(parseTestCounts('  5 passing (20ms)\n  1 failing\n  2 pending'), { passed: 5, failed: 1, skipped: 2 })
  assert.deepEqual(
    parseTestCounts('test result: ok. 3 passed; 0 failed; 1 ignored\ntest result: ok. 2 passed; 1 failed; 0 ignored'),
    { passed: 5, failed: 1, skipped: 1 },
  )
  assert.deepEqual(parseTestCounts('--- PASS: TestA\n--- PASS: TestB\n--- FAIL: TestC\n--- SKIP: TestD'), { passed: 2, failed: 1, skipped: 1 })
  assert.equal(parseTestCounts('build ok'), null)
})

test('compareRuns: newly failing required checks are regressions, test-count drops too', () => {
  const run = (/** @type {Record<string, [boolean, number?]>} */ m) => ({
    label: 'x',
    results: Object.entries(m).map(([name, [ok, passed]]) => ({
      name, ok, required: name !== 'lint', exitCode: ok ? 0 : 1, timedOut: false, durationMs: 1, tail: '', logFile: '',
      counts: passed === undefined ? null : { passed, failed: 0, skipped: 0 },
    })),
  })
  const before = run({ test: [true, 40], build: [false], lint: [true] })
  const after = run({ test: [true, 35], build: [true], lint: [false] })
  const c = compareRuns(before, after)
  assert.deepEqual(c.newlyFailing, ['lint'])
  assert.deepEqual(c.newlyFailingRequired, [])
  assert.deepEqual(c.fixed, ['build'])
  assert.deepEqual(c.testCountDrops, [{ name: 'test', before: 40, after: 35 }])
  const worse = compareRuns(before, run({ test: [false, 40], build: [false], lint: [true] }))
  assert.deepEqual(worse.newlyFailingRequired, ['test'])
})

test('stats: seeded RNG is deterministic; bootstrap CI brackets the mean', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  assert.equal(a(), b())
  const ci = bootstrapCI([1, 0, 1, 1, 0, 1, 1, 1], { seed: 1 })
  assert.ok(ci.lo <= ci.mean && ci.mean <= ci.hi)
  assert.equal(ci.mean, 0.75)
  assert.deepEqual(bootstrapCI([], { seed: 1 }), { mean: 0, lo: 0, hi: 0 })
})

test('gradeCase: one-to-one matching by file and line tolerance; clean cases count any important finding', () => {
  const expected = [{ file: 'src/a.js', line: 10 }, { file: 'src/b.js', line: 5, endLine: 8 }]
  const predicted = [
    { file: 'src/a.js', line: 13, severity: 'important' },
    { file: 'src/a.js', line: 11, severity: 'important' },
    { file: 'src/b.js', line: 7, severity: 'important' },
    { file: 'src/c.js', line: 1, severity: 'important' },
    { file: 'src/c.js', line: 2, severity: 'nit' },
  ]
  const g = gradeCase({ kind: 'bug', bugs: expected }, predicted, { tolerance: 3 })
  assert.equal(g.tp, 2)
  assert.equal(g.fn, 0)
  // the second report of the same bug is a duplicate, not a false positive
  assert.equal(g.fp, 1)
  assert.equal(g.pass, false)
  const clean = gradeCase({ kind: 'clean', bugs: [] }, [{ file: 'x', line: 1, severity: 'nit' }], { tolerance: 3 })
  assert.equal(clean.fp, 0)
  assert.equal(clean.pass, true)
})

test('splitCases is deterministic, stratified and keeps both sides non-empty', () => {
  const cases = [...Array(10)].map((_, i) => ({ id: `c${i}`, kind: i < 7 ? 'bug' : 'clean' }))
  const s1 = splitCases(cases, { seed: 7, testFraction: 0.3 })
  const s2 = splitCases(cases, { seed: 7, testFraction: 0.3 })
  assert.deepEqual(s1, s2)
  assert.ok(s1.test.length >= 2 && s1.train.length >= 5)
  const kinds = new Set(s1.test.map(id => cases.find(c => c.id === id)?.kind))
  assert.deepEqual([...kinds].sort(), ['bug', 'clean'])
})

test('summarize + decideHillclimb follow the keep/revert rules', () => {
  const mk = (/** @type {number[]} */ passes) => passes.map((p, i) => ({ caseId: `c${i}`, repeat: 0, pass: p === 1, tp: p, fp: 0, fn: 1 - p, infraError: null }))
  const base = { train: summarize(mk([1, 0, 0, 0, 1, 0, 0, 0]), { seed: 1 }), test: summarize(mk([1, 0, 0, 0]), { seed: 1 }) }
  const better = { train: summarize(mk([1, 1, 1, 1, 1, 1, 0, 0]), { seed: 1 }), test: summarize(mk([1, 1, 1, 0]), { seed: 1 }) }
  const overfit = { train: summarize(mk([1, 1, 1, 1, 1, 1, 0, 0]), { seed: 1 }), test: summarize(mk([1, 0, 0, 0]), { seed: 1 }) }
  const worse = { train: summarize(mk([1, 1, 1, 1, 1, 1, 0, 0]), { seed: 1 }), test: summarize(mk([0, 0, 0, 0]), { seed: 1 }) }
  assert.equal(decideHillclimb(base, better, { minDelta: 0.1 }).decision, 'keep')
  assert.equal(decideHillclimb(base, overfit, { minDelta: 0.1 }).decision, 'revert-overfit')
  assert.equal(decideHillclimb(base, worse, { minDelta: 0.1 }).decision, 'revert-regression')
  assert.equal(decideHillclimb(base, base, { minDelta: 0.1 }).decision, 'no-change')
})

test('summarize separates infra errors from model failures', () => {
  const s = summarize(
    [
      { caseId: 'a', repeat: 0, pass: true, tp: 1, fp: 0, fn: 0, infraError: null },
      { caseId: 'b', repeat: 0, pass: false, tp: 0, fp: 0, fn: 0, infraError: 'timeout' },
    ],
    { seed: 1 },
  )
  assert.equal(s.trials, 1)
  assert.equal(s.infraErrors, 1)
  assert.equal(s.passRate.mean, 1)
})

test('leakCheck finds eval answers pasted into the tuned surface', () => {
  const cases = [{ id: 'c1', expected: { bugs: [{ file: 'src/payments/refund.ts', line: 3, description: 'refund cap ignores the currency conversion step entirely' }] } }]
  const leaks = leakCheck('Always check that the refund cap ignores the currency conversion step.\nLook at src/payments/refund.ts', cases)
  assert.equal(leaks.length, 2)
  assert.deepEqual(leakCheck('Check that money math handles currency.', cases), [])
})
