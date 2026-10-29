import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TSC = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const CONFIG = 'plugins/trace/tsconfig.json'

const tsc = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [TSC, '-p', CONFIG, ...args], { cwd: ROOT, encoding: 'utf8' })

// Claude Code writes a mod's declarations to .claude-plugin/types/ only in an
// interactive session that hot-reloads it, so a clean checkout has none (#25).
test("the mod's typecheck reads only committed files and node_modules", () => {
  const listed = tsc('--listFilesOnly')
  assert.equal(listed.status, 0, listed.stdout + listed.stderr)
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'))
  const loaded = listed.stdout.split('\n').filter(Boolean).map(f => relative(ROOT, resolve(ROOT, f)))
  assert.ok(loaded.some(f => f.startsWith('plugins/trace/hooks/')), loaded.join('\n'))
  assert.deepEqual(loaded.filter(f => !f.startsWith('node_modules/') && !tracked.has(f)), [])
})

test("the mod's typecheck writes nothing", () => {
  const shown = tsc('--showConfig')
  assert.equal(shown.status, 0, shown.stdout + shown.stderr)
  assert.equal(JSON.parse(shown.stdout).compilerOptions.noEmit, true)
})
