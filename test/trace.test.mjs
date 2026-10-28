import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { commandVerdict, editVerdict } from '../plugins/trace/scripts/lib/trace.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/**
 * In-memory git and GitHub: a repository at /repo, traced unless `traced` is
 * false, and an untraced one nested at /repo/sub.
 *
 * @param {{ traced?: boolean, branch?: string | null, defaultBranch?: string | null, issues?: Record<number, 'OPEN' | 'CLOSED'>, offline?: boolean, env?: Record<string, string>, messages?: Record<string, string>, aliases?: Record<string, string>, ghAliases?: Record<string, string> }} [o]
 */
function world(o = {}) {
  const { traced = true, branch = 'main', defaultBranch = 'main', issues = {}, offline = false, env = {}, messages = {}, aliases = {}, ghAliases = {} } = o
  return {
    git: {
      root: (/** @type {string} */ path) =>
        ['/repo/sub', '/repo'].find(r => path === r || path.startsWith(`${r}/`)) ?? null,
      traced: (/** @type {string} */ root) => root === '/repo' && traced,
      branch: () => branch,
      defaultBranch: () => defaultBranch,
      message: (/** @type {string} */ _root, /** @type {string} */ rev) => messages[rev] ?? null,
      alias: (/** @type {string} */ _root, /** @type {string} */ name) => aliases[name] ?? null,
    },
    github: {
      issueState: (/** @type {string} */ _root, /** @type {number} */ n) => (offline ? null : issues[n] ?? 'MISSING'),
      alias: (/** @type {string} */ name) => ghAliases[name] ?? null,
    },
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
  const why = editVerdict('/repo/.git/config', world({ branch: '6-x', issues: { 6: 'OPEN' } }))
  assert.match(String(why), /git directory/)
  assert.match(String(why), /Branch step/)
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

test("the hook refuses edits to a traced repository's git directory, even on an open issue's branch", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '6-x')
  for (const file of ['.git/config', '.git/HEAD', '.git/refs/heads/main']) {
    const out = hook({ tool_name: 'Write', tool_input: { file_path: join(dir, file), content: '' }, cwd: dir }, {}, { 'owner/name#6': { state: 'open' } })
    assert.equal(out?.permissionDecision, 'deny', file)
  }
})

test("the hook reads origin's GitHub repository from every URL form, and only from GitHub", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '6-x')
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }
  for (const url of ['ssh://git@github.com:22/owner/name.git', 'https://GitHub.com/owner/name', 'git@github.com:owner/name.git', 'gh:owner/name']) {
    git('remote', 'set-url', 'origin', url)
    git('config', 'url.https://github.com/.insteadOf', 'gh:')
    assert.equal(hook(edit, {}, { 'owner/name#6': { state: 'open' } }), null, url)
  }
  git('remote', 'set-url', 'origin', 'https://notgithub.com/owner/name')
  assert.equal(hook(edit, {}, { 'owner/name#6': { state: 'open' } })?.permissionDecision, 'deny')
  assert.equal(hook.calls, '')
})

test('a git that cannot run refuses edits only where the marker says the repository is traced', () => {
  const noGit = { PATH: '/nonexistent' }
  const { dir } = repo(false)
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }, noGit), null)
  const traced = repo().dir
  assert.equal(hook({ tool_name: 'Edit', tool_input: { file_path: join(traced, 'a.md') }, cwd: traced }, noGit)?.permissionDecision, 'deny')
})

test('the hook expands only ~ and ~/, as the edit tools do', () => {
  const { dir } = repo()
  const out = hook({ tool_name: 'Edit', tool_input: { file_path: '~nobody/a.md' }, cwd: dir })
  assert.equal(out?.permissionDecision, 'deny')
})

