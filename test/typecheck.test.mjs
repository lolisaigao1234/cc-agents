import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TSC = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const CONFIG = 'plugins/trace/tsconfig.json'
const VENDORED = 'vendor/claude-code/index.d.ts'
const GENERATED = 'plugins/trace/.claude-plugin/types/claude-code/index.d.ts'

const tsc = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [TSC, '-p', CONFIG, ...args], { cwd: ROOT, encoding: 'utf8' })
const read = (/** @type {string} */ path) => readFileSync(resolve(ROOT, path), 'utf8')
// The first version number in `claude --version` or a declarations header.
const version = (/** @type {string} */ text) => text.match(/\d+\.\d+\.\d+/)?.[0]

// Claude Code writes a mod's declarations to .claude-plugin/types/ when an
// interactive session hot-reloads it (not, as of 2.1.312, under `claude -p`,
// `plugin test` or `plugin validate`), so a clean checkout has none (#25).
test("the mod's typecheck reads only committed files and node_modules", () => {
  const listed = tsc('--listFilesOnly')
  assert.equal(listed.status, 0, listed.stdout + listed.stderr)
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'))
  const loaded = listed.stdout.split('\n').filter(Boolean).map(f => relative(ROOT, resolve(ROOT, f)))
  assert.ok(loaded.some(f => f.startsWith('plugins/trace/hooks/')), loaded.join('\n'))
  assert.deepEqual(loaded.filter(f => !f.startsWith('node_modules/') && !tracked.has(f)), [])
})

// The snapshot checks the band against one Claude Code's API, so an upgrade
// fails here until the snapshot is refreshed (#25, README: Developing).
test('the vendored declarations come from the installed Claude Code', t => {
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (claude.error) return t.skip('claude is not on PATH')
  assert.equal(claude.status, 0, claude.stdout + claude.stderr)
  const vendored = version(read(VENDORED).split('\n', 1)[0])
  assert.equal(vendored, version(claude.stdout), `${VENDORED} is from Claude Code ${vendored}, but ${claude.stdout.trim()} is installed; see README, Developing`)
})

test('the vendored declarations match the ones Claude Code last wrote', t => {
  if (!existsSync(resolve(ROOT, GENERATED))) return t.skip('no interactive session has loaded the mod from this checkout')
  const [generated, vendored] = [read(GENERATED), read(VENDORED)]
  // ok, not equal: a failure names the two headers instead of diffing the whole file.
  assert.ok(generated === vendored, `${VENDORED} (${vendored.split('\n', 1)[0]}) differs from ${GENERATED} (${generated.split('\n', 1)[0]}); see README, Developing`)
})

test("the mod's typecheck writes nothing", () => {
  const shown = tsc('--showConfig')
  assert.equal(shown.status, 0, shown.stdout + shown.stderr)
  assert.equal(JSON.parse(shown.stdout).compilerOptions.noEmit, true)
})
