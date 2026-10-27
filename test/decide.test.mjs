import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideRound, scoreOf } from '../plugins/quality-loop/scripts/lib/decide.mjs'

/** @param {Partial<import('../plugins/quality-loop/scripts/lib/decide.mjs').DecideInput>} o */
const input = o => ({
  mode: /** @type {'review'} */ ('review'),
  round: 1,
  limits: { maxRounds: 3, stallRounds: 2 },
  regressions: { newlyFailingRequired: [], testCountDrops: [], blockingWeakening: [] },
  allowWeakening: false,
  requiredFailingNow: [],
  baselineRequiredFailing: [],
  reproOk: null,
  open: { important: 0, nit: 0, pending: 0, stuck: 0 },
  maxReopens: 0,
  history: [],
  startScore: 10,
  ...o,
})

test('scoreOf weighs failing checks over important findings over nits', () => {
  assert.equal(scoreOf({ failingRequired: 1, important: 2, nit: 3, pending: 1 }), 100 + 20 + 3 + 5)
})

test('clean round with nothing open is done', () => {
  const d = decideRound(input({ startScore: 0 }))
  assert.equal(d.revert, false)
  assert.equal(d.status, 'done')
})

test('a newly failing required check reverts the round and continues', () => {
  const d = decideRound(input({ regressions: { newlyFailingRequired: ['test'], testCountDrops: [], blockingWeakening: [] } }))
  assert.equal(d.revert, true)
  assert.equal(d.status, 'continue')
  assert.match(d.reasons.join(' '), /test/)
})

test('weakened tests revert unless explicitly allowed', () => {
  const w = { newlyFailingRequired: [], testCountDrops: [], blockingWeakening: ['skip-added:a.test.js:3'] }
  assert.equal(decideRound(input({ regressions: w })).revert, true)
  assert.equal(decideRound(input({ regressions: w, allowWeakening: true })).revert, false)
})

test('a dropped test count reverts', () => {
  const r = { newlyFailingRequired: [], testCountDrops: [{ name: 'test', before: 10, after: 8 }], blockingWeakening: [] }
  assert.equal(decideRound(input({ regressions: r })).revert, true)
})

test('pre-existing failing checks do not block done in review mode', () => {
  const d = decideRound(input({ requiredFailingNow: ['e2e'], baselineRequiredFailing: ['e2e'], startScore: 0 }))
  assert.equal(d.status, 'done')
  const d2 = decideRound(input({ requiredFailingNow: ['e2e', 'unit'], baselineRequiredFailing: ['e2e'] }))
  assert.equal(d2.status, 'continue')
})

test('debug mode is done only when the repro passes', () => {
  assert.equal(decideRound(input({ mode: 'debug', reproOk: false })).status, 'continue')
  assert.equal(decideRound(input({ mode: 'debug', reproOk: true })).status, 'done')
})

test('open important findings keep the loop going until the round cap', () => {
  const open = { important: 1, nit: 0, pending: 0, stuck: 0 }
  assert.equal(decideRound(input({ open, round: 2 })).status, 'continue')
  const capped = decideRound(input({ open, round: 3 }))
  assert.equal(capped.status, 'capped')
  assert.match(capped.reasons.join(' '), /reconsider/)
})

test('stuck findings stop the loop for a human', () => {
  const d = decideRound(input({ open: { important: 0, nit: 0, pending: 0, stuck: 1 } }))
  assert.equal(d.status, 'stalled')
})

test('a finding that keeps coming back is oscillation', () => {
  const d = decideRound(input({ open: { important: 1, nit: 0, pending: 0, stuck: 0 }, maxReopens: 2 }))
  assert.equal(d.status, 'stalled')
  assert.match(d.reasons.join(' '), /oscillat/)
})

test('rounds without progress stall before the cap', () => {
  const open = { important: 1, nit: 0, pending: 0, stuck: 0 }
  const limits = { maxRounds: 10, stallRounds: 2 }
  const history = [{ startScore: 30, endScore: 10, reverted: false, found: 3 }, { startScore: 20, endScore: 20, reverted: true, found: 1 }]
  // this round: reverted again -> 2 rounds without progress
  const d = decideRound(
    input({ round: 3, limits, open, history, startScore: 20, regressions: { newlyFailingRequired: ['t'], testCountDrops: [], blockingWeakening: [] } }),
  )
  assert.equal(d.status, 'stalled')
})

test('diverging: every round confirms at least as many new issues as the last', () => {
  const open = { important: 2, nit: 0, pending: 0, stuck: 0 }
  const limits = { maxRounds: 10, stallRounds: 2 }
  const history = [{ startScore: 20, endScore: 0, reverted: false, found: 2 }, { startScore: 20, endScore: 0, reverted: false, found: 2 }]
  const d = decideRound(input({ round: 3, limits, open, history, startScore: 30, found: 3 }))
  assert.equal(d.status, 'stalled')
  assert.match(d.reasons.join(' '), /diverg/)
})
