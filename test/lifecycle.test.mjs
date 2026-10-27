// Loop lifecycle: when a round may end, how lens coverage is counted, how
// findings age into "stuck", and how pause, revert and extend leave the loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { makeRepo, writeFiles } from './helpers.mjs'

const QL = resolve(import.meta.dirname, '../plugins/quality-loop/scripts/ql.mjs')

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 */
function ql(cwd, args, input) {
  const r = spawnSync(process.execPath, [QL, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function qlOk(cwd, args, input) {
  const r = ql(cwd, args, input)
  assert.equal(r.code, 0, `ql ${args.join(' ')} failed:\n${r.err}\n${r.out}`)
  return r.out
}

/** @param {string} cwd */
const state = cwd => JSON.parse(readFileSync(join(cwd, '.quality-loop/state.json'), 'utf8'))
/** @param {string} cwd @param {any} s */
const writeState = (cwd, s) => writeFileSync(join(cwd, '.quality-loop/state.json'), JSON.stringify(s, null, 2))

const CART = `export function total(items) {
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price
  }
  return sum
}
`
const CART_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/cart.js'

test('sums prices', () => {
  assert.equal(total([{ price: 2 }, { price: 3 }]), 5)
})
`
const BUGGY = CART.replace('i < items.length', 'i <= items.length').replace('sum += items[i].price', 'sum += items[i]?.price ?? 0')

/** A node project whose uncommitted change introduces an off-by-one. */
function buggyProject() {
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'src/cart.js': CART,
    'test/cart.test.js': CART_TEST,
  })
  writeFiles(root, { 'src/cart.js': BUGGY })
  return root
}

/** @param {string} root @param {Record<string, unknown>} loopCfg */
function configure(root, loopCfg) {
  qlOk(root, ['init'])
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: loopCfg }))
}

const FINDING = {
  title: 'Loop bound reads past the end of items',
  file: 'src/cart.js',
  line: 3,
  quote: 'for (let i = 0; i <= items.length; i++) {',
  category: 'correctness',
  severity: 'important',
  bugClass: 'off-by-one',
  explanation: 'The <= bound iterates once past the last item; the ?. hides it.',
  failureScenario: 'total(items) silently adds 0 for items[length], masking corrupt input',
}

const NIT = {
  title: 'Optional chaining hides a missing price',
  file: 'src/cart.js',
  line: 4,
  quote: 'sum += items[i]?.price ?? 0',
  category: 'maintainability',
  severity: 'nit',
  bugClass: 'silent-default',
  explanation: 'A missing price reads as 0 instead of failing loudly.',
  failureScenario: 'an item without a price is summed as free',
}

const STANDARD = ['correctness', 'security', 'regressions-and-edge-cases', 'conventions']

/** @param {string} root @param {object[]} findings @param {string} lens */
function ingest(root, findings, lens) {
  return qlOk(root, ['ingest', '-', '--lens', lens], JSON.stringify(findings))
}

/** Records every configured lens not yet ingested this round as finding nothing. @param {string} root */
function finishReview(root) {
  const s = state(root)
  for (const lens of s.config.review.lenses) {
    if (!s.rounds.at(-1).lensesDone?.includes(lens)) qlOk(root, ['ingest', '--none', '--lens', lens])
  }
}

/** @param {string} root @param {string} id @param {'confirm' | 'reject'} [verdict] */
function voteAll(root, id, verdict = 'confirm') {
  const s = state(root)
  const f = s.ledger.findings[id]
  const votes = Array.from({ length: s.config.review.verifiers }, (_, i) => ({ id, verdict, voter: `v${i}-${id}`, reason: 'traced it', severity: f.severity }))
  return qlOk(root, ['vote', '-'], JSON.stringify(votes))
}

test('round end is refused until every configured lens has reported (review mode)', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  const none = ql(root, ['round', 'end'])
  assert.equal(none.code, 1, 'no review at all')
  assert.match(none.err, /cannot end the round in phase "review"/)
  ingest(root, [FINDING], 'correctness')
  assert.equal(ql(root, ['round', 'end']).code, 1, 'one of four lenses')
  qlOk(root, ['ingest', '--none', '--lens', 'security'])
  qlOk(root, ['ingest', '--none', '--lens', 'regressions-and-edge-cases'])
  // the candidate is still unverified: the round cannot end yet either
  qlOk(root, ['ingest', '--none', '--lens', 'conventions'])
  assert.equal(ql(root, ['round', 'end']).code, 1, 'candidates awaiting verification')
  voteAll(root, 'F1')
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)
})

test('round end is refused in the debug investigate phase', () => {
  const root = buggyProject()
  const repro = `node -e "if (/<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'src/cart.js': CART })
  const r = ql(root, ['round', 'end'])
  assert.equal(r.code, 1)
  assert.match(r.err, /cannot end the round in phase "investigate"/)
  assert.match(qlOk(root, ['next']), /--none --lens <lens>/, 'investigate tells the agent to name the lens')
})

test('a review-only loop cannot `round end`: nothing is reverted or deleted', () => {
  const root = buggyProject()
  configure(root, {})
  qlOk(root, ['start', '--mode', 'review', '--review-only'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'notes.txt': 'mine\n' })
  const r = ql(root, ['round', 'end'])
  assert.equal(r.code, 1)
  assert.match(r.err, /review-only/)
  assert.equal(existsSync(join(root, 'notes.txt')), true)
  // even with the review complete it ends with `ql finish`, not `round end`
  finishReview(root)
  assert.equal(ql(root, ['round', 'end']).code, 1)
  assert.equal(readFileSync(join(root, 'src/cart.js'), 'utf8'), BUGGY)
})

test('ingest --none must name a configured lens; a bare or mistyped --none does not close the review', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  for (const lens of ['correctness', 'security', 'regressions-and-edge-cases']) qlOk(root, ['ingest', '--none', '--lens', lens])
  const bare = ql(root, ['ingest', '--none'])
  assert.equal(bare.code, 1)
  assert.match(bare.err, /--lens/)
  const typo = ql(root, ['ingest', '--none', '--lens', 'conventons'])
  assert.equal(typo.code, 1)
  assert.match(typo.err, /conventions/, 'names the configured lenses')
  // a finding file under an unconfigured lens is kept, but does not stand in for a configured one
  ingest(root, [FINDING], 'general')
  assert.deepEqual(
    state(root).rounds.at(-1).lensesDone.filter((/** @type {string} */ l) => STANDARD.includes(l)).length,
    3,
  )
  assert.match(qlOk(root, ['next']), /still to come: conventions/)
  assert.equal(state(root).rounds.at(-1).lensesDone.length, 4)
  assert.match(qlOk(root, ['status']), /phase review/)
})

