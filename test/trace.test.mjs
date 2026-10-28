import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { commandVerdict, editVerdict } from '../plugins/trace/scripts/lib/trace.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/**
 * In-memory git and GitHub: a repository at /repo, traced unless `traced` is
 * false, and an untraced one nested at /repo/sub.
 *
 * @param {{ traced?: boolean, branch?: string | null, defaultBranch?: string | null, issues?: Record<number, 'OPEN' | 'CLOSED'>, offline?: boolean, env?: Record<string, string>, messages?: Record<string, string>, aliases?: Record<string, string>, ghAliases?: Record<string, string> | null, config?: Record<string, string>, base?: string }} [o]
 */
function world(o = {}) {
  const { traced = true, branch = 'main', defaultBranch = 'main', issues = {}, offline = false, env = {}, messages = {}, aliases = {}, ghAliases = {}, config = {}, base = 'owner/name' } = o
  return {
    git: {
      root: (/** @type {string} */ path) =>
        ['/repo/sub', '/repo'].find(r => path === r || path.startsWith(`${r}/`)) ?? null,
      traced: (/** @type {string} */ root) => root === '/repo' && traced,
      branch: () => branch,
      defaultBranch: () => defaultBranch,
      origin: () => 'owner/name',
      ghBase: () => base,
      message: (/** @type {string} */ _root, /** @type {string} */ rev) => messages[rev] ?? null,
      config: (/** @type {string} */ _root, /** @type {string} */ key) =>
        config[key] ?? (key.startsWith('alias.') ? aliases[key.slice('alias.'.length)] : undefined) ?? null,
      headDocs: () => ({}),
      pushed: () => null,
      committed: () => false,
    },
    github: {
      issueState: (/** @type {string} */ _root, /** @type {number} */ n) => (offline ? null : issues[n] ?? 'MISSING'),
      issue: () => ({ title: '', body: '', comments: [] }),
      pr: () => /** @type {const} */ ('NONE'),
      alias: (/** @type {string} */ name) => {
        if (ghAliases === null) throw new Error('gh alias list failed')
        return ghAliases[name] ?? null
      },
    },
    env,
    reads: { records: () => [], add() {}, clear() {} },
    once: () => true,
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
 * (JSON keyed by "<repo>#<n>"), and `…/comments` with its `thread`, one
 * JSON line each, and logs every call to `log`.
 */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')
if (args[0] === 'alias' && args[1] === 'list') process.exit(0)
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = JSON.parse(process.env.FAKE_GH_PRS ?? '{}')[args[2]]
  if (!pr) { process.stderr.write('no pull requests found for branch "' + args[2] + '"\\n'); process.exit(1) }
  process.stdout.write(JSON.stringify(pr))
  process.exit(0)
}
const m = /^repos\\/(.+)\\/issues\\/(\\d+)(\\/comments)?$/.exec(args[0] === 'api' ? args.find(a => a.startsWith('repos/')) ?? '' : '')
const issue = m && JSON.parse(process.env.FAKE_GH_ISSUES)[m[1] + '#' + m[2]]
if (!issue) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1) }
process.stdout.write(m[3] ? (issue.thread ?? []).map(c => JSON.stringify(c) + '\\n').join('') : JSON.stringify(issue))
`

/** @param {object} input @param {Record<string, string>} [env] @param {Record<string, object>} [issues] */
function hook(input, env = {}, issues = {}, event = 'pre-tool-use') {
  const bin = mkdtempSync(join(tmpdir(), 'gh-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const log = join(bin, 'log')
  writeFileSync(log, '')
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: JSON.stringify(issues), TRACE_BYPASS: '', ...env },
  })
  hook.calls = readFileSync(log, 'utf8')
  if (!r.stdout) return null
  const out = JSON.parse(r.stdout)
  return out.hookSpecificOutput ?? out
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

test("the hook counts an agent's own full reads only, and only while the docs are unchanged", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '8-doc-authority')
  const glossary = join(dir, 'GLOSSARY.md')
  writeFileSync(glossary, '# Terms\n\nA term.\n')
  const issues = { 'owner/name#8': { state: 'open', title: 'Doc authority', body: '', comments: 1, thread: [{ id: '5', author: 'h', body: 'Keep it short.' }] } }
  const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
  const as = (/** @type {string | undefined} */ agent) => (agent ? { session_id: session, agent_id: agent, agent_type: 'general-purpose' } : { session_id: session })
  const edit = (/** @type {string} */ agent = '') => hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, ...as(agent) }, {}, issues)
  /** @param {string} agent @param {string} tool_name @param {object} tool_input @param {object} tool_response */
  const post = (agent, tool_name, tool_input, tool_response) => hook({ tool_name, tool_input, tool_response, cwd: dir, ...as(agent) }, {}, issues, 'post-tool-use')
  const readAll = (/** @type {string} */ agent = '') => {
    const content = readFileSync(glossary, 'utf8')
    const lines = content.split('\n').length
    post(agent, 'Read', { file_path: glossary }, { type: 'text', file: { filePath: glossary, content, numLines: lines, startLine: 1, totalLines: lines } })
    post(agent, 'Bash', { command: 'gh issue view 8' }, { stdout: 'title:\tDoc authority\nstate:\tOPEN\n', stderr: '', interrupted: false })
    post(agent, 'Bash', { command: 'gh issue view 8 --comments' }, { stdout: 'author:\th\n--\nKeep it short.\n--\n', stderr: '', interrupted: false })
  }
  assert.match(String(edit()?.permissionDecisionReason), /^trace: the related docs are not all read\. Unread: GLOSSARY\.md; issue #8: its title, comment 5 by h/)
  readAll()
  assert.equal(edit(), null)
  assert.match(String(edit('a1b2c3')?.permissionDecisionReason), /Unread: GLOSSARY\.md; issue #8/, "a parent's reads do not count for its subagent")
  // A record copied from another agent, or written by hand, is not signed for this one.
  const store = join(realpathSync(tmpdir()), 'trace-reads', session)
  mkdirSync(join(store, 'f00d'), { recursive: true })
  for (const name of readdirSync(join(store, 'main'))) copyFileSync(join(store, 'main', name), join(store, 'f00d', name))
  const forged = { file: glossary, hash: createHash('sha256').update(readFileSync(glossary, 'utf8')).digest('hex'), from: 1, to: 4 }
  writeFileSync(join(store, 'f00d', 'forged.json'), JSON.stringify({ record: forged, sig: 'x' }))
  writeFileSync(join(store, 'f00d', 'bare.json'), JSON.stringify(forged))
  assert.match(String(edit('f00d')?.permissionDecisionReason), /Unread: GLOSSARY\.md; issue #8/)
  readAll('a1b2c3')
  assert.equal(edit('a1b2c3'), null)
  writeFileSync(glossary, '# Terms\n\nA changed term.\n')
  assert.match(String(edit()?.permissionDecisionReason), /Unread: GLOSSARY\.md \(stale: changed since this agent read it\)\./)
  assert.match(String(hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }, {}, issues)?.permissionDecisionReason), /cannot tell which agent this is/)
  assert.match(String(hook({ tool_name: 'Bash', tool_input: { command: 'git commit -m "x (#8)"' }, cwd: dir, ...as('') }, {}, issues)?.permissionDecisionReason), /GLOSSARY\.md \(stale/)
})

test('during a rebase, the branch being rebased is the one the trace reads', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '8-doc-authority')
  writeFileSync(join(dir, 'a.md'), 'mine\n')
  git('commit', '-qam', 'mine (#8)')
  git('checkout', '-q', 'main')
  writeFileSync(join(dir, 'a.md'), 'theirs\n')
  git('commit', '-qam', 'theirs')
  git('checkout', '-q', '8-doc-authority')
  assert.throws(() => git('rebase', 'main'), 'the rebase stops on the conflict')
  const issues = { 'owner/name#8': { state: 'open', title: '', body: '', comments: 0 } }
  const out = hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: `s-${process.pid}` }, {}, issues)
  assert.equal(out, null, String(out?.permissionDecisionReason))
})

test('the hook tells each agent about the linked issue when it starts, nudges once at a stop, and forgets reads on compaction', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '9-keep-context')
  writeFileSync(join(dir, 'GLOSSARY.md'), '# Terms\n')
  const issues = { 'owner/name#9': { state: 'open', title: 'Keep context', body: '## Acceptance criteria\n\n- [ ] it works\n', comments: 1, thread: [{ id: '1', author: 'h', body: 'Started.', at: '2026-01-01T00:00:00Z' }] } }
  const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
  const start = hook({ hook_event_name: 'SessionStart', source: 'compact', cwd: dir, session_id: session }, {}, issues, 'session-start')
  assert.equal(start?.hookEventName, 'SessionStart')
  assert.match(String(start?.additionalContext), /^Trace: this branch belongs to issue #9, "Keep context" \(owner\/name\)\. .*\nAcceptance criteria:\n> - \[ \] it works\n\nLatest comment, by h on 2026-01-01:\n> Started\.\n\nRelated docs, .*GLOSSARY\.md, and issue #9's title, body and 1 comment\./s)
  const sub = hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose', cwd: dir, session_id: session }, {}, issues, 'subagent-start')
  assert.equal(sub?.hookEventName, 'SubagentStart')
  assert.match(String(sub?.additionalContext), /issue #9, "Keep context"/)
  const untraced = repo(false).dir
  for (const [source, event] of [['startup', 'session-start'], ['resume', 'session-start'], ['compact', 'session-start'], [undefined, 'subagent-start']]) {
    assert.equal(hook({ hook_event_name: 'x', source, agent_id: 'a1', cwd: untraced, session_id: session }, {}, issues, event), null, `an untraced repository is told nothing: ${event} ${source}`)
  }
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: false, cwd: untraced, session_id: session }, {}, issues, 'stop'), null)

  const stop = () => hook({ hook_event_name: 'Stop', stop_hook_active: false, cwd: dir, session_id: session }, {}, issues, 'stop')
  assert.equal(stop(), null, 'nothing pushed yet')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('update-ref', 'refs/remotes/origin/9-keep-context', 'HEAD')
  assert.equal(stop(), null, 'the pushed branch holds nothing beyond its base')
  // Committed before the last comment, pushed after it.
  process.env.GIT_COMMITTER_DATE = '2025-12-01T00:00:00Z'
  try {
    git('commit', '-q', '--allow-empty', '-m', 'old work (#9)')
  } finally {
    delete process.env.GIT_COMMITTER_DATE
  }
  git('update-ref', 'refs/remotes/origin/9-keep-context', 'HEAD')
  const nudge = { decision: 'block', reason: 'trace: commits were pushed to 9-keep-context after the last comment on #9. Update step: post a progress comment on #9 (progress, decisions, verification results), with `gh issue comment 9 -R owner/name`. This asks once.' }
  assert.deepEqual(stop(), nudge)
  assert.equal(stop(), null, 'then lets the stop through')
  assert.equal(hook({ hook_event_name: 'Stop', stop_hook_active: false, cwd: dir, session_id: `${session}-2` }, {}, issues, 'stop'), null, 'and a new session too, for the same head')
  // Pushed to an upstream of another name.
  git('commit', '-q', '--allow-empty', '-m', 'more (#9)')
  git('update-ref', 'refs/remotes/origin/keep-context', 'HEAD')
  git('config', 'branch.9-keep-context.remote', 'origin')
  git('config', 'branch.9-keep-context.merge', 'refs/heads/keep-context')
  assert.deepEqual(stop(), nudge)

  const glossary = join(dir, 'GLOSSARY.md')
  const as = { cwd: dir, session_id: session }
  hook({ tool_name: 'Read', tool_input: { file_path: glossary }, tool_response: { type: 'text', file: { filePath: glossary, content: '# Terms\n', numLines: 2, startLine: 1, totalLines: 2 } }, ...as }, {}, issues, 'post-tool-use')
  hook({ tool_name: 'Bash', tool_input: { command: 'gh issue view 9 --comments' }, tool_response: { stdout: 'Keep context\n## Acceptance criteria\n\n- [ ] it works\nStarted.\n', stderr: '', interrupted: false }, ...as }, {}, issues, 'post-tool-use')
  const edit = () => hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, ...as }, {}, issues)
  assert.equal(edit(), null)
  hook({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: '', ...as }, {}, issues, 'post-compact')
  assert.match(String(edit()?.permissionDecisionReason), /Unread: GLOSSARY\.md; issue #9/, 'what was read before compaction is gone from context')
  // The main session's compaction may show only as SessionStart with source compact.
  hook({ tool_name: 'Read', tool_input: { file_path: glossary }, tool_response: { type: 'text', file: { filePath: glossary, content: '# Terms\n', numLines: 2, startLine: 1, totalLines: 2 } }, ...as }, {}, issues, 'post-tool-use')
  hook({ tool_name: 'Bash', tool_input: { command: 'gh issue view 9 --comments' }, tool_response: { stdout: 'Keep context\n## Acceptance criteria\n\n- [ ] it works\nStarted.\n', stderr: '', interrupted: false }, ...as }, {}, issues, 'post-tool-use')
  assert.equal(edit(), null)
  hook({ hook_event_name: 'SessionStart', source: 'resume', ...as }, {}, issues, 'session-start')
  assert.equal(edit(), null, 'a resumed session keeps its context')
  hook({ hook_event_name: 'SessionStart', source: 'compact', ...as }, {}, issues, 'session-start')
  assert.match(String(edit()?.permissionDecisionReason), /Unread: GLOSSARY\.md; issue #9/)
})

test("the status event reports the trace from real git and gh: the commits, the PR and its checks", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '10-trace-band')
  const issues = { 'owner/name#10': { state: 'open', title: 'Trace band', body: 'Show it.', comments: 0 } }
  const status = (/** @type {Record<string, unknown>} */ prs = {}) => hook({ cwd: dir, session_id: `s-${process.pid}` }, { FAKE_GH_PRS: JSON.stringify(prs) }, issues, 'status')
  const before = status()
  console.log('DBG', JSON.stringify(before), hook.calls)
  assert.deepEqual([before?.step, before?.docs, before?.issue], ['read', 'unread', { n: 10, title: 'Trace band', url: 'https://github.com/owner/name/issues/10' }])
  assert.ok(!before?.done.includes('implement'))
  git('commit', '-q', '--allow-empty', '-m', 'the band (#100)')
  assert.ok(!status()?.done.includes('implement'), '#100 is not #10')
  git('commit', '-q', '--allow-empty', '-m', 'the band (#10)')
  assert.ok(status()?.done.includes('implement'))
  const rollup = [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' },
  ]
  const after = status({ '10-trace-band': { number: 21, url: 'https://github.com/owner/name/pull/21', state: 'OPEN', statusCheckRollup: rollup } })
  assert.deepEqual(after?.pr, { n: 21, url: 'https://github.com/owner/name/pull/21', state: 'OPEN', ci: 'failing', checks: [{ name: 'test', state: 'SUCCESS' }, { name: 'lint', state: 'PENDING' }, { name: 'ci/legacy', state: 'FAILURE' }] })
  assert.ok(after?.done.includes('review'))
  assert.equal(hook({ cwd: repo(false).dir, session_id: 's' }, {}, issues, 'status'), null, 'untraced: nothing')
})

test("the hook refuses tools that would touch the trace's read records, and only those", () => {
  const { dir } = repo(false)
  for (const command of ['echo {} > "$TMPDIR/trace-reads/s/main/x.json"', `rm ${join(tmpdir(), 'trace-reads')}/s/main/x.json`, 'cd "$TMPDIR" && cat trace-reads/.key']) {
    assert.match(String(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir })?.permissionDecisionReason), /records of what each agent has read/, command)
  }
  const out = hook({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'trace-reads', 's', 'main', 'x.json'), content: '{}' }, cwd: dir })
  assert.match(String(out?.permissionDecisionReason), /records of what each agent has read/)
  for (const command of ['rg -n trace-reads plugins', 'rg -n foo /tmp/trace-reads-notes']) assert.equal(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }), null, command)
  assert.equal(hook({ tool_name: 'Write', tool_input: { file_path: join(dir, 'src/trace-reads/index.js'), content: '' }, cwd: dir }), null)
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

test('a commit whose message references the linked issue is allowed, in any message form', () => {
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

test('a commit whose message does not reference the linked issue is refused, naming the issue and the text to add', () => {
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

test('a PR whose body closes the linked issue is allowed', () => {
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

test('a PR whose body does not close the linked issue is refused, naming the issue and the text to add', () => {
  for (const command of ['gh pr create --title t --body "Refs #7"', 'gh pr create -t t -b "Closes #70"', 'gh pr create --head 8-other -t t -b "Closes #7"', 'gh pr create -t t -b "Closes #7 and more" --head 8-other']) {
    const why = String(verdict(command))
    assert.match(why, /Closes #(7|8)\b/, command)
    assert.match(why, /Review step/, command)
  }
})

test('a PR whose body cannot be told from the command is refused with a reason', () => {
  for (const command of ['gh pr create', 'gh pr create --fill', 'gh pr create -f', 'gh pr create --web', 'gh pr create -t t -b "$(cat body.md)"', 'cat body.md | gh pr create -t t -F -', 'gh pr create -t t --template t.md', 'gh prc', 'gh pc -t t']) {
    assert.match(String(verdict(command, { ghAliases: { prc: 'pr create --fill', pc: "!gh pr create \"$@\"" } })), /cannot tell/, command)
  }
  assert.equal(verdict('gh pr view 7 && gh issue create -t t -b x && gh pr list'), null)
})

test('a commit message is judged as git records it: fixups, trailers, cleanup and comment lines', () => {
  assert.equal(verdict('git commit --fixup=abc', { messages: { abc: 'Add the gate (#7)\n\nBody' } }), null)
  assert.match(String(verdict('git commit --fixup abc', { messages: { abc: 'Add the gate\n\nRefs #7' } })), /does not reference #7/)
  assert.equal(verdict('git commit -m x --trailer "Refs: #7"'), null)
  assert.match(String(verdict('git commit --cleanup=strip -m "#7: add the gate"')), /does not reference #7/)
  assert.match(String(verdict('git -c commit.cleanup=strip commit -m "#7: add the gate"')), /does not reference #7/)
  assert.match(String(verdict('git commit -m "#7: add the gate"', { config: { 'commit.cleanup': 'strip' } })), /does not reference #7/)
  assert.equal(verdict('git -c core.commentChar=";" commit --cleanup=strip -m "#7: add the gate"'), null)
  // Without an editor, git reads scissors as whitespace.
  assert.equal(verdict('git commit --cleanup=scissors -m "#7 x" -m "# ------------------------ >8 ------------------------"'), null)
  assert.equal(verdict('git commit --dry-run'), null)
})

test('a commit an editor, an unknown option or a computed source decides is refused with a reason', () => {
  for (const command of [
    'git commit --fixup=amend:abc',
    'git commit --fixup=reword:abc',
    'git commit --squash=abc',
    'git commit -c abc',
    'git commit --reedit-message=abc',
    'git commit --amend',
    'git commit --ed -m "x #7"',
    'git commit --bogus -m "x #7"',
    'git commit --cleanup="$M" -m "#7: x"',
    'echo x > m.txt && git commit -F m.txt',
    'printf x > "$F" && git commit -F m.txt',
    'git --config-env=alias.k=CMD k -m "x #7"',
    '$(echo git) commit -m x',
    '$G commit -m x',
  ]) {
    assert.match(String(verdict(command, { messages: { abc: 'x (#7)' } })), /cannot tell/, command)
  }
  assert.equal(verdict("cat > m.txt <<'EOF'\nAdd the gate (#7)\nEOF\ngit commit -F m.txt"), null)
  assert.match(String(verdict("cat > m.txt <<'EOF'\nAdd the gate\nEOF\ngit commit -F m.txt")), /does not reference #7/)
  assert.equal(verdict('$(echo git) status'), null)
})

test('a commit or PR is gated wherever a cd may leave it, and refused where that cannot be told', () => {
  assert.match(String(commandVerdict('cd /repo && git commit -m x', '/elsewhere', onSeven())), /#7/)
  assert.match(String(commandVerdict('cd /repo && gh pr create -t t -b x', '/elsewhere', onSeven())), /Closes #7/)
  assert.match(String(commandVerdict('cd /elsewhere; cd /repo; git commit -m x', '/tmp', onSeven())), /#7/)
  assert.match(String(commandVerdict('pushd /repo && popd && git commit -m x', '/elsewhere', onSeven())), /#7/)
  assert.match(String(commandVerdict('cd "$D" && gh pr create -t t -b "Closes #7"', '/repo', onSeven())), /cannot tell/)
  assert.equal(commandVerdict('cd /elsewhere && gh pr create -t t -b x', '/repo', onSeven()), null)
})

test('an alias that git or gh runs through a shell is refused, naming the issue and the fix', () => {
  const why = String(verdict('git sh', { aliases: { sh: '!git commit -m x' } }))
  assert.match(why, /cannot tell/)
  assert.match(why, /"#7"/)
  assert.match(String(verdict('gh pc', { ghAliases: { pc: '!gh pr create -b x' } })), /"Closes #7"/)
})

test('a PR is read as gh reads it: last option wins, values stay values, -R anywhere', () => {
  for (const command of [
    'gh pr new -t t -b "Refs #7"',
    'gh -R owner/name pr create -t t -b "Refs #7"',
    'gh pr create -b "Closes #7" -b "Refs #7"',
    'gh pr create -t "--body=Closes #7" -b "Refs #7"',
    'gh pr create -t t -b "<!-- Closes #7 -->"',
    "gh pr create -t t -F - <<'EOF'\n```\nCloses #7\n```\nEOF",
    "gh pr create -t t -F - <<'EOF'\nIntro\n\n    Closes #7\nEOF",
    'gh pr create -t t -b "Closes other/repo#7"',
  ]) {
    assert.match(String(verdict(command)), /does not close #7/, command)
  }
  for (const command of ['gh pr create -t t -b "Closes owner/name#7"', 'gh pr create -t t -b "Closes https://github.com/owner/name/issues/7"', 'gh -R github.com/owner/name pr create -t t -b "Closes #7"', 'gh pr create --dry-run']) {
    assert.equal(verdict(command), null, command)
  }
  for (const command of [
    'gh pr create -R other/repo -t t -b "Closes #7"',
    'gh pr create -t t -b "`Closes #7`"',
    'gh pr create -t t -b "Closes ${R}#7"',
    'gh pr create -t t -b "Closes #7$N"',
    "gh pr create -t t -F - <<'EOF' < body.md\nCloses #7\nEOF",
    'gh pr create --bogus -t t -b "Closes #7"',
    '$(echo gh) pr create -t t -b x',
  ]) {
    assert.match(String(verdict(command)), /cannot tell/, command)
  }
})

