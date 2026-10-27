import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { diffTrees, git, resolveBase, restoreTree, snapshotTree } from '../plugins/quality-loop/scripts/lib/git.mjs'
import { makeRepo } from './helpers.mjs'

test('snapshot/restore round-trips edits, new files and deletions without touching the index', () => {
  const root = makeRepo({ 'a.txt': 'one\n', 'b.txt': 'keep\n' })
  writeFileSync(`${root}/a.txt`, 'two\n')
  git(['add', 'a.txt'], { cwd: root })
  const indexBefore = git(['diff', '--cached', '--name-only'], { cwd: root }).stdout
  const cp = snapshotTree(root)

  writeFileSync(`${root}/a.txt`, 'three\n')
  writeFileSync(`${root}/new.txt`, 'created\n')
  mkdirSync(`${root}/.quality-loop`, { recursive: true })
  writeFileSync(`${root}/.quality-loop/state.json`, '{"keep":true}')
  git(['rm', '-q', 'b.txt'], { cwd: root })

  const { restored, deleted } = restoreTree(root, cp)
  assert.equal(readFileSync(`${root}/a.txt`, 'utf8'), 'two\n')
  assert.equal(readFileSync(`${root}/b.txt`, 'utf8'), 'keep\n')
  assert.equal(existsSync(`${root}/new.txt`), false)
  assert.equal(readFileSync(`${root}/.quality-loop/state.json`, 'utf8'), '{"keep":true}', 'loop files untouched')
  assert.deepEqual(restored.sort(), ['a.txt', 'b.txt'])
  assert.deepEqual(deleted, ['new.txt'])
  assert.equal(git(['stash', 'list'], { cwd: root }).stdout, '')
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: root }).ok, true)
  // the snapshot itself did not change what the user had staged
  assert.ok(indexBefore.includes('a.txt'))
})

test('diffTrees shows untracked files against the base and skips loop files', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const base = resolveBase(root, 'auto')
  writeFileSync(`${root}/fresh.js`, 'let x = 1\n')
  mkdirSync(`${root}/.quality-loop`, { recursive: true })
  writeFileSync(`${root}/.quality-loop/x.json`, '{}')
  const d = diffTrees(root, base, snapshotTree(root))
  assert.match(d, /fresh\.js/)
  assert.doesNotMatch(d, /quality-loop/)
})

test('resolveBase auto: merge-base with main when on a feature branch', () => {
  const root = makeRepo({ 'a.txt': 'one\n' })
  const main = git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  git(['checkout', '-q', '-b', 'feature'], { cwd: root })
  writeFileSync(`${root}/a.txt`, 'two\n')
  git(['commit', '-qam', 'feature work'], { cwd: root })
  assert.equal(resolveBase(root, 'auto'), main)
  assert.throws(() => resolveBase(root, 'nope'), /does not resolve/)
})