test('`ingest --none --lens scope` closes the review only when the scope is empty', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  const r = ql(root, ['ingest', '--none', '--lens', 'scope'])
  assert.equal(r.code, 1)
  assert.match(r.err, /scope is not empty/)
  assert.match(qlOk(root, ['next']), /0 of 4|bug-hunter/)

  const clean = makeRepo({ 'a.txt': 'x\n' })
  qlOk(clean, ['start', '--mode', 'review'])
  qlOk(clean, ['round', 'begin'])
  qlOk(clean, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(clean, ['next']), /^Validate/)
})

test('an unfixed confirmed nit never makes the loop STALLED', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review', '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING, NIT], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  voteAll(root, 'F2')
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)

  qlOk(root, ['round', 'begin'])
  finishReview(root)
  writeFiles(root, { 'src/cart.js': BUGGY.replace('i <= items.length', 'i < items.length') })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bound is < again'])
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /decision: DONE/)
  const s = state(root)
  assert.equal(s.ledger.findings.F2.status, 'confirmed', 'the nit stays open, not stuck')
})

test('a reverted debug round drops the findings made on its own reverted fix', () => {
  const root = buggyProject()
  const repro = `node -e "if (/<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro])
  qlOk(root, ['round', 'begin'])
  // the root-cause fix, with a leftover comment the review flags
  writeFiles(root, { 'src/cart.js': BUGGY.replace('i <= items.length; i++) {', 'i < items.length; i++) { // tmp') })
  ingest(
    root,
    [{ ...FINDING, title: 'Leftover comment', quote: 'for (let i = 0; i < items.length; i++) { // tmp', bugClass: 'leftover', category: 'conventions' }],
    'conventions',
  )
  finishReview(root)
  voteAll(root, 'F1')
  // the fixer then breaks a required check, so the whole round reverts
  writeFiles(root, { 'test/broken.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('x', () => assert.equal(1, 2))\n` })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.match(end, /decision: CONTINUE/)
  assert.equal(readFileSync(join(root, 'src/cart.js'), 'utf8'), BUGGY)
  const s = state(root)
  assert.equal(s.ledger.findings.F1, undefined, 'its code no longer exists')
  assert.equal(s.rounds[0].discarded[0].id, 'F1')

  // a clean fix in round 2 finishes the loop
  qlOk(root, ['round', 'begin'])
  assert.match(qlOk(root, ['open']), /nothing open/)
  writeFiles(root, { 'src/cart.js': CART })
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})

