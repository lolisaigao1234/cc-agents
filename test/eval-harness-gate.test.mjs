import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../evals/review/run.mjs', import.meta.url))

/**
 * A git repository with a gated directory and a flow whose `_state.json` lists it.
 * HOME is empty, so the runner stops at its token check, after the gate and
 * before any network call.
 *
 * @param {string[]} harnessPaths
 */
function gatedRepo(harnessPaths) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gate-')))
  spawnSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, 'gated/sub'), { recursive: true })
  writeFileSync(join(root, 'gated/a.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'gated/sub/b.json'), '{}\n')
  mkdirSync(join(root, 'flow'))
  writeFileSync(join(root, 'flow/_state.json'), JSON.stringify({ harness_paths: harnessPaths }))
  mkdirSync(join(root, 'home'))
  return root
}

/**
 * Runs the runner's dry run in `root`.
 *
 * @param {string} root
 * @param {string[]} [extra]
 */
function dryRun(root, extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, '--flow', 'flow', '--variant', 'baseline', '--model', 'claude-opus-5-5', '--dry-run', ...extra], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home') },
  })
  return { code: r.status, stderr: r.stderr }
}

/**
 * The run got past the gate: it stopped at the token check that follows it.
 *
 * @param {{ stderr: string }} r
 */
function assertPassedGate(r) {
  assert.doesNotMatch(r.stderr, /harness changed|refusing to run: harness/)
  assert.match(r.stderr, /gh-token/)
}

test('the runner refuses once a file inside a gated directory changes', () => {
  const root = gatedRepo(['gated'])
  assert.match(dryRun(root, ['--approve-harness']).stderr, /harness approved/)
  assertPassedGate(dryRun(root))

  writeFileSync(join(root, 'gated/sub/b.json'), '{"changed": true}\n')

  const r = dryRun(root)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /harness changed/)
})

test('a new file in a gated directory needs approval before it is committed', () => {
  const root = gatedRepo(['gated'])
  dryRun(root, ['--approve-harness'])

  writeFileSync(join(root, 'gated/sub/hook.mjs'), 'process.exit(0)\n')

  assert.match(dryRun(root).stderr, /harness changed/)
})

test('a listed path that is not there refuses rather than leaving it out', () => {
  const root = gatedRepo(['gated', 'not-here'])

  const r = dryRun(root, ['--approve-harness'])

  assert.equal(r.code, 2)
  assert.match(r.stderr, /not-here/)
  assert.doesNotMatch(r.stderr, /harness approved/)
})

test('a file git ignores inside a gated directory does not need approval', () => {
  const root = gatedRepo(['gated'])
  writeFileSync(join(root, '.gitignore'), '/gated/types/\n')
  mkdirSync(join(root, 'gated/types'))
  writeFileSync(join(root, 'gated/types/generated.d.ts'), 'export {}\n')
  dryRun(root, ['--approve-harness'])

  writeFileSync(join(root, 'gated/types/generated.d.ts'), 'export declare const regenerated: 1\n')

  assertPassedGate(dryRun(root))
})
