import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { editVerdict } from '../plugins/trace/scripts/lib/trace.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/**
 * In-memory git and GitHub: a repository at /repo, traced unless `traced` is
 * false, and an untraced one nested at /repo/sub.
 *
 * @param {{ traced?: boolean, branch?: string | null, defaultBranch?: string | null, issues?: Record<number, 'OPEN' | 'CLOSED'>, offline?: boolean, env?: Record<string, string> }} [o]
 */
function world(o = {}) {
  const { traced = true, branch = 'main', defaultBranch = 'main', issues = {}, offline = false, env = {} } = o
  return {
    git: {
      root: (/** @type {string} */ path) =>
        ['/repo/sub', '/repo'].find(r => path === r || path.startsWith(`${r}/`)) ?? null,
      traced: (/** @type {string} */ root) => root === '/repo' && traced,
      branch: () => branch,
      defaultBranch: () => defaultBranch,
    },
    github: { issueState: (/** @type {string} */ _root, /** @type {number} */ n) => (offline ? null : issues[n] ?? 'MISSING') },
    env,
  }
}

test('a repository that has not opted in is never gated', () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ traced: false })), null)
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

test('when GitHub cannot be asked, the edit is refused, naming the step and the bypass', () => {
  const why = editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', offline: true }))
  assert.match(String(why), /Track/)
  assert.match(String(why), /TRACE_BYPASS/)
})

test('a detached HEAD where no default branch is known is refused, naming the Track step', () => {
  const why = editVerdict('/repo/src/a.js', world({ branch: null, defaultBranch: null }))
  assert.match(String(why), /Track/)
  assert.doesNotMatch(String(why), /default branch/)
})

test('a repository nested in a traced one, and not traced itself, is gated by the outer one', () => {
  assert.match(String(editVerdict('/repo/sub/a.js', world({ branch: 'main' }))), /default branch/)
  assert.equal(editVerdict('/repo/sub/a.js', world({ branch: '6-x', issues: { 6: 'OPEN' } })), null)
})

test('the bypass, set at launch, turns the trace off', () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ branch: 'main', env: { TRACE_BYPASS: '1' } })), null)
})

test('edits outside the repository are never gated, and its .git directory is', () => {
  assert.equal(editVerdict('/elsewhere/notes.md', world({ branch: 'main' })), null)
  assert.match(String(editVerdict('/repo/.git/config', world({ branch: 'main' }))), /default branch/)
})

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
  git('remote', 'add', 'origin', 'https://github.com/owner/name.git')
  return { dir, git }
}

/**
 * A `gh` on PATH that answers `gh api repos/<repo>/issues/<n>` from `issues`
 * (JSON keyed by "<repo>#<n>") and logs every call to `log`.
 */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')
const m = /^repos\\/(.+)\\/issues\\/(\\d+)$/.exec(args[0] === 'api' ? args[1] : '')
const issue = m && JSON.parse(process.env.FAKE_GH_ISSUES)[m[1] + '#' + m[2]]
if (!issue) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1) }
process.stdout.write(JSON.stringify(issue))
`

/** @param {object} input @param {Record<string, string>} [env] @param {Record<string, object>} [issues] */
function hook(input, env = {}, issues = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'gh-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const log = join(bin, 'log')
  writeFileSync(log, '')
  const r = spawnSync(process.execPath, [HOOK, 'pre-tool-use'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: JSON.stringify(issues), TRACE_BYPASS: '', ...env },
  })
  hook.calls = readFileSync(log, 'utf8')
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}
hook.calls = ''

test('the hook refuses an edit on the default branch of a traced repository, in a subagent too', () => {
  const { dir } = repo()
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
  const { dir } = repo()
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(repo(false).dir, 'a.md') }, cwd: dir }), null)
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'notes.md') }, cwd: dir }), null)
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }, { TRACE_BYPASS: '1' }), null)
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }), null)
})

test("the hook asks origin's repository about the issue, and refuses a pull request's number", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '15-a-pull-request')
  git('remote', 'add', 'upstream', 'https://github.com/other/fork.git')
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }
  const out = hook(edit, {}, { 'owner/name#15': { state: 'open', pull_request: {} }, 'other/fork#15': { state: 'open' } })
  assert.equal(out?.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /#15 is not an open issue/)
  assert.match(hook.calls, /repos\/owner\/name\/issues\/15/)
  git('checkout', '-qb', '16-an-issue')
  assert.equal(hook(edit, {}, { 'owner/name#16': { state: 'open' } }), null)
})

test('the hook resolves symlinks and ~ before deciding', () => {
  const { dir } = repo()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')))
  symlinkSync(dir, join(outside, 'link'))
  const out = hook({ tool_name: 'Edit', tool_input: { file_path: join(outside, 'link/a.md') }, cwd: outside })
  assert.equal(out?.permissionDecision, 'deny')
  const home = hook({ tool_name: 'Edit', tool_input: { file_path: '~/a.md' }, cwd: outside }, { HOME: dir })
  assert.equal(home?.permissionDecision, 'deny')
})

test('the hook refuses a settings change that would switch the hooks or the trace off', () => {
  const { dir } = repo(false)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), '{ "permissions": { "deny": [] } }\n')
  const write = (/** @type {string} */ path, /** @type {object} */ json) =>
    hook({ tool_name: 'Write', tool_input: { file_path: path, content: JSON.stringify(json) }, cwd: dir }, { HOME: home })
  for (const json of [{ env: { TRACE_BYPASS: '1' } }, { disableAllHooks: true }, { enabledPlugins: { 'trace@x': false } }, { hooks: {} }]) {
    for (const path of [join(dir, '.claude/settings.json'), join(dir, '.claude/settings.local.json'), join(home, '.claude/settings.json')]) {
      assert.equal(write(path, json)?.permissionDecision, 'deny', `${path} ${JSON.stringify(json)}`)
    }
  }
  const escaped = hook({ tool_name: 'Write', tool_input: { file_path: join(dir, '.claude/settings.json'), content: '{"env":{"TRACE\\u005fBYPASS":"1"}}' }, cwd: dir }, { HOME: home })
  assert.equal(escaped?.permissionDecision, 'deny', 'unicode-escaped key')
  const edit = hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, '.claude/settings.json'), old_string: '{ "permissions"', new_string: '{ "disableAllHooks": true, "permissions"' }, cwd: dir }, { HOME: home })
  assert.equal(edit?.permissionDecision, 'deny', 'Edit')
  const plugin = hook({ tool_name: 'Write', tool_input: { file_path: join(home, '.claude/plugins/cache/x/trace/hooks/hooks.json'), content: '{}' }, cwd: dir }, { HOME: home })
  assert.equal(plugin?.permissionDecision, 'deny', 'plugin code')
  assert.equal(write(join(dir, '.claude/settings.json'), { permissions: { deny: ['Read(./archive/**)'] } }), null)
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: join(home, '.claude/projects/p/memory/m.md'), content: 'x' }, cwd: dir }, { HOME: home }), null)
})
