import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { editVerdict } from '../plugins/trace/scripts/lib/trace.mjs'

/**
 * In-memory git and GitHub: one repository at /repo.
 *
 * @param {{ marked?: boolean, branch?: string | null, defaultBranch?: string | null, issues?: Record<number, 'OPEN' | 'CLOSED'>, offline?: boolean, env?: Record<string, string> }} [o]
 */
function world(o = {}) {
  const { marked = true, branch = 'main', defaultBranch = 'main', issues = {}, offline = false, env = {} } = o
  return {
    git: {
      root: (/** @type {string} */ dir) => (dir === '/repo' || dir.startsWith('/repo/') ? '/repo' : null),
      marked: () => marked,
      branch: () => branch,
      defaultBranch: () => defaultBranch,
    },
    github: { issueState: (/** @type {string} */ _root, /** @type {number} */ n) => (offline ? null : issues[n] ?? 'MISSING') },
    env,
  }
}

test('a repository that has not opted in is never gated', () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ marked: false })), null)
})

test('an edit on the default branch is refused, naming the Branch step', () => {
  const why = editVerdict('/repo/src/a.js', world({ branch: 'main' }))
  assert.match(String(why), /default branch/)
  assert.match(String(why), /Branch/)
  assert.match(String(why), /gh issue develop/)
})

test('an edit on a branch that names no issue is refused, naming the Track step', () => {
  for (const branch of ['feature/x', 'fix-6', null]) {
    const why = editVerdict('/repo/src/a.js', world({ branch, issues: { 6: 'OPEN' } }))
    assert.match(String(why), /Track/, String(branch))
  }
})

test("an edit on an open issue's branch is allowed", () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', issues: { 6: 'OPEN' } })), null)
})

test("an edit on a closed or missing issue's branch is refused, naming the Track step", () => {
  for (const issues of /** @type {Record<number, 'OPEN' | 'CLOSED'>[]} */ ([{ 6: 'CLOSED' }, {}])) {
    const why = editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', issues }))
    assert.match(String(why), /#6/)
    assert.match(String(why), /Track/)
  }
})

test('when GitHub cannot be asked, the edit is refused and the bypass named', () => {
  const why = editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', offline: true }))
  assert.match(String(why), /TRACE_BYPASS/)
})

test('the bypass, set at launch, turns the trace off', () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ branch: 'main', env: { TRACE_BYPASS: '1' } })), null)
})

test('edits outside the working tree are never gated', () => {
  for (const path of ['/elsewhere/notes.md', '/repo/.git/COMMIT_EDITMSG']) {
    assert.equal(editVerdict(path, world({ branch: 'main' })), null, path)
  }
})

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/** A git repository on `main`, opted in to the trace unless `marked` is false. */
function repo(marked = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-')))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.md'), 'x\n')
  if (marked) {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude/trace.json'), '{}\n')
  }
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

/** @param {object} input @param {Record<string, string>} [env] */
function hook(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, 'pre-tool-use'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TRACE_BYPASS: '', ...env } })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}

test('the hook refuses an edit on the default branch of a traced repository, in a subagent too', () => {
  const dir = repo()
  for (const [tool, input] of /** @type {[string, Record<string, string>][]} */ ([
    ['Edit', { file_path: join(dir, 'a.md') }],
    ['Write', { file_path: join(dir, 'new/b.md') }],
    ['MultiEdit', { file_path: join(dir, 'a.md') }],
    ['NotebookEdit', { notebook_path: join(dir, 'n.ipynb') }],
  ])) {
    for (const extra of [{}, { agent_id: 'sub-1', agent_type: 'general-purpose' }]) {
      const out = hook({ tool_name: tool, tool_input: input, cwd: dir, ...extra })
      assert.equal(out?.permissionDecision, 'deny', `${tool} ${JSON.stringify(extra)}`)
      assert.match(out.permissionDecisionReason, /trace: .*default branch/)
    }
  }
})

test('the hook lets edits through in an untraced repository, outside it, and under the bypass', () => {
  const dir = repo()
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(repo(false), 'a.md') }, cwd: dir }), null)
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'notes.md') }, cwd: dir }), null)
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }, { TRACE_BYPASS: '1' }), null)
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }), null)
})
