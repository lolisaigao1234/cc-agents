// The change's size against the base: what counts, and when the loop's
// fixes have grown it past `loop.maxGrowth`.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatSize, grewPast, sizeOf } from '../plugins/quality-loop/scripts/lib/size.mjs'

const SKIP = ['**/package-lock.json', '**/dist/**']

/** `git diff --numstat -z --no-renames` output for these rows. @param {[string, string, string][]} rows */
const numstat = rows => rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join('')

test('size: code and test lines are counted apart; skipped paths and binary files are not counted', () => {
  const s = sizeOf(
    numstat([
      ['3', '1', 'src/cart.js'],
      ['10', '0', 'test/cart.test.js'],
      ['2', '2', 'src/util.spec.ts'],
      ['400', '380', 'package-lock.json'],
      ['-', '-', 'logo.png'],
      ['1', '0', 'dist/bundle.js'],
    ]),
    SKIP,
  )
  assert.deepEqual(s, { files: 3, code: 4, tests: 14 })
})

test('size: paths with tabs or spaces are read whole', () => {
  assert.deepEqual(sizeOf(numstat([['1', '1', 'src/a b\tc.js']]), []), { files: 1, code: 2, tests: 0 })
  assert.deepEqual(sizeOf('', []), { files: 0, code: 0, tests: 0 })
})

test('size: growth counts code lines only, past a fraction of the start with a floor of ten lines', () => {
  const start = { files: 1, code: 40, tests: 0 }
  assert.equal(grewPast(start, { files: 2, code: 60, tests: 90 }, 0.5), false, 'at the limit, and tests never count')
  assert.equal(grewPast(start, { files: 2, code: 61, tests: 0 }, 0.5), true)
  const tiny = { files: 1, code: 4, tests: 0 }
  assert.equal(grewPast(tiny, { files: 1, code: 14, tests: 0 }, 0.5), false, 'ten lines are always allowed')
  assert.equal(grewPast(tiny, { files: 1, code: 15, tests: 0 }, 0.5), true)
  assert.equal(grewPast(tiny, { files: 1, code: 500, tests: 0 }, null), false, 'null turns the meter off')
  assert.equal(grewPast(null, tiny, 0.5), false, 'a loop started before the meter has no start size')
})

test('size: formats as files, code and test lines', () => {
  assert.equal(formatSize({ files: 2, code: 14, tests: 9 }), '2 files, 14 code lines, 9 test lines')
  assert.equal(formatSize({ files: 1, code: 1, tests: 0 }), '1 file, 1 code line, 0 test lines')
})