test('a debug loop paused because the repro passes cannot be resumed', () => {
  const root = buggyProject()
  const r = ql(root, ['start', '--mode', 'debug', '--repro', 'true'])
  assert.match(r.out, /does not reproduce/)
  const next = qlOk(root, ['next'])
  assert.doesNotMatch(next, /ql resume/)
  assert.match(next, /ql start/)
  const resumed = ql(root, ['resume'])
  assert.equal(resumed.code, 1)
  assert.match(resumed.err, /repro/)
  assert.equal(state(root).status, 'paused')
  // an ordinary pause still resumes
  qlOk(root, ['start', '--mode', 'review', '--force'])
  qlOk(root, ['pause', '--reason', 'need a decision'])
  assert.match(qlOk(root, ['next']), /ql resume/)
  qlOk(root, ['resume'])
})

test('ql extend resets oscillation and stall history so the granted rounds are real', () => {
  const root = buggyProject()
  configure(root, { maxRounds: 3, maxAttemptsPerFinding: 9, stallRounds: 2 })
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  // F1 came back twice already: the fixes are fighting each other
  const s = state(root)
  s.ledger.findings.F1.reopens = 2
  writeState(root, s)
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /decision: STALLED/)
  assert.match(end, /oscillation/)

  qlOk(root, ['extend', '--rounds', '3'])
  qlOk(root, ['round', 'begin'])
  finishReview(root)
  // no progress this round, but it is the first round since the extension
  const after = qlOk(root, ['round', 'end'])
  assert.match(after, /decision: CONTINUE/)
})

test('oscillation counts only findings still in play, not ones since rejected', () => {
  const root = buggyProject()
  configure(root, { maxRounds: 3, maxAttemptsPerFinding: 9 })
  qlOk(root, ['start', '--mode', 'review'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING, NIT], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  voteAll(root, 'F2', 'reject')
  const s = state(root)
  s.ledger.findings.F2.reopens = 2
  writeState(root, s)
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)
})

test('an empty scope recorded before the debug fix does not let the fix skip review', () => {
  // the bug is committed, so round 1 starts with nothing changed vs the base
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'src/cart.js': BUGGY,
    'test/cart.test.js': CART_TEST,
  })
  const repro = `node -e "if (/<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro, '--depth', 'quick'])
  const begin = qlOk(root, ['round', 'begin'])
  assert.doesNotMatch(begin, /record with `ql ingest --none --lens scope`/, 'debug round begin does not invite closing the review before the fix')
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  // then the fix, and an unrelated edit riding along
  writeFiles(root, { 'src/cart.js': CART + 'export const secret = "hunter2"\n' })
  const end = ql(root, ['round', 'end'])
  assert.equal(end.code, 1, 'round end refuses the unreviewed change')
  assert.match(end.err, /scope was recorded empty/)
  assert.equal(state(root).rounds[0].ended, false)
  assert.equal(state(root).rounds[0].lensesDone.includes('scope'), false, 'the stale empty-scope record is dropped')
  assert.doesNotMatch(qlOk(root, ['next']), /^Validate/, 'next does not say validate an unreviewed change')
  assert.equal(ql(root, ['round', 'end']).code, 1)
  // reviewing every lens lets it end
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})

test('`ql next` notices an empty-scope record gone stale before round end does', () => {
  const clean = makeRepo({ 'a.txt': 'x\n' })
  qlOk(clean, ['start', '--mode', 'review'])
  qlOk(clean, ['round', 'begin'])
  qlOk(clean, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(clean, ['next']), /^Validate/)
  writeFiles(clean, { 'a.txt': 'y\n' })
  // A same-size edit within the second of the commit is git's racy case
  // (git.test.mjs covers it); a distinct mtime keeps this test about `next`.
  const past = new Date('2001-01-01T00:00:00Z')
  utimesSync(join(clean, 'a.txt'), past, past)
  assert.match(qlOk(clean, ['next']), /^Review/)
  assert.match(qlOk(clean, ['status']), /phase review/)
})

test('a reverted round keeps a confirmed finding whose code survives the revert, even if the fix moved it far', () => {
  const root = buggyProject()
  const repro = `node -e "if (/<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  // the fix prepends 30 lines of docs, so the surviving buggy line moves from 4 to 34
  const pad = Array.from({ length: 30 }, (_, i) => `// doc ${i}`).join('\n') + '\n'
  writeFiles(root, { 'src/cart.js': pad + BUGGY.replace('i <= items.length', 'i < items.length') })
  ingest(root, [{ ...NIT, line: 34, severity: 'important', title: 'A missing price is summed as 0' }], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  assert.equal(state(root).ledger.findings.F1.line, 34)
  writeFiles(root, { 'test/broken.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('x', () => assert.equal(1, 2))\n` })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(end, /discarded F1/)
  assert.equal(readFileSync(join(root, 'src/cart.js'), 'utf8'), BUGGY)
  const f = state(root).ledger.findings.F1
  assert.ok(f, 'the bug is still in the tree, so the finding stays')
  assert.equal(f.line, 4, 'relocated to where the code is after the revert')
  assert.match(qlOk(root, ['open']), /F1/)
})

const BROKEN_TEST = `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('x', () => assert.equal(1, 2))\n`
const ADD_REPRO = `node -e "import('./a.js').then(m => process.exit(m.add(1, 1) === 2 ? 0 : 1))"`
const MUL = 'export function mul(a, b) {\n  if (!a) return 0\n  return a * b\n}\n'

/** A debug project whose committed add() subtracts; mul() already holds `if (!a) return 0`. */
function addProject() {
  return makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'test/ok.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n`,
    'a.js': 'export function add(a, b) {\n  return a - b\n}\n' + MUL,
  })
}