test('the hook refuses settings changes it cannot read, wherever the settings live', () => {
  const { dir } = repo(false)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')))
  const dotfiles = realpathSync(mkdtempSync(join(tmpdir(), 'dotfiles-')))
  symlinkSync(dotfiles, join(home, '.claude'))
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'config-')))
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config }
  const run = (/** @type {string} */ tool, /** @type {object} */ input) => hook({ tool_name: tool, tool_input: input, cwd: dir }, env)?.permissionDecision
  const off = JSON.stringify({ disableAllHooks: true })
  const paths = [join(home, '.claude/settings.json'), join(config, 'settings.json'), join(config, 'plugins/x/hooks.json')]
  if (process.platform === 'darwin') paths.push(join(dir, '.CLAUDE/settings.local.json'), join(dir, '.claude/Settings.Local.json'))
  for (const path of paths) assert.equal(run('Write', { file_path: path, content: off }), 'deny', path)
  assert.equal(run('Write', { file_path: join(dir, '.claude/settings.local.json'), content: JSON.stringify({ env: { NODE_OPTIONS: '--x' } }) }), 'deny', 'any env')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude/settings.json'), '// hooks below\n{ "hooks": {} }\n')
  assert.equal(run('Write', { file_path: join(dir, '.claude/settings.json'), content: '{}' }), 'deny', 'unparseable now')
  writeFileSync(join(dir, '.claude/settings.json'), '{ "permissions": {} }\r\n')
  assert.equal(run('Edit', { file_path: join(dir, '.claude/settings.json'), old_string: 'not there', new_string: 'x' }), 'deny', 'old_string not found')
  assert.equal(run('NotebookEdit', { notebook_path: join(dir, '.claude/settings.json'), new_source: off }), 'deny', 'NotebookEdit')
  assert.equal(run('Edit', { file_path: join(dir, '.claude/settings.json'), old_string: '{ "permissions": {} }', new_string: '{ "permissions": { "deny": [] } }' }), undefined, 'a permissions change')
})

// --- the commit and PR gates (#7) ----------------------------------------------

/** On the branch of open issue #7, in /repo. @param {Parameters<typeof world>[0]} [o] */
const onSeven = (o = {}) => world({ branch: '7-gates', issues: { 7: 'OPEN', 8: 'OPEN' }, ...o })
/** @param {string} command @param {Parameters<typeof world>[0]} [o] */
const verdict = (command, o) => commandVerdict(command, '/repo', onSeven(o))

test('a commit whose message references the branch issue is allowed, in any message form', () => {
  for (const command of [
    'git commit -m "Add the gate (#7)"',
    'git commit -m "Add the gate" -m "Part of #7."',
    'git commit -am "Add the gate #7"',
    'git commit --message="Add the gate #7"',
    'git commit --message "#7: add the gate"',
    "git commit -F - <<'EOF'\nAdd the gate\n\nRefs #7\nEOF",
    'git commit -F - <<< "Add the gate (#7)"',
    'git commit --amend -m "Reword (#7)"',
    'git -C /repo/src commit -m "x (#7)"',
    'git commit -m "x" -m "y #7" && echo done',
  ]) {
    assert.equal(verdict(command), null, command)
  }
})

