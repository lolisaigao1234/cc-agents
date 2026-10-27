// Loop lifecycle: when a round may end, how lens coverage is counted, how
// findings age into "stuck", and how pause, revert and extend leave the loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
