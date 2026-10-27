import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { capWindow, ensureCompactWindow } from '../plugins/quality-loop/scripts/lib/compact.mjs'
import { resolveConfig, validateConfig } from '../plugins/quality-loop/scripts/lib/config.mjs'
import { makeRepo } from './helpers.mjs'

test('compact: the context cap defaults to 300k and is validated', () => {
  assert.equal(resolveConfig({}).loop.maxContextTokens, 300000)
  assert.deepEqual(validateConfig(resolveConfig({ loop: { maxContextTokens: null } })), [], 'null turns the cap off')
  for (const bad of [50000, 2000000, 250000.5, '300k']) {
    assert.ok(validateConfig(resolveConfig({ loop: { maxContextTokens: bad } })).some(e => e.includes('maxContextTokens')), String(bad))
  }
})

test('compact: capWindow only ever lowers the window', () => {
  assert.deepEqual(capWindow({}, 300000), { autoCompactWindow: 300000 })
  assert.deepEqual(capWindow({ autoCompactWindow: 'auto', theme: 'dark' }, 300000), { autoCompactWindow: 300000, theme: 'dark' })
  assert.deepEqual(capWindow({ autoCompactWindow: 800000 }, 300000), { autoCompactWindow: 300000 })
  assert.equal(capWindow({ autoCompactWindow: 200000 }, 300000), null, 'a lower window stands')
  assert.equal(capWindow({ autoCompactWindow: 300000 }, 300000), null)
})

test('compact: capWindow lowers per-model windows, which replace the top-level one', () => {
  const out = capWindow({ autoCompactWindow: 300000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto', effortLevel: 'high' }, other: { autoCompactWindow: 150000 } } }, 300000)
  assert.deepEqual(out?.modelSettings, { 'claude-opus-5-5': { autoCompactWindow: 300000, effortLevel: 'high' }, other: { autoCompactWindow: 150000 } })
})

test('compact: ensureCompactWindow writes the local settings and keeps them out of git', () => {
  const root = makeRepo({ 'a.txt': 'a\n' })
  const r = ensureCompactWindow(root, 300000)
  assert.equal(r.changed, true)
  const file = join(root, '.claude/settings.local.json')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoCompactWindow, 300000)
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: root }).status, 0, 'ignored by git')
  assert.equal(ensureCompactWindow(root, 300000).changed, false, 'idempotent')
  const exclude = readFileSync(join(root, '.git/info/exclude'), 'utf8')
  assert.equal(exclude.split('\n').filter(l => l === '.claude/settings.local.json').length, 1, 'excluded once')
})

test('compact: ensureCompactWindow keeps the rest of an existing file and a lower window', () => {
  const root = makeRepo({ 'a.txt': 'a\n' })
  mkdirSync(join(root, '.claude'), { recursive: true })
  const file = join(root, '.claude/settings.local.json')
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, autoCompactWindow: 900000 }))
  assert.equal(ensureCompactWindow(root, 300000).previous, 900000)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls)'] }, autoCompactWindow: 300000 })
  writeFileSync(file, JSON.stringify({ autoCompactWindow: 120000 }))
  assert.equal(ensureCompactWindow(root, 300000).changed, false)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoCompactWindow, 120000)
})

test('compact: ensureCompactWindow leaves an unreadable settings file alone', () => {
  const root = makeRepo({ 'a.txt': 'a\n' })
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude/settings.local.json'), '{ not json')
  const r = ensureCompactWindow(root, 300000)
  assert.equal(r.changed, false)
  assert.match(r.error ?? '', /settings\.local\.json/)
  assert.equal(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'), '{ not json')
})