test('a reverted round drops a finding on its own added code even when the same text survives elsewhere', () => {
  const root = addProject()
  qlOk(root, ['start', '--mode', 'debug', '--repro', ADD_REPRO, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  // the fix adds a guard to add() that mul() already has, word for word
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  if (!a) return 0\n  return a + b\n}\n' + MUL })
  ingest(
    root,
    [{ ...FINDING, title: 'add(0, 5) returns 0 instead of 5', file: 'a.js', line: 2, quote: 'if (!a) return 0', bugClass: 'zero-guard' }],
    'correctness',
  )
  finishReview(root)
  voteAll(root, 'F1')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.equal(state(root).ledger.findings.F1, undefined, 'the guard it describes was the reverted fix, not mul()')
  assert.equal(state(root).rounds[0].discarded[0]?.id, 'F1')

  // a clean fix in round 2 finishes the loop
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  return a + b\n}\n' + MUL })
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})

test('a finding on reverted code the fixer then removed is not moved onto an unrelated copy of its text', () => {
  const root = addProject()
  qlOk(root, ['start', '--mode', 'debug', '--repro', ADD_REPRO, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  if (!a) return 0\n  return a + b\n}\n' + MUL })
  ingest(
    root,
    [{ ...FINDING, title: 'add(0, 5) returns 0 instead of 5', file: 'a.js', line: 2, quote: 'if (!a) return 0', bugClass: 'zero-guard' }],
    'correctness',
  )
  finishReview(root)
  voteAll(root, 'F1')
  // the fixer drops the guard (only mul's copy is left), then breaks a test
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  return a + b\n}\n' + MUL, 'test/broken.test.js': BROKEN_TEST })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'guard removed'])
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  assert.equal(state(root).ledger.findings.F1, undefined, 'mul() is not the code it described')
})

test('a finding kept across a revert has its origin recomputed against the restored tree', () => {
  // the bug is committed: only the round's own fix makes the change
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'src/cart.js': BUGGY,
    'test/cart.test.js': CART_TEST,
  })
  const repro = `node -e "if (/<=/.test(require('fs').readFileSync('src/cart.js','utf8'))) process.exit(1)"`
  qlOk(root, ['start', '--mode', 'debug', '--repro', repro, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'src/cart.js': BUGGY.replace('i <= items.length', 'i < items.length') })
  // committed code next to the fixed line: introduced while the fix stands
  ingest(root, [{ ...NIT, severity: 'important', title: 'A missing price is summed as 0' }], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  assert.equal(state(root).ledger.findings.F1.origin, 'introduced')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  const f = state(root).ledger.findings.F1
  assert.ok(f, 'its code is committed and survives the revert')
  assert.equal(f.line, 4)
  assert.equal(f.origin, 'pre-existing', 'with the fix reverted the change no longer touches it')
  assert.match(qlOk(root, ['open']), /nothing open/)
})