test('a long or late-defined git alias, or one the environment may set, is refused with a reason', () => {
  const chain = { a: 'b', b: 'c', c: 'd', d: 'e', e: 'f', f: 'commit' }
  assert.match(String(verdict('git a -m x', { aliases: chain })), /does not reference #7/)
  assert.match(String(verdict('git a -m x', { aliases: { a: 'b', b: 'a' } })), /cannot tell/)
  assert.match(String(verdict('git -c alias.a=b -c alias.b=c -c alias.c=d -c alias.d=e -c alias.e=f -c alias.f=commit a -m x')), /does not reference #7/)
  assert.match(String(verdict('git config alias.k commit && git k -m x')), /cannot tell/)
  for (const command of ['GIT_DIR=/repo/.git git commit -m x', 'export GIT_DIR=/repo/.git; git commit -m x', 'GIT_CONFIG_COUNT=1 git k -m x', 'HOME=/tmp/h git k -m x']) {
    assert.match(String(commandVerdict(command, '/elsewhere', onSeven())), /cannot tell/, command)
  }
  const named = String(verdict('cd "$D" && git ci -m x', { aliases: { ci: 'commit' } }))
  assert.match(named, /cannot tell/)
})

test('a file written earlier on the line in any form is not read as it was', () => {
  for (const command of ['python3 -c "open(\'m.txt\',\'w\').write(\'x\')" && git commit -F m.txt', 'dd if=/dev/null of=m.txt && git commit -F m.txt', 'cp x/M.TXT . && git commit -F m.txt', "true || cat > m.txt <<'EOF'\nx (#7)\nEOF\ngit commit -F m.txt", "cat > m.txt <<'EOF' &\nx (#7)\nEOF\ngit commit -F m.txt"]) {
    assert.match(String(verdict(command)), /cannot tell/, command)
  }
})

test('a PR is read as gh reads it: pflag values, booleans, the body file, the base repository', () => {
  for (const command of [
    'gh pr create --dry-run=false -t t -b "Refs #7"',
    "gh pr create -t t -F - -b 'Closes #7' <<'EOF'\nRefs #7\nEOF",
    "gh pr create -t t --body-file=- <<'EOF'\nIntro\n\n    Closes #7\nEOF",
    'gh pr edit --body "Refs #7"',
    'gh pr create -t t --fill=false -b "Refs #7"',
  ]) {
    assert.match(String(verdict(command)), /does not close #7/, command)
  }
  for (const command of [
    'gh pr create -t t -F=- <<< "Closes #7"',
    'gh pr create -R=owner/name -H=7-gates -t t -b "Closes #7"',
    "gh pr create -t t -F - <<'EOF'\n- Summary\n    - Closes #7\nEOF",
    "gh pr create --title t --body \"$(cat <<'EOF'\n## Summary\n\n- adds the gate (`x`)\n\nCloses #7\nEOF\n)\"",
    'gh pr create -h',
    'gh pr edit --add-label x',
    'gh pr edit --body "Closes #7"',
  ]) {
    assert.equal(verdict(command), null, command)
  }
  for (const command of [
    'gh pr create -t t -b "Closes #7$((0))"',
    'gh pr create -t t -b "Closes #7$[0]"',
    'gh pr create -t t -b Closes\\ \\#7{0..0}',
    'gh pr create -t t -b "$(true \'() Closes #7\')"',
    'gh $NOPE pr create -t t -b "Refs #7"',
    'gh pr $(echo create) -t t -b "Refs #7"',
    'gh alias set pc "pr create -b x" && gh pc',
    'gh pr create -R ghe.example.com/owner/name -t t -b "Closes #7"',
    'gh pr edit 12 --body "Closes #7"',
    'GH_REPO=other/repo gh pr create -t t -b "Closes #7"',
  ]) {
    assert.match(String(verdict(command)), /cannot tell/, command)
  }
  assert.match(String(verdict('gh pr create -t t -b "Closes #7"', { base: 'upstream/name' })), /cannot tell which issue #7 is in upstream\/name.*-R owner\/name/)
  assert.equal(verdict('gh pr create -R owner/name -t t -b "Closes #7"', { base: 'upstream/name' }), null)
  assert.match(String(verdict('gh pr mine', { ghAliases: { 'pr mine': 'pr create -b x' } })), /does not close #7/)
  assert.match(String(verdict('gh pc -b "Closes #7"', { ghAliases: { pc: 'pr create -b "$1"' } })), /cannot tell/)
  assert.throws(() => verdict('gh prc', { ghAliases: null }), /gh alias list failed/)
})

test('the shell runs what the gates read: wrappers, case, shells fed a script, fd redirects, cds', () => {
  for (const command of ['GH pr create -t t -b x', 'arch -arm64 gh pr create -t t -b x', 'exec -a x gh pr create -t t -b x', 'env -P /opt/bin gh pr create -t t -b x', 'script -q /dev/null gh pr create -t t -b x', "bash -c -- 'gh pr create -t t -b x'", "bash <<< 'gh pr create -t t -b x'", 'gh pr create -t t -b $\'Refs\\x00 Closes #7\'']) {
    assert.match(String(verdict(command)), /does not close #7/, command)
  }
  assert.match(String(verdict("gh pr create -t t -F - 3<<'EOF'\nCloses #7\nEOF")), /cannot tell/)
  for (const command of ['pushd /repo; pushd /elsewhere; pushd; gh pr create -t t -b x', 'eval cd /repo && gh pr create -t t -b x', 'cd /elsewhere /repo && gh pr create -t t -b x', 'export CDPATH=/; cd repo && gh pr create -t t -b x', 'pushd /repo; pushd /tmp; pushd +1 && gh pr create -t t -b x']) {
    assert.match(String(commandVerdict(command, '/elsewhere', onSeven())), /Closes #7|cannot tell/, command)
  }
})

test('ordinary commands that reference the linked issue, or create nothing, are allowed', () => {
  for (const command of [
    "git commit -m 'Fix $ handling (#7)'",
    'git commit -m "Price \\$5 (#7)"',
    'git commit -m "Costs $ 5 (#7)"',
    "git commit -m 'A lone ` (#7)'",
    'git commit -m "Off by $((1+1)) (#7)"',
    "git commit -m \"$(cat <<'EOF'\nFix parser (#7)\n\nTest plan:\n1) Run \"npm test\"\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"",
    'git commit -m "$(cat <<EOF\nx (#7)\nEOF\n)"',
    "gh pr create --title t --body \"$(cat <<'EOF'\n## Test plan\n1) run it\n\nCloses #7\nEOF\n)\"",
    'gh pr list --label new --state open',
    'gh pr merge 12 --squash --subject edit',
    'git config user.email && git stage -A',
    'gh alias list && gh pr view',
    'pushd -q plugins && git commit -m "Fix (#7)"',
  ]) {
    assert.equal(verdict(command), null, command)
  }
  assert.match(String(verdict('git commit -m "$(cat <<EOF\nx (#7$(date)\nEOF\n)"')), /cannot tell/)
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
  execFileSync('mkfifo', [join(dir, 'fifo')])
  assert.match(String(bash('git commit -F fifo')?.permissionDecisionReason), /cannot tell/, 'a FIFO would block the hook')
  assert.equal(bash('gh pr create -t t --body-file body.md'), null)
  assert.equal(bash('ls pr-body.md; gh pr create -t t --body-file body.md'), null, 'another file whose name ends the same')
  assert.match(String(bash('git commit --amend --no-edit')?.permissionDecisionReason), /#16/, 'HEAD says "init"')
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: dir }, { TRACE_BYPASS: '1' }), null)
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo(false).dir }), null)
})
