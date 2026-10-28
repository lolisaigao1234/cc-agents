// full-send's merge gate: every verdict, and the order the rules apply in.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyChecks, decideGate, pickMergeMethod } from '../plugins/quality-loop/scripts/lib/gate.mjs'

const HEAD = 'a'.repeat(40)
const run = (/** @type {string} */ name, /** @type {string} */ status, conclusion = '') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  detailsUrl: `https://ci/${name}`,
})
const GREEN = [run('test', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'SKIPPED'), { __typename: 'StatusContext', context: 'pipeline', state: 'SUCCESS', targetUrl: 'https://p' }]

/** @param {Record<string, unknown>} pr @param {Record<string, unknown>} [o] */
const gate = (pr, o = {}) =>
  decideGate({
    pr: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD, statusCheckRollup: GREEN, ...pr },
    localHead: HEAD,
    ship: { failedHeads: [], headSeenAt: { [HEAD]: 0 }, merging: null },
    now: 1000,
    config: { requireChecks: true, checksGraceSec: 300, maxFixAttempts: 3 },
    ...o,
  })

test('gate: every check passed and GitHub says clean: MERGE', () => {
  const g = gate({})
  assert.equal(g.verdict, 'MERGE')
  assert.match(g.reasons[0] ?? '', /all 3 check\(s\) passed/)
})

test('gate: check runs and commit statuses are both read', () => {
  const c = classifyChecks([...GREEN, run('e2e', 'IN_PROGRESS'), run('deploy', 'COMPLETED', 'TIMED_OUT'), { context: 'legacy', state: 'ERROR' }])
  assert.deepEqual(
    c.map(x => [x.name, x.result]),
    [['CI / test', 'pass'], ['CI / lint', 'pass'], ['pipeline', 'pass'], ['CI / e2e', 'pending'], ['CI / deploy', 'fail'], ['legacy', 'fail']],
  )
})

test('gate: a failed check is FIX, counted per head; past maxFixAttempts heads it is BLOCKED', () => {
  const red = [...GREEN, run('test2', 'COMPLETED', 'FAILURE')]
  const g = gate({ statusCheckRollup: red })
  assert.equal(g.verdict, 'FIX')
  assert.deepEqual(g.failedHeads, [HEAD])
  const again = gate({ statusCheckRollup: red }, { ship: { failedHeads: [HEAD], headSeenAt: {}, merging: null } })
  assert.deepEqual(again.failedHeads, [HEAD], 'the same head counts once')
  const many = gate({ statusCheckRollup: red }, { ship: { failedHeads: ['b', 'c', 'd'], headSeenAt: {}, merging: null } })
  assert.equal(many.verdict, 'BLOCKED')
  assert.match(many.reasons[0] ?? '', /4 heads, past ship\.maxFixAttempts \(3\)/)
})

test('gate: a running check is WAIT, and a failure beats it', () => {
  assert.equal(gate({ statusCheckRollup: [...GREEN, run('e2e', 'QUEUED')] }).verdict, 'WAIT')
  assert.equal(gate({ statusCheckRollup: [run('e2e', 'QUEUED'), run('t', 'COMPLETED', 'FAILURE')] }).verdict, 'FIX')
})

test('gate: no checks wait out the grace period, then block unless requireChecks is off', () => {
  assert.equal(gate({ statusCheckRollup: [] }, { now: 299_000 }).verdict, 'WAIT')
  const late = gate({ statusCheckRollup: [] }, { now: 300_000 })
  assert.equal(late.verdict, 'BLOCKED')
  assert.match(late.reasons[0] ?? '', /no CI check reported/)
  const off = gate({ statusCheckRollup: [] }, { now: 300_000, config: { requireChecks: false, checksGraceSec: 300, maxFixAttempts: 3 } })
  assert.equal(off.verdict, 'MERGE')
})

test('gate: conflicts, a draft, a behind branch and a differing local head are FIX; conflicts come before CI', () => {
  assert.equal(gate({ mergeable: 'CONFLICTING', statusCheckRollup: [run('t', 'COMPLETED', 'FAILURE')] }).reasons[0]?.includes('conflicts'), true)
  assert.equal(gate({ isDraft: true }).verdict, 'FIX')
  assert.equal(gate({ mergeStateStatus: 'BEHIND' }).verdict, 'FIX')
  const g = gate({}, { localHead: 'b'.repeat(40) })
  assert.equal(g.verdict, 'FIX')
  assert.match(g.reasons[0] ?? '', /push the branch/)
})

test('gate: branch protection with green checks is BLOCKED, never bypassed; mergeability still computing is WAIT', () => {
  const g = gate({ mergeStateStatus: 'BLOCKED' })
  assert.equal(g.verdict, 'BLOCKED')
  assert.match(g.reasons[0] ?? '', /never bypasses it/)
  assert.equal(gate({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }).verdict, 'WAIT')
})

test('gate: merged, closed, and a merge already requested', () => {
  assert.equal(gate({ state: 'MERGED' }).verdict, 'MERGED')
  assert.equal(gate({ state: 'CLOSED' }).verdict, 'BLOCKED')
  assert.equal(gate({}, { ship: { failedHeads: [], headSeenAt: {}, merging: HEAD } }).verdict, 'WAIT')
})

test('merge method: the configured one if allowed; auto follows a merge-commit history, else squash, merge, rebase', () => {
  const all = { squash: true, merge: true, rebase: true }
  assert.equal(pickMergeMethod(all, 'auto', true), 'merge')
  assert.equal(pickMergeMethod(all, 'auto', false), 'squash')
  assert.equal(pickMergeMethod({ squash: false, merge: true, rebase: true }, 'auto', null), 'merge')
  assert.equal(pickMergeMethod({ squash: false, merge: false, rebase: true }, 'auto', true), 'rebase')
  assert.equal(pickMergeMethod({ squash: true, merge: false, rebase: false }, 'rebase', false), null)
})