test('a reverted round brings back a finding the round fixed on code that predates the round', () => {
  const root = buggyProject()
  qlOk(root, ['start', '--mode', 'review', '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  // the fixer fixes it and adds a doc block above, but breaks a test
  const pad = Array.from({ length: 30 }, (_, i) => `// doc ${i}`).join('\n') + '\n'
  writeFiles(root, { 'src/cart.js': pad + BUGGY.replace('i <= items.length', 'i < items.length'), 'test/broken.test.js': BROKEN_TEST })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bound is < again'])
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  const f = state(root).ledger.findings.F1
  assert.ok(f, 'the bug is back with the revert')
  assert.equal(f.status, 'confirmed')
  assert.equal(f.line, 3)
  assert.equal(f.origin, 'introduced')
})

test("an empty scope recorded while findings are open stays valid for that round's fix step", () => {
  const root = buggyProject()
  configure(root, { maxAttemptsPerFinding: 3, maxRounds: 5 })
  qlOk(root, ['start', '--mode', 'review', '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  ingest(root, [FINDING], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  // the fixer could not fix it this round
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)

  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(root, ['next']), /^Fix/)
  writeFiles(root, { 'src/cart.js': BUGGY.replace('i <= items.length', 'i < items.length') })
  assert.match(qlOk(root, ['next']), /^Fix/, 'the fix it asked for does not reopen the review')
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bound is < again'])
  assert.match(qlOk(root, ['next']), /^Validate/)
  const end = ql(root, ['round', 'end'])
  assert.equal(end.code, 0, end.err)
  assert.match(end.out, /decision: DONE/)
})

/**
 * Review mode, round 1: `findings` ingested and confirmed on the
 * uncommitted change, before any fix.
 *
 * @param {object[]} findings
 */
function reviewedProject(findings) {
  const root = buggyProject()
  configure(root, { maxAttemptsPerFinding: 3, maxRounds: 5 })
  qlOk(root, ['start', '--mode', 'review', '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  ingest(root, findings, 'correctness')
  finishReview(root)
  for (const id of Object.keys(state(root).ledger.findings)) voteAll(root, id)
  return root
}

const PAD = Array.from({ length: 30 }, (_, i) => `// doc ${i}`).join('\n') + '\n'

test('a reverted review round keeps a finding left unfixed when the fixer moved its code far away', () => {
  const root = reviewedProject([FINDING])
  // the fixer leaves F1 alone, prepends a doc block and breaks a test
  writeFiles(root, { 'src/cart.js': PAD + BUGGY, 'test/broken.test.js': BROKEN_TEST })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(end, /discarded/)
  assert.equal(readFileSync(join(root, 'src/cart.js'), 'utf8'), BUGGY)
  const f = state(root).ledger.findings.F1
  assert.ok(f, 'the bug predates the round and is still in the restored code')
  assert.equal(f.status, 'confirmed')
  assert.equal(f.line, 3)
  assert.equal(f.origin, 'introduced')
  assert.equal(f.attempts, 1)
})

test('a reverted review round keeps a finding whose line the fixer re-indented without fixing it', () => {
  const root = reviewedProject([FINDING])
  const wrapped = `export function total(items) {
  let sum = 0
  if (items) {
    for (let i = 0; i <= items.length; i++) {
      sum += items[i]?.price ?? 0
    }
  }
  return sum
}
`
  writeFiles(root, { 'src/cart.js': wrapped, 'test/broken.test.js': BROKEN_TEST })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(end, /discarded/)
  const f = state(root).ledger.findings.F1
  assert.ok(f, 'the bug predates the round and is still in the restored code')
  assert.equal(f.status, 'confirmed')
  assert.equal(f.line, 3)
})

test('a reverted review round keeps an untouched finding next to one it fixed', () => {
  const root = reviewedProject([FINDING, { ...NIT, severity: 'important', title: 'A missing price is summed as 0' }])
  writeFiles(root, { 'src/cart.js': PAD + BUGGY.replace('i <= items.length', 'i < items.length'), 'test/broken.test.js': BROKEN_TEST })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bound is < again'])
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(end, /discarded/)
  assert.match(end, /2 important finding\(s\) open/)
  const s = state(root)
  assert.equal(s.ledger.findings.F1.status, 'confirmed')
  assert.equal(s.ledger.findings.F1.line, 3)
  assert.equal(s.ledger.findings.F2?.status, 'confirmed')
  assert.equal(s.ledger.findings.F2?.line, 4)
})

test('an empty scope recorded before a debug fix, with a finding open, does not let the fix skip review', () => {
  const BUG = 'export function add(a, b) {\n  return a - b\n}\nexport function mul(a, b) {\n  return a * b + 0\n}\n'
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'test/ok.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n`,
    'a.js': BUG,
  })
  qlOk(root, ['init'])
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: { maxAttemptsPerFinding: 5, maxRounds: 5 }, review: { ...cfg.review, fixPreExisting: true } }))
  qlOk(root, ['start', '--mode', 'debug', '--repro', ADD_REPRO, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b') })
  ingest(root, [{ ...FINDING, title: 'mul adds 0', file: 'a.js', line: 5, quote: 'return a * b + 0', bugClass: 'mul' }], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  assert.equal(state(root).ledger.findings.F1.status, 'confirmed', 'a pre-existing finding, in scope')

  // round 2: the repro still fails, so the debug fix is still to come
  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b').replace('a * b + 0', 'a * b') + 'export const token = "hunter2"\n' })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'dropped + 0'])
  assert.doesNotMatch(qlOk(root, ['next']), /^Validate/)
  const end = ql(root, ['round', 'end'])
  assert.equal(end.code, 1, 'round end refuses the unreviewed debug fix')
  assert.match(end.err, /phase "review"/, "`ql next` already dropped the stale record")
})

test('an empty scope kept for the fix step goes stale again once nothing is left to fix', () => {
  const root = reviewedProject([FINDING])
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)
  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(root, ['next']), /^Fix/)
  qlOk(root, ['mark', 'F1', 'wontfix', '--reason', 'intended per the user'])
  assert.match(qlOk(root, ['next']), /^Validate/)
  writeFiles(root, { 'b.js': 'export const token = "hunter2"\n' })
  assert.match(qlOk(root, ['next']), /^Review/, 'an edit after the fix step is unreviewed')
  const end = ql(root, ['round', 'end'])
  assert.equal(end.code, 1)
  assert.match(end.err, /phase "review"/, "`ql next` already dropped the stale record")
})

