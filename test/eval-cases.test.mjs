import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectCases } from '../evals/review/lib/cases.mjs'

const all = [
  { id: 'a', kind: 'bug', mode: 'diff' },
  { id: 'b', kind: 'clean', mode: 'diff' },
  { id: 'gone', kind: 'bug', mode: 'diff', dropped: 'empty diff' },
  { id: 'sweep', kind: 'bug', mode: 'sweep' },
]
const ids = (/** @type {{cases: any[]}} */ r) => r.cases.map(c => c.id)

test('a dropped case never runs, and the skip is reported', () => {
  const r = selectCases(all, {})
  assert.deepEqual(ids(r), ['a', 'b'])
  assert.deepEqual(r.skipped, [{ id: 'gone', why: 'empty diff' }])
})

test('naming a dropped case skips it instead of refusing the list', () => {
  // The screen's per-variant lists were written before the drop; refusing them
  // would stop every variant that names the case.
  const r = selectCases(all, { ids: ['a', 'gone'] })
  assert.deepEqual(ids(r), ['a'])
  assert.deepEqual(r.skipped, [{ id: 'gone', why: 'empty diff' }])
})

test('an unknown case id is still refused, as is a sweep case outside the sweep arm', () => {
  assert.throws(() => selectCases(all, { ids: ['a', 'nope'] }), /unknown case ids: nope/)
  assert.throws(() => selectCases(all, { ids: ['sweep'] }), /unknown case ids: sweep/)
})

test('only the sweep arm runs a sweep case, and kinds still filter', () => {
  assert.deepEqual(ids(selectCases(all, { sweep: true })), ['a', 'b', 'sweep'])
  assert.deepEqual(ids(selectCases(all, { kinds: ['clean'] })), ['b'])
})

test('pr30 and conv-pr38-int are dropped in the data, with a reason', () => {
  // pr30's PR is empty once replayed; conv-pr38-int duplicates pr38-int (#39, Step 0.5).
  const cases = JSON.parse(readFileSync(new URL('../evals/review/data/cases.json', import.meta.url), 'utf8'))
  const dropped = cases.filter((/** @type {any} */ c) => c.dropped).map((/** @type {any} */ c) => c.id).sort()
  assert.deepEqual(dropped, ['conv-pr38-int', 'pr30'])
  assert.ok(cases.every((/** @type {any} */ c) => !c.dropped || typeof c.dropped === 'string'))
})
