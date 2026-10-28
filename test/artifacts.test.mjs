// Files a review leaves behind: which paths are recorded, and what they cover.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { artifactRoots, isArtifact, mergeRoots } from '../plugins/quality-loop/scripts/lib/artifacts.mjs'

test('artifacts: a file in a new directory records the highest new directory; one in an existing directory records itself', () => {
  const dirs = new Set(['src', 'test'])
  assert.deepEqual(artifactRoots(['coverage/lcov/report.html', 'coverage/lcov.info', 'test/junit.xml', 'out.log', 'src/gen/x.js'], dirs), [
    'coverage/',
    'out.log',
    'src/gen/',
    'test/junit.xml',
  ])
})

test('artifacts: a directory covers everything under it, and merging drops what one covers', () => {
  assert.equal(isArtifact('coverage/a/b.json', ['coverage/']), true)
  assert.equal(isArtifact('coverage.js', ['coverage/']), false)
  assert.equal(isArtifact('out.log', ['out.log']), true)
  assert.deepEqual(mergeRoots(['out.log', 'coverage/x.json'], ['coverage/']), ['coverage/', 'out.log'])
})