// --- round 3: the verifier's findings on round 2

/** A debug project with `a.js` and a passing suite. @param {string} bug @param {Record<string, unknown>} [review] */
function debugProject(bug, review = {}) {
  const root = makeRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
    'test/ok.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n`,
    'a.js': bug,
  })
  qlOk(root, ['init'])
  const cfgPath = join(root, '.quality-loop/config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, loop: { maxAttemptsPerFinding: 5, maxRounds: 6 }, review: { ...cfg.review, ...review } }))
  return root
}

test('`ql next` after an empty scope recorded before a debug fix says the fix is reviewed before `round end` (verifier r2: debugFixToCome)', () => {
  const BUG = 'export function add(a, b) {\n  return a - b\n}\nexport function mul(a, b) {\n  return a * b + 0\n}\n'
  const root = debugProject(BUG, { fixPreExisting: true })
  qlOk(root, ['start', '--mode', 'debug', '--repro', ADD_REPRO, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b') })
  ingest(root, [{ ...FINDING, title: 'mul adds 0', file: 'a.js', line: 5, quote: 'return a * b + 0', bugClass: 'mul' }], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)

  qlOk(root, ['round', 'begin'])
  const recorded = qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  const next = qlOk(root, ['next'])
  for (const text of [recorded, next]) {
    assert.doesNotMatch(text, /Then `ql round end`\./, 'it does not ask for a fix that `round end` will refuse')
    assert.match(text, /`ql brief hunters`/, 'it names the review the edit will need')
  }
  // following it: the fix, then the review it named, then round end
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b').replace('a * b + 0', 'a * b') })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'dropped + 0'])
  assert.match(qlOk(root, ['next']), /^Review/)
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})

test('a fixed finding reopened on code the reverted round added goes back to fixed (verifier r2: reopened on own code)', () => {
  const REPRO2 = `node -e "import('./a.js').then(m=>process.exit(m.add(1,1)===2&&m.mul(2,3)===6?0:1))"`
  const BUG = 'export function add(a, b) {\n  return a - b\n}\nexport function mul(a, b) {\n  return a + b\n}\n'
  const root = debugProject(BUG)
  const LEFT = { ...FINDING, title: 'leftover tmp comment', file: 'a.js', line: 2, quote: 'return a + b // tmp', bugClass: 'leftover', category: 'conventions' }
  qlOk(root, ['start', '--mode', 'debug', '--repro', REPRO2, '--depth', 'quick'])
  // round 1, kept: the add fix with a leftover comment, flagged, then cleaned up
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b // tmp') })
  ingest(root, [LEFT], 'conventions')
  finishReview(root)
  voteAll(root, 'F1')
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b') })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'comment removed'])
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)
  const before = state(root).ledger.findings.F1
  assert.equal(before.status, 'fixed')

  // round 2: the next attempt re-adds the comment, the review reopens F1, then a test breaks
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  return a + b // tmp\n}\nexport function mul(a, b) {\n  return a * b\n}\n' })
  ingest(root, [LEFT], 'conventions')
  finishReview(root)
  voteAll(root, 'F1')
  assert.equal(state(root).ledger.findings.F1.status, 'confirmed')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  const end = qlOk(root, ['round', 'end'])
  assert.match(end, /REVERTED/)
  assert.doesNotMatch(end, /important finding\(s\) open/)
  const after = state(root).ledger.findings.F1
  assert.equal(after.status, 'fixed', 'its reopening was on code the revert removed')
  assert.equal(after.line, before.line)
  assert.equal(after.reopens, before.reopens)

  // round 3: a clean fix finishes the loop
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': 'export function add(a, b) {\n  return a + b\n}\nexport function mul(a, b) {\n  return a * b\n}\n' })
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})

test('an open nit does not keep the fix-step exemption once no important finding is open (verifier r2: nit keeps exemption)', () => {
  const root = reviewedProject([FINDING, NIT])
  assert.match(qlOk(root, ['round', 'end']), /decision: CONTINUE/)
  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  assert.match(qlOk(root, ['next']), /^Fix/)
  writeFiles(root, { 'src/cart.js': BUGGY.replace('i <= items.length', 'i < items.length') })
  qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'bound is < again'])
  // the nit is still open, so `ql next` still asks for fixes, and says an edit from now on is reviewed
  const next = qlOk(root, ['next'])
  assert.match(next, /^Fix/)
  assert.match(next, /`ql brief hunters`/)
  writeFiles(root, { 'b.js': 'export const token = "hunter2"\n' })
  assert.match(qlOk(root, ['next']), /^Review/, 'an edit after the last important fix is unreviewed')
  const end = ql(root, ['round', 'end'])
  assert.equal(end.code, 1)
  assert.match(end.err, /phase "review"/)
})

