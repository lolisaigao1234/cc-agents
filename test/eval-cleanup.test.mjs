import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from '../evals/review/lib/cleanup.mjs'

const root = () => mkdtempSync(join(tmpdir(), 'eval-cleanup-'))

test('a run directory holding a directory with no permissions is still removed', () => {
  const dir = root()
  mkdirSync(join(dir, 'archive-block-x/locked/inner'), { recursive: true })
  writeFileSync(join(dir, 'archive-block-x/locked/inner/f'), 'x')
  chmodSync(join(dir, 'archive-block-x/locked'), 0o000)
  /** @type {string[]} */
  const warnings = []
  removeTree(dir, m => warnings.push(m))
  assert.equal(existsSync(dir), false)
  assert.deepEqual(warnings, [])
})

test('a read-only directory and its files are removed', () => {
  const dir = root()
  mkdirSync(join(dir, 'ro'))
  writeFileSync(join(dir, 'ro/f'), 'x')
  chmodSync(join(dir, 'ro/f'), 0o000)
  chmodSync(join(dir, 'ro'), 0o500)
  removeTree(dir)
  assert.equal(existsSync(dir), false)
})

test('a path that is not there is fine', () => {
  /** @type {string[]} */
  const warnings = []
  removeTree(join(tmpdir(), 'eval-cleanup-never-made'), m => warnings.push(m))
  assert.deepEqual(warnings, [])
})

test('a symlink is removed without changing what it points to', () => {
  const dir = root()
  const outside = root()
  chmodSync(outside, 0o500)
  symlinkSync(outside, join(dir, 'link'))
  mkdirSync(join(dir, 'locked'))
  chmodSync(join(dir, 'locked'), 0o000)
  removeTree(dir)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(outside), true)
  assert.equal(statSync(outside).mode & 0o777, 0o500, 'the link target keeps its mode')
  chmodSync(outside, 0o700)
})