test('a commit whose message does not reference the branch issue is refused, naming the issue and the text to add', () => {
  for (const command of ['git commit -m "Add the gate"', 'git commit -m a -m b', 'git commit -m "Add the gate #70"', 'git commit -m "see #77"', "git commit -F - <<'EOF'\nAdd the gate\nEOF", 'bash -c \'git commit -m "x"\'', 'true && git commit -m x']) {
    const why = String(verdict(command))
    assert.match(why, /#7\b/, command)
    assert.match(why, /Implement step/, command)
  }
})

test('an amend that keeps the message is judged by the commit it rewrites', () => {
  assert.equal(verdict('git commit --amend --no-edit', { messages: { HEAD: 'Add the gate (#7)' } }), null)
  assert.match(String(verdict('git commit --amend --no-edit', { messages: { HEAD: 'Add the gate' } })), /#7/)
  assert.equal(verdict('git commit -C abc123', { messages: { abc123: 'x (#7)' } }), null)
  assert.match(String(verdict('git commit --fixup=abc123', { messages: { abc123: 'x' } })), /#7/)
})

test('a commit whose message cannot be told from the command is refused with a reason', () => {
  for (const command of [
    'git commit',
    'git commit -a',
    'git commit -m "$(cat msg)"',
    'git commit -m "`cat msg`"',
    'echo "x #7" | git commit -F -',
    'git commit -F -',
    'git commit -e -m "x #7"',
    'git commit -t tmpl.txt',
    'cd "$DIR" && git commit -m x',
    'git --git-dir=/x/.git commit -m "x #7"',
    'git commit --amend --no-edit',
  ]) {
    assert.match(String(verdict(command)), /cannot tell/, command)
  }
})

test('a commit through a git alias is judged as the command it runs', () => {
  assert.match(String(verdict('git ci -m x', { aliases: { ci: 'commit -a' } })), /#7/)
  assert.equal(verdict('git ci -m "x #7"', { aliases: { ci: 'commit -a' } }), null)
  assert.match(String(verdict('git -c alias.k=commit k -m x')), /#7/)
  assert.match(String(verdict('git sh', { aliases: { sh: '!git commit -m x' } })), /cannot tell/)
  assert.match(String(verdict('cd "$X" && git ci -m x', { aliases: { ci: 'commit' } })), /cannot tell/)
  assert.equal(verdict('git st', { aliases: { st: 'status' } }), null)
})

test('the commit gate follows the branch rules and the trace switches of the edit gate', () => {
  assert.match(String(verdict('git commit -m "x #7"', { branch: 'main' })), /default branch/)
  assert.match(String(verdict('git commit -m "x #9"', { branch: '9-closed', issues: { 9: 'CLOSED' } })), /#9/)
  assert.equal(verdict('git commit -m x', { traced: false }), null)
  assert.equal(verdict('git commit -m x', { env: { TRACE_BYPASS: '1' } }), null)
  assert.equal(commandVerdict('git commit -m x', '/elsewhere', onSeven()), null)
  assert.equal(verdict('cd /elsewhere && git commit -m x'), null)
  assert.equal(verdict('git status && git log -1 && rg "git commit"'), null)
})

test('a PR whose body closes the branch issue is allowed', () => {
  for (const command of [
    'gh pr create --title t --body "Closes #7"',
    'gh pr create -t t -b "Some text.\n\nFixes #7"',
    'gh pr create --title t --body="resolves: #7"',
    "gh pr create --title t --body-file - <<'EOF'\n## Summary\n\nCloses #7.\nEOF",
    'gh pr create --base main --head 8-other --title t --body "Closes #8"',
  ]) {
    assert.equal(verdict(command), null, command)
  }
})

test('a PR whose body does not close the branch issue is refused, naming the issue and the text to add', () => {
  for (const command of ['gh pr create --title t --body "Refs #7"', 'gh pr create -t t -b "Closes #70"', 'gh pr create --head 8-other -t t -b "Closes #7"', 'gh pr create -t t -b "Closes #7 and more" --head 8-other']) {
    const why = String(verdict(command))
    assert.match(why, /Closes #(7|8)\b/, command)
    assert.match(why, /Review step/, command)
  }
})

test('a PR whose body cannot be told from the command is refused with a reason', () => {
  for (const command of ['gh pr create', 'gh pr create --fill', 'gh pr create -f', 'gh pr create --web', 'gh pr create -t t -b "$(cat body.md)"', 'cat body.md | gh pr create -t t -F -', 'gh pr create -t t --template t.md', 'gh prc', 'gh pc -t t']) {
    assert.match(String(verdict(command, { ghAliases: { prc: 'pr create --fill', pc: "!gh pr create \"$@\"" } })), /cannot tell|Closes #7/, command)
  }
  assert.equal(verdict('gh pr view 7 && gh issue create -t t -b x && gh pr list'), null)
})

test('the hook refuses an unreferenced commit or PR in a traced repository, in a subagent too, reading files from cwd', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '16-gates')
  const issues = { 'owner/name#16': { state: 'open' } }
  writeFileSync(join(dir, 'msg.txt'), 'Add the gate (#16)\n')
  writeFileSync(join(dir, 'bare.txt'), 'Add the gate\n')
  writeFileSync(join(dir, 'body.md'), '## Summary\n\nCloses #16\n')
  const bash = (/** @type {string} */ command, /** @type {object} */ extra = {}) => hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir, ...extra }, {}, issues)
  for (const extra of [{}, { agent_id: 'sub-1', agent_type: 'general-purpose' }]) {
    assert.match(String(bash('git commit -m "Add the gate"', extra)?.permissionDecisionReason), /trace: .*#16/)
    assert.equal(bash('git commit -m "Add the gate (#16)"', extra), null)
    assert.match(String(bash('gh pr create -t t -b "Refs #16"', extra)?.permissionDecisionReason), /trace: .*Closes #16/)
    assert.equal(bash('gh pr create -t t -b "Closes #16"', extra), null)
  }
  assert.equal(bash('git commit -F msg.txt'), null)
  assert.match(String(bash('git commit -F bare.txt')?.permissionDecisionReason), /#16/)
  assert.match(String(bash('git commit -F missing.txt')?.permissionDecisionReason), /cannot tell/)
  assert.equal(bash('gh pr create -t t --body-file body.md'), null)
  assert.match(String(bash('git commit --amend --no-edit')?.permissionDecisionReason), /#16/, 'HEAD says "init"')
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: dir }, { TRACE_BYPASS: '1' }), null)
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo(false).dir }), null)
})