// --- round 4: the verifier's findings on round 3

test('`ql mark` of the last open finding does not say `round end` when the fix step changed a tree the empty-scope record no longer covers (verifier r3: stale next after mark)', () => {
  const BUG = 'export function add(a, b) {\n  return a - b\n}\nexport function mul(a, b) {\n  return a * b + 0\n}\n'
  const root = debugProject(BUG, { fixPreExisting: true })
  qlOk(root, ['start', '--mode', 'debug', '--repro', ADD_REPRO, '--depth', 'quick'])
  qlOk(root, ['round', 'begin'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b') })
  ingest(root, [{ ...FINDING, title: 'mul adds 0', file: 'a.js', line: 5, quote: 'return a * b + 0', bugClass: 'mul' }], 'correctness')
  finishReview(root)
  voteAll(root, 'F1')
  writeFiles(root, { 'test/broken.test.js': BROKEN_TEST })
  assert.match(qlOk(root, ['round', 'end']), /REVERTED/)
  qlOk(root, ['round', 'begin'])
  qlOk(root, ['ingest', '--none', '--lens', 'scope'])
  writeFiles(root, { 'a.js': BUG.replace('a - b', 'a + b').replace('a * b + 0', 'a * b') })
  const marked = qlOk(root, ['mark', 'F1', 'fixed', '--reason', 'dropped + 0'])
  assert.doesNotMatch(marked, /next: Validate/)
  assert.match(marked, /next: Review/)
  finishReview(root)
  assert.match(qlOk(root, ['round', 'end']), /decision: DONE/)
})
