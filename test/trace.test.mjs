import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Unanswered } from '../plugins/trace/scripts/lib/halt.mjs'
import { CASE_INSENSITIVE_FS } from '../plugins/trace/scripts/lib/paths.mjs'
import { commandVerdict, editVerdict, stamped, worldFor } from '../plugins/trace/scripts/lib/trace.mjs'
import { noReads } from './helpers.mjs'

const HOOK = fileURLToPath(new URL('../plugins/trace/scripts/hook.mjs', import.meta.url))

/**
 * In-memory git and GitHub: a repository at /repo, traced unless `traced` is
 * false, and an untraced one nested at /repo/sub.
 *
 * @param {{ traced?: boolean, branch?: string | null, defaultBranch?: string | null, issues?: Record<number, 'OPEN' | 'CLOSED'>, unreadable?: boolean, env?: Record<string, string>, messages?: Record<string, string>, aliases?: Record<string, string>, ghAliases?: Record<string, string> | null, config?: Record<string, string>, base?: string }} [o]
 */
function world(o = {}) {
  const { traced = true, branch = 'main', defaultBranch = 'main', issues = {}, unreadable = false, env = {}, messages = {}, aliases = {}, ghAliases = {}, config = {}, base = 'owner/name' } = o
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
      configKeys: (/** @type {string} */ _root, /** @type {string[]} */ sections) => Object.keys(config).filter(k => sections.some(s => k.toLowerCase().startsWith(`${s}.`))),
      headDocs: () => ({}),
      pushed: () => null,
      committed: () => false,
      since: () => null,
    },
    github: {
      issueState: (/** @type {string} */ _root, /** @type {number} */ n) => (unreadable ? null : issues[n] ?? 'MISSING'),
      issue: () => ({ title: '', body: '', comments: [] }),
      pr: () => /** @type {const} */ ('NONE'),
      alias: (/** @type {string} */ name) => {
        if (ghAliases === null) throw new Unanswered('GitHub', 'gh alias list failed')
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
    assert.match(String(why), /Track step: open an issue \(`gh issue create` with an `## Acceptance criteria` section\)/, String(branch))
  }
})

test("an edit on an open issue's branch is allowed", () => {
  assert.equal(editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', issues: { 6: 'OPEN' } })), null)
})

test("an edit on a closed or missing issue's branch is refused, naming the Track step", () => {
  for (const issues of /** @type {Record<number, 'OPEN' | 'CLOSED'>[]} */ ([{ 6: 'CLOSED' }, {}])) {
    const why = editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', issues }))
    assert.match(String(why), /#6/)
    assert.match(String(why), /Track step: open an issue for this change \(`gh issue create` with an `## Acceptance criteria` section\)/)
  }
})

test('when GitHub answers in a way the trace cannot read, the edit is refused, naming the step and the bypass', () => {
  const why = editVerdict('/repo/src/a.js', world({ branch: '6-trace-edit-gate', unreadable: true }))
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

test('the deadline on git and GitHub starts with each call, not when the module loads', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { dir, git } = repo()
  t.mock.timers.tick(25_000)
  assert.match(String(editVerdict(join(dir, 'a.md'))), /default branch/, 'a call long after the module loaded still asks git')
  const reads = noReads()
  const first = worldFor(reads)
  assert.equal(first.git.message(dir, 'HEAD'), 'init\n')
  assert.equal(first.git.origin(dir), 'owner/name')
  t.mock.timers.tick(15_000)
  const second = worldFor(reads)
  t.mock.timers.tick(15_000)
  assert.throws(() => first.git.message(dir, 'HEAD'), OUT_OF_TIME, 'a later call does not extend an earlier one')
  assert.throws(() => first.github.issueState(dir, 1), OUT_OF_TIME, 'GitHub is bounded too')
  assert.equal(second.git.message(dir, 'HEAD'), 'init\n')
  git('remote', 'set-url', 'origin', 'https://github.com/owner/other.git')
  assert.equal(second.git.origin(dir), 'owner/other', 'nor does it reuse an earlier call\'s answers')
})

test('with the marker only in HEAD and the deadline run out, the hook halts the session at an edit on the default branch', () => {
  const { dir } = repo()
  rmSync(join(dir, '.claude/trace.json'))
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }
  assert.match(String(hook(edit)?.permissionDecisionReason), /default branch/, 'while git answers, HEAD has the marker')
  // A clock 25s later each time it is read: the deadline has run out before git is first asked.
  const clock = join(mkdtempSync(join(tmpdir(), 'clock-')), 'clock.mjs')
  writeFileSync(clock, 'let t = Date.now()\nDate.now = () => (t += 25_000)\n')
  const out = hook(edit, { NODE_OPTIONS: `--import=${clock}` })
  assert.equal(out?.permissionDecision, 'deny')
  assert.equal(hook.out.continue, false)
  assert.match(hook.out.stopReason, /^trace halted the session: git and GitHub did not answer: the hook call ran out of time asking them\. Restore git and the connection to GitHub \(`git status`, `gh auth status`, the network\), then reply to continue\.$/)
})

test('the marker in the working tree counts without asking git', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const late = worldFor(noReads())
  t.mock.timers.tick(25_000)
  assert.equal(late.git.traced(repo().dir), true)
  assert.throws(() => late.git.traced(repo(false).dir), OUT_OF_TIME)
})

test('a git that times out, is killed, or fails before it can answer halts the session; git saying no does not', () => {
  const { dir } = repo()
  rmSync(join(dir, '.claude/trace.json'))
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }
  for (const [asked, why] of /** @type {[string, RegExp][]} */ ([
    ['exec sleep 10', /git did not answer: it timed out\./],
    ['kill -9 $$', /git did not answer: it was killed by SIGKILL\./],
    ["echo \"fatal: detected dubious ownership in repository at '$PWD'\" >&2; exit 128", /git did not answer: fatal: detected dubious ownership/],
    ["echo \"fatal: Unable to create '$PWD/.git/index.lock': File exists.\" >&2; exit 128", /git did not answer: fatal: Unable to create/],
    ['echo "error: inflate: data stream error (incorrect header check)" >&2; exit 128', /git did not answer: error: inflate/],
    // Failures the trace has no words for are failures too: only git's known answers are answers.
    ['echo "fatal: bad object HEAD" >&2; exit 128', /git did not answer: fatal: bad object HEAD\./],
    ['echo "fatal: something new went wrong" >&2; exit 128', /git did not answer: fatal: something new went wrong\./],
    ['exit 3', /git did not answer: exit 3\./],
  ])) {
    const out = hook(edit, { PATH: `${fakeGit(`*" ls-tree "*) ${asked};;`)}:${process.env.PATH}` })
    assert.equal(out?.permissionDecision, 'deny', asked)
    assert.equal(hook.out.continue, false, asked)
    assert.match(hook.out.stopReason, why)
  }
  // git's own "no": the marker is in no revision, or there is no such revision, so the repository is untraced.
  assert.equal(hook(edit, { PATH: `${fakeGit('*" ls-tree "*) exit 0;;')}:${process.env.PATH}` }), null)
  const untraced = hook(edit, { PATH: `${fakeGit(`*" ls-tree "*) echo "fatal: Not a valid object name HEAD" >&2; exit 128;;`)}:${process.env.PATH}` })
  assert.equal(untraced, null)
  // git is asked in its own words, whatever the human's locale: a German git would say no in German.
  const german = fakeGit(`*" ls-tree "*) if [ "$LC_ALL" = C ]; then echo "fatal: Not a valid object name HEAD" >&2; else echo "fatal: Kein gültiger Objektname HEAD" >&2; fi; exit 128;;`)
  assert.equal(hook(edit, { PATH: `${german}:${process.env.PATH}`, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' }), null)
})

test("git's no about a name the branch or the agent chose is an answer, whatever words the name holds", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '16-fix-corrupt-index')
  const world = worldFor(noReads())
  assert.equal(world.git.pushed(dir, '16-fix-corrupt-index'), null, 'no upstream configured')
  assert.equal(world.git.config(dir, 'alias.corrupt_x'), null, 'an invalid key')
  assert.equal(world.git.message(dir, 'fix-corrupt-index'), null, 'no such revision')
})

test("the settings and a stored message the commit gate reads are git's own, byte for byte", () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'extra.inc'), '[trailer "verified"]\n\tkey = Other\n')
  git('config', 'trailer.separators', '=')
  git('config', 'include.path', join(dir, 'extra.inc'))
  git('config', 'includeIf.onbranch:main.path', join(dir, 'none.inc'))
  git('commit', '-q', '--allow-empty', '--cleanup=verbatim', '-m', 'x (#7)\n\nVerified: none\n\n\v')
  git('config', 'x.value', ' a\v')
  const world = worldFor(noReads())
  // git follows the include, and reports the key it sets.
  assert.deepEqual(world.git.configKeys(dir, ['includeif', 'trailer']).sort(), ['includeif.onbranch:main.path', 'trailer.separators', 'trailer.verified.key'])
  assert.deepEqual(world.git.configKeys(dir, ['nosuchsection']), [])
  assert.equal(world.git.config(dir, 'x.value'), ' a\v')
  // git ends a message from -m with a newline, and keeps the \v before it.
  assert.equal(world.git.message(dir, 'HEAD'), 'x (#7)\n\nVerified: none\n\n\v\n')
})

test('a HEAD that names no object halts the session, rather than reading as a HEAD without the marker', () => {
  const { dir, git } = repo(false)
  git('checkout', '-qb', '16-x')
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/trace.json'), '{}\n')
  git('add', '-A')
  git('commit', '-qm', 'marker')
  rmSync(join(dir, '.claude/trace.json'))
  writeFileSync(join(dir, '.git/refs/heads/16-x'), `${'1'.repeat(40)}\n`)
  assert.throws(() => worldFor(noReads()).git.traced(dir), (/** @type {Error} */ err) => err instanceof Unanswered && /^git did not answer: /.test(err.message))
  // A branch with no commits yet is git's no: it has no marker.
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'trace-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty })
  assert.equal(worldFor(noReads()).git.traced(empty), false)
})

test("a commit's message is read with a git older than --end-of-options, and a revision that looks like an option is no commit", () => {
  const { dir } = repo()
  // git before 2.24 does not know --end-of-options.
  const old = fakeGit(`*" --end-of-options "*) echo "fatal: unrecognized argument: --end-of-options" >&2; exit 128;;`)
  const path = process.env.PATH
  process.env.PATH = `${old}:${path}`
  try {
    const world = worldFor(noReads())
    assert.equal(world.git.message(dir, 'HEAD'), 'init\n')
    assert.equal(world.git.message(dir, '--output=zz'), null)
    assert.equal(existsSync(join(dir, 'zz')), false)
  } finally {
    process.env.PATH = path
  }
})

test('a git alias run from under a directory the agent cannot search is looked up in the nearest one it can', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'no-repo-')))
  mkdirSync(join(outside, 'np/sub'), { recursive: true })
  chmodSync(join(outside, 'np'), 0o000)
  try {
    assert.equal(commandVerdict('git -C np/sub/new co main', outside, world()), null)
  } finally {
    chmodSync(join(outside, 'np'), 0o700)
  }
})

test('a gh that is missing, not logged in or cannot reach GitHub halts the session; "no such issue" and "no PR" are answers', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '6-x')
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir }
  const remedy = 'Restore the connection to GitHub (`gh auth status`, the network), then reply to continue.'
  for (const [stderr, exit] of [
    ['To get started with GitHub CLI, please run:  gh auth login', '4'],
    ['HTTP 401: Bad credentials (https://api.github.com/repos/owner/name/issues/6)', '1'],
    ['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', '1'],
    ['HTTP 502: Bad Gateway (https://api.github.com/repos/owner/name/issues/6)', '1'],
    // Failures the trace has no words for are failures too: only "not found" is an answer.
    ['HTTP 403: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.', '1'],
    ['Get "https://api.github.com/repos/owner/name/issues/6": tls: failed to verify certificate: x509: certificate signed by unknown authority', '1'],
    ['unexpected EOF', '1'],
  ]) {
    assert.equal(hook(edit, { FAKE_GH_FAIL: stderr, FAKE_GH_EXIT: exit })?.permissionDecision, 'deny', stderr)
    assert.equal(hook.out.continue, false, stderr)
    assert.equal(hook.out.stopReason, `trace halted the session: GitHub did not answer: ${stderr.split('\n')[0]}. ${remedy}`)
  }
  // git and node, but no gh.
  const bin = mkdtempSync(join(tmpdir(), 'nogh-'))
  symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
  hook(edit, { PATH: bin })
  assert.equal(hook.out?.stopReason, `trace halted the session: GitHub did not answer: gh is not on PATH. ${remedy}`)

  assert.match(String(hook(edit)?.permissionDecisionReason), /^trace: #6 is not an open issue/, '404: no such issue')
  assert.equal(hook.out.continue, undefined)
  const issues = { 'owner/name#6': { state: 'open', title: 'X', body: '', comments: 0 } }
  const status = hook({ cwd: dir, session_id: `s-${process.pid}` }, {}, issues, 'status')
  assert.deepEqual([status?.halt, status?.issue?.n, status?.pr], [undefined, 6, null], 'no pull requests found: no PR')
})

test('a failure that is not git or GitHub going unanswered is refused as before, and halts nothing', () => {
  const { dir } = repo()
  // Bad input: a MultiEdit whose edits are not a list.
  const out = hook({ tool_name: 'MultiEdit', tool_input: { file_path: join(dir, '.claude/settings.json'), edits: 5 }, cwd: dir, session_id: `s-${process.pid}-${Math.random().toString(36).slice(2)}` })
  assert.match(String(out?.permissionDecisionReason), /^trace: the trace could not be checked \(.+\)\. To work untraced, the human can launch Claude Code with TRACE_BYPASS=1\.$/)
  assert.deepEqual([hook.out.continue, hook.status], [undefined, 0])
})

// How the deadline running out reads.
const OUT_OF_TIME = /^Error: git and GitHub did not answer: the hook call ran out of time asking them$/

/** @param {string} cases `case` branches for the git commands to fake @returns {string} a directory with a git that runs them, else the real git */
function fakeGit(cases) {
  const bin = mkdtempSync(join(tmpdir(), 'git-'))
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${cases} esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  return bin
}

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
 * JSON line each, and logs every call to `log`. With FAKE_GH_FAIL set, all
 * but `gh alias list` fail with it, exiting FAKE_GH_EXIT; with
 * FAKE_GH_ALIAS_FAIL, `gh alias list` does.
 */
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')
if (args[0] === 'alias' && args[1] === 'list') { process.stderr.write(process.env.FAKE_GH_ALIAS_FAIL ?? ''); process.exit(process.env.FAKE_GH_ALIAS_FAIL ? 1 : 0) }
if (process.env.FAKE_GH_FAIL) { process.stderr.write(process.env.FAKE_GH_FAIL + '\\n'); process.exit(Number(process.env.FAKE_GH_EXIT ?? 1)) }
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
  hook.status = r.status
  hook.out = r.stdout ? JSON.parse(r.stdout) : null
  return hook.out?.hookSpecificOutput ?? hook.out
}
hook.calls = ''
/** @type {number | null} the last call's exit code */
hook.status = null
/** @type {any} the last call's whole output */
hook.out = null

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
  git('commit', '-q', '--allow-empty', '-m', 'Split the band out to #10')
  git('checkout', '-qb', '10-trace-band')
  const issues = { 'owner/name#10': { state: 'open', title: 'Trace band', body: 'Show it.', comments: 0 } }
  const status = (/** @type {Record<string, unknown>} */ prs = {}) => hook({ cwd: dir, session_id: `s-${process.pid}` }, { FAKE_GH_PRS: JSON.stringify(prs) }, issues, 'status')
  const before = status()
  assert.deepEqual([before?.step, before?.docs, before?.issue], ['read', 'unread', { n: 10, title: 'Trace band', url: 'https://github.com/owner/name/issues/10' }])
  assert.ok(!before?.done.includes('implement'), "the default branch's commits are not the branch's")
  git('commit', '-q', '--allow-empty', '-m', 'the band (#100), other/repo#10')
  assert.ok(!status()?.done.includes('implement'), 'as the commit gate reads them, #100 and other/repo#10 are not #10')
  git('commit', '-q', '--allow-empty', '-m', 'the band (#10)')
  assert.ok(status()?.done.includes('implement'))
  const rollup = [
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-28T10:05:00Z' },
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-28T10:00:00Z' },
    { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-10-28T10:00:00Z' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' },
  ]
  const after = status({ '10-trace-band': { number: 21, url: 'https://github.com/owner/name/pull/21', state: 'OPEN', statusCheckRollup: rollup } })
  assert.deepEqual(after?.pr, {
    n: 21,
    url: 'https://github.com/owner/name/pull/21',
    state: 'OPEN',
    ci: 'failing',
    checks: [
      { name: 'test', state: 'SUCCESS', outcome: 'passing' },
      { name: 'lint', state: 'PENDING', outcome: 'pending' },
      { name: 'ci/legacy', state: 'FAILURE', outcome: 'failing' },
    ],
  }, 'a re-run that passed replaces the run that failed')
  assert.ok(!after?.done.includes('review'), 'an open PR alone is not a review')
  assert.equal(hook({ cwd: repo(false).dir, session_id: 's' }, {}, issues, 'status'), null, 'untraced: nothing')
  assert.match(String(hook({ cwd: dir, session_id: 's' }, { PATH: '/nonexistent' }, issues, 'status')?.halt), /^trace: git did not answer/, 'without git, the status says so')
  // A cwd that is not a path makes the status throw.
  const failed = spawnSync(process.execPath, [HOOK, 'status'], { input: JSON.stringify({ cwd: 5, session_id: 's' }), encoding: 'utf8' })
  assert.deepEqual([failed.status, failed.stdout], [1, ''], 'a status that fails otherwise is a failure, not "untraced"')
})

test("the status event completes Review only while the branch's head is the commit the issue's review record names", () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '10-trace-band')
  git('commit', '-q', '--allow-empty', '-m', 'the band (#10)')
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const prs = { '10-trace-band': { number: 21, url: 'https://github.com/owner/name/pull/21', state: 'OPEN', statusCheckRollup: [] } }
  const status = (/** @type {string} */ recorded) => {
    const thread = [{ id: '1', author: 'claude', body: `## Progress\n\nRound 1.\n\nReviewed: ${recorded}`, at: '2026-10-28T10:00:00Z' }]
    return hook({ cwd: dir, session_id: `s-${process.pid}` }, { FAKE_GH_PRS: JSON.stringify(prs) }, { 'owner/name#10': { state: 'open', title: 'Trace band', body: 'Show it.', comments: 1, thread } }, 'status')
  }
  const reviewed = head()
  const done = status(reviewed)
  assert.deepEqual(done?.review, { sha: reviewed, unreviewed: 0 })
  assert.ok(done?.done.includes('review'))
  assert.equal(status(reviewed.slice(0, 9))?.review?.unreviewed, 0, 'an abbreviated commit is the same commit')

  git('commit', '-q', '--allow-empty', '-m', 'a fix (#10)')
  git('commit', '-q', '--allow-empty', '-m', 'another (#10)')
  const moved = status(reviewed)
  assert.deepEqual(moved?.review, { sha: reviewed, unreviewed: 2 })
  assert.ok(!moved?.done.includes('review'), 'two commits since the review')

  // What a comment names may be no commit of this branch: git's no is an answer, never a halt.
  const rev = (/** @type {string} */ name) => execFileSync('git', ['rev-parse', name], { cwd: dir, encoding: 'utf8' }).trim()
  git('commit', '-q', '--amend', '--allow-empty', '-m', 'another, reworded (#10)')
  git('branch', 'amended-away', 'HEAD@{1}')
  for (const [recorded, unreviewed, what] of /** @type {[string, number | null, string][]} */ ([
    [rev('main'), 3, 'counted from an ancestor'],
    [rev('amended-away'), null, 'a commit the head does not descend from'],
    ['1'.repeat(40), null, 'a hash of no object'],
    ['abcdef0', null, 'an abbreviation of none'],
    [rev('HEAD^{tree}'), null, 'a tree'],
  ])) {
    const s = status(recorded)
    assert.deepEqual([s?.halt, s?.review], [undefined, { sha: recorded, unreviewed }], what)
  }
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

test('a git that cannot run halts the session at an edit, commit or PR in any repository, without offering the bypass', () => {
  const noGit = { PATH: '/nonexistent' }
  for (const dir of [repo(false).dir, repo().dir]) {
    for (const [tool, input] of /** @type {[string, Record<string, string>][]} */ ([
      ['Edit', { file_path: join(dir, 'a.md') }],
      ['Bash', { command: 'git commit -m "x #6"' }],
      ['Bash', { command: 'git merge topic' }],
      ['Bash', { command: 'gh pr create -t t -b "Closes #6"' }],
    ])) {
      const out = hook({ tool_name: tool, tool_input: input, cwd: dir }, noGit)
      const what = `${tool} ${JSON.stringify(input)}`
      assert.equal(out?.permissionDecision, 'deny', what)
      assert.equal(hook.out.continue, false, what)
      assert.equal(hook.out.stopReason, out.permissionDecisionReason, what)
      assert.match(hook.out.stopReason, /^trace halted the session: (?:git|GitHub) did not answer: (?:git|gh) is not on PATH\. Restore .*, then reply to continue\.$/, what)
      assert.doesNotMatch(hook.out.stopReason, /TRACE_BYPASS/, what)
      assert.equal(hook.status, 2, 'exit 2 makes sure the tool call is blocked')
    }
  }
})

test('every hook that gets no answer from git halts the session; the band\'s status shows it and halts nothing', () => {
  const { dir } = repo(false)
  const noGit = { PATH: '/nonexistent' }
  const inputs = {
    'session-start': { hook_event_name: 'SessionStart', source: 'startup' },
    'subagent-start': { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' },
    stop: { hook_event_name: 'Stop', stop_hook_active: false },
  }
  for (const [event, input] of Object.entries(inputs)) {
    const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
    hook({ ...input, cwd: dir, session_id: session }, noGit, {}, event)
    assert.deepEqual([hook.out?.continue, hook.status], [false, 0], event)
    assert.match(hook.out.stopReason, /^trace halted the session: git did not answer: git is not on PATH\./, event)
    assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: session })?.permissionDecision, 'deny', `${event} records the halt`)
    assert.equal(hook({ ...input, cwd: dir, session_id: `${session}-bypassed` }, { ...noGit, TRACE_BYPASS: '1' }, {}, event), null, `${event}: the bypass turns the trace off, and its questions to git with it`)
  }
  const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
  const status = hook({ cwd: dir, session_id: session }, noGit, {}, 'status')
  assert.match(String(status?.halt), /^trace: git did not answer: git is not on PATH\. Restore git .*: until then, each hook that asks halts the session\.$/)
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: session }), null)
})

test("a halt stands for the whole session, the parent's calls included, until a prompt that is not a background agent's report, or the session is started, resumed or cleared", () => {
  const { dir } = repo()
  const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
  const read = (/** @type {object} */ as = {}) => hook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: session, ...as })
  const edit = { tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: session }
  assert.equal(read(), null)
  hook({ ...edit, agent_id: 'sub-1', agent_type: 'general-purpose' }, { PATH: '/nonexistent' })
  const reason = hook.out?.stopReason
  assert.match(String(reason), /^trace halted the session: git did not answer/, 'a subagent halts')
  const out = read()
  assert.deepEqual([out?.permissionDecision, out?.permissionDecisionReason, hook.out.continue, hook.out.stopReason, hook.status], ['deny', reason, false, reason, 2], "the parent's next call halts at once, though it asks no git")
  assert.equal(read({ agent_id: 'sub-2' })?.permissionDecision, 'deny', 'and every other agent of the session')
  for (const event of ['post-tool-use', 'session-start', 'subagent-start', 'stop']) {
    hook({ tool_name: 'Read', tool_input: {}, tool_response: {}, cwd: dir, session_id: session }, {}, {}, event)
    assert.deepEqual(hook.out, { continue: false, stopReason: reason }, event)
  }
  assert.equal(read({ session_id: `${session}-other` }), null, 'another session goes on')
  for (const tool of ['Agent', 'Task', 'WebFetch', 'TodoWrite', 'Skill', 'mcp__docs__update']) {
    assert.equal(hook({ tool_name: tool, tool_input: {}, cwd: dir, session_id: session })?.permissionDecision, 'deny', `${tool}, a tool the gates do not judge`)
  }
  // A background agent's report arrives as a prompt the human did not send: it lifts nothing.
  const notification = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>'
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: notification, cwd: dir, session_id: session }, {}, {}, 'user-prompt-submit'), null)
  assert.equal(read()?.permissionDecision, 'deny', "a task's notification is not the human's prompt")
  assert.equal(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'git is back', cwd: dir, session_id: session }, {}, {}, 'user-prompt-submit'), null)
  assert.equal(read(), null, "the human's prompt clears the halt")
  assert.match(String(hook(edit)?.permissionDecisionReason), /default branch/, 'and git answers again')
  hook(edit, { PATH: '/nonexistent' })
  assert.equal(hook.out?.continue, false, 'while git still cannot answer, the next call that asks halts again')
  // A session left halted is not halted when the human resumes it, or starts afresh.
  for (const source of ['resume', 'startup', 'clear']) {
    hook(edit, { PATH: '/nonexistent' })
    hook({ hook_event_name: 'SessionStart', source, cwd: dir, session_id: session }, {}, {}, 'session-start')
    assert.equal(hook.out?.continue, undefined, source)
    assert.equal(read(), null, source)
  }
  hook(edit, { PATH: '/nonexistent' })
  hook({ hook_event_name: 'SessionStart', source: 'compact', cwd: dir, session_id: session }, {}, {}, 'session-start')
  assert.equal(hook.out?.continue, false, 'a compaction is not the human')
})

test('every tool call reaches the PreToolUse hook, which judges only the tools the gates and the archive block know', () => {
  const { hooks } = JSON.parse(readFileSync(fileURLToPath(new URL('../plugins/trace/hooks/hooks.json', import.meta.url)), 'utf8'))
  /** @param {string} tool */
  const reaches = tool =>
    hooks.PreToolUse.some((/** @type {{ matcher?: string }} */ e) => !e.matcher || e.matcher === '*' || new RegExp(`^(?:${e.matcher})$`).test(tool))
  for (const tool of ['Bash', 'Read', 'Edit', 'Agent', 'Task', 'WebFetch', 'TodoWrite', 'Skill', 'mcp__docs__update']) assert.ok(reaches(tool), tool)
  const { dir } = repo()
  mkdirSync(join(dir, 'archive'))
  for (const tool of ['WebFetch', 'mcp__files__write']) {
    assert.equal(hook({ tool_name: tool, tool_input: { file_path: join(dir, 'archive/x.md'), command: 'git commit -m x' }, cwd: dir, session_id: `s-${process.pid}` }), null, tool)
  }
})

test('recording what an agent read never halts: a read git cannot place is not recorded, and the gate asks again', () => {
  const noGit = { PATH: '/nonexistent' }
  for (const dir of [repo(false).dir, repo().dir]) {
    const session = `s-${process.pid}-${Math.random().toString(36).slice(2)}`
    const after = (/** @type {object} */ input) => {
      hook({ ...input, cwd: dir, session_id: session }, noGit, {}, 'post-tool-use')
      return [hook.out, hook.status]
    }
    const file = { filePath: join(dir, 'a.md'), content: 'x\n', numLines: 2, startLine: 1, totalLines: 2 }
    assert.deepEqual(after({ tool_name: 'Read', tool_input: { file_path: file.filePath }, tool_response: { type: 'text', file } }), [null, 0], `a Read in ${dir}`)
    const saved = join(realpathSync(mkdtempSync(join(tmpdir(), 'saved-'))), 'out.txt')
    writeFileSync(saved, 'x\n')
    assert.deepEqual(after({ tool_name: 'Read', tool_input: { file_path: saved }, tool_response: { type: 'text', file: { ...file, filePath: saved } } }), [null, 0], `a saved output read from ${dir}`)
    for (const command of ['gh issue view 6 --comments', 'git show HEAD:a.md']) {
      assert.deepEqual(after({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'x\n', stderr: '' } }), [null, 0], `${command} in ${dir}`)
    }
    assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: file.filePath }, cwd: dir, session_id: session }), null, 'and nothing halts the next call')
  }
})

test("gh's aliases are asked for only where a PR could be opened in a traced repository", () => {
  // git and node, but no gh.
  const bin = mkdtempSync(join(tmpdir(), 'nogh-'))
  symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'norepo-')))
  // No gh, or a gh that fails in words the trace does not know.
  for (const [env, why] of /** @type {[Record<string, string>, string][]} */ ([
    [{ PATH: bin }, 'gh is not on PATH'],
    [{ FAKE_GH_ALIAS_FAIL: 'failed to read configuration: invalid config.yml' }, 'failed to read configuration: invalid config.yml'],
  ])) {
    for (const dir of [outside, repo(false).dir]) {
      for (const command of ['gh repo view cli/cli', 'gh issue list', 'gh prc', 'gh pr create -t t -b x']) {
        assert.equal(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, env), null, `${command} in ${dir}`)
      }
    }
    hook({ tool_name: 'Bash', tool_input: { command: 'gh repo view cli/cli' }, cwd: repo().dir }, env)
    assert.equal(hook.out?.stopReason, `trace halted the session: GitHub did not answer: ${why}. Restore the connection to GitHub (\`gh auth status\`, the network), then reply to continue.`, 'in a traced repository, an alias it cannot list may open a PR')
  }
})

test("git saying no to what the agent's command names is an answer: an alias name, a reflog entry, a directory not made yet", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'norepo-')))
  for (const command of [
    'git status.',
    'git x/y',
    'git clone https://github.com/cli/cli && cd cli && git lfs pull',
    'mkdir proj && cd proj && git init && git flow init -d',
    'git -C not-yet co main',
  ]) {
    for (const dir of [outside, repo().dir]) {
      assert.equal(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }), null, `${command} in ${dir}`)
      assert.equal(hook.out?.continue, undefined, `${command} in ${dir}`)
    }
  }
  const { dir, git } = repo()
  git('checkout', '-qb', '16-gates')
  const issues = { 'owner/name#16': { state: 'open' } }
  for (const command of ['git commit --fixup=HEAD@{9}', 'git commit -C main@{9}', 'git commit --squash=HEAD@{9} -m "x (#16)"']) {
    const out = hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, {}, issues)
    assert.match(String(out?.permissionDecisionReason), /^trace: the trace cannot tell/, command)
    assert.equal(hook.out.continue, undefined, command)
  }
})

test('the commit gate reads the revision the agent names as a revision, never as an option to git', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '16-gates')
  const issues = { 'owner/name#16': { state: 'open' } }
  for (const command of ['git commit --fixup=--output=fixup.txt -m "x (#16)"', 'git commit -C --output=reuse.txt']) {
    const out = hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, {}, issues)
    assert.match(String(out?.permissionDecisionReason), /^trace: the trace cannot tell/, command)
  }
  assert.deepEqual(['fixup.txt', 'reuse.txt'].filter(f => existsSync(join(dir, f))), [], 'the hook wrote no file')
})

test('a halt the hook cannot record still halts the call', () => {
  const { dir } = repo()
  const tmp = mkdtempSync(join(tmpdir(), 'ro-'))
  chmodSync(tmp, 0o500)
  try {
    const out = hook({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.md') }, cwd: dir, session_id: `s-${process.pid}-ro` }, { PATH: '/nonexistent', TMPDIR: tmp })
    assert.deepEqual([out?.permissionDecision, hook.out?.continue, hook.status], ['deny', false, 2])
    assert.match(hook.out.stopReason, /^trace halted the session: git did not answer: git is not on PATH\./)
  } finally {
    chmodSync(tmp, 0o700)
  }
})

test('a git that cannot run lets through git and gh commands the gates do not judge', () => {
  // gh, and the node it runs on, but no git.
  const bin = mkdtempSync(join(tmpdir(), 'nogit-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const dir of [repo(false).dir, repo().dir]) {
    for (const command of ['git status', 'git log --oneline', 'git rebase --abort', 'gh issue view 6 --comments', 'gh pr view']) {
      assert.equal(hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, { PATH: bin }), null, `${command} in ${dir}`)
    }
  }
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
// A verdict that is about the stamp alone, once the reference is read.
const STAMP_ONLY = /^(?:this commit message carries no verification stamp|the trace cannot tell the verification stamp)/
/** @param {string} command @param {Parameters<typeof world>[0]} [o] whether the gate reads the reference to #7 and judges only the stamp, if that */
const referenced = (command, o) => {
  const why = verdict(command, o)
  return why === null || STAMP_ONLY.test(why)
}

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
    assert.ok(referenced(command), command)
  }
  assert.equal(verdict('git commit -m "Add the gate (#7)" -m "Verified: none"'), null)
})

test('a commit whose message does not reference the linked issue is refused, naming the issue and the text to add', () => {
  for (const command of ['git commit -m "Add the gate"', 'git commit -m a -m b', 'git commit -m "Add the gate #70"', 'git commit -m "see #77"', "git commit -F - <<'EOF'\nAdd the gate\nEOF", 'bash -c \'git commit -m "x"\'', 'true && git commit -m x']) {
    const why = String(verdict(command))
    assert.match(why, /#7\b/, command)
    assert.match(why, /Implement step/, command)
  }
})

test('a commit whose message carries no verification stamp is refused, naming the Implement step and the text to add', () => {
  for (const command of [
    'git commit -m "Add the gate (#7)"',
    'git commit -m "Add the gate (#7) Verified: none"',
    'git commit -m "Add the gate (#7)" -m "Verified:"',
    'git commit -m "Add the gate (#7)" -m "Verified: npm test\nand then some prose"',
    'git commit -m "Add the gate (#7)" -m "Verified: npm test" -m "A later paragraph."',
    'git commit -m "Add the gate (#7)" -m "Verification: npm test"',
  ]) {
    const why = String(verdict(command))
    assert.match(why, /no verification stamp/, command)
    assert.match(why, /Implement step: end the commit message with a last paragraph "Verified: <how it was verified>", or "Verified: none"/, command)
  }
})

test('a verification stamp says how a commit was verified, "none" included, as a git trailer', () => {
  for (const command of [
    'git commit -m "Add the gate (#7)" -m "Verified: none"',
    'git commit -m "Add the gate (#7)" -m "Verified: npm test, 412 passing"',
    "git commit -m \"$(cat <<'EOF'\nAdd the gate (#7)\n\nverified : npm test\n  and the hook by hand\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"",
    "git commit -m 'Add the gate (#7)' --trailer 'Verified: npm test'",
    'git commit -m "Add the gate (#7)" -m "Refs: #7" --trailer "Verified: none"',
  ]) {
    assert.equal(verdict(command), null, command)
  }
  assert.equal(verdict('git commit --amend --no-edit', { messages: { HEAD: 'Add the gate (#7)\n\nVerified: none' } }), null)
  // The shell may make a computed stamp empty, or end the message after it.
  for (const command of ['git commit -m "Add the gate (#7)" -m "Verified: $HOW"', 'git commit -m "Add the gate (#7)" -m "Verified: npm test $(date)"']) {
    assert.match(String(verdict(command)), /cannot tell the verification stamp/, command)
  }
})

test('the commit gate reads a verification stamp only in forms where it reads what git reads, and the trace check reads as git does', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stamp-')))
  const isolated = { GIT_CONFIG_GLOBAL: join(dir, '.git', 'global'), GIT_CONFIG_NOSYSTEM: '1' }
  // Where `cd -` goes: no repository, so a commit there fails.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  const env = { ...process.env, ...isolated, OLDPWD: elsewhere, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_EDITOR: 'false' }
  const git = (/** @type {string[]} */ args, input = '') => execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8' })
  git(['init', '-q', '-b', '7-stamp'])
  mkdirSync(join(dir, '.claude'))
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, '.claude/trace.json'), '{}\n')
  // The gate asks the real git, which reads the same settings as the commands run below; only GitHub is stubbed.
  const saved = Object.fromEntries(Object.keys(isolated).map(k => [k, process.env[k]]))
  Object.assign(process.env, isolated)
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  })
  const github = { issueState: () => /** @type {const} */ ('OPEN'), issue: () => ({ title: '', body: '', comments: [] }), pr: () => /** @type {const} */ ('NONE'), alias: () => null }
  const gate = (/** @type {string} */ command) => commandVerdict(command, dir, { ...worldFor({ records: () => [], add() {}, clear() {} }), github })
  // What git, and the trace check on GitHub, read in the commit just made.
  // git trims a trailer's value of its own whitespace only, so a value of \v or a no-break space is one.
  const read = () => ({ git: git(['log', '-1', '--format=%(trailers:key=Verified,valueonly,unfold,separator=%x2C)']).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') !== '', check: stamped(git(['cat-file', 'commit', 'HEAD']).replace(/^[\s\S]*?\n\n/, '')) })
  // The settings a command on the line wrote, undone before the next: only the scratch repository's own.
  const reset = () => {
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n')
    rmSync(join(dir, '.git', 'global'), { force: true })
  }
  const sob = 'Signed-off-by: A <a@b>'
  const scissors = '# ------------------------ >8 ------------------------'
  const file = join(dir, 'msg.txt')
  const other = join(dir, 'other.txt')
  writeFileSync(other, 'Verified: none\n')
  const template = join(dir, 'template.txt')
  writeFileSync(template, 'x (#7)\n\nprose\n')
  // Files a pattern the shell expands matches: a stamp with no value, once expanded.
  for (const name of ['Verified:', 'Verified: ', 'xy']) writeFileSync(join(dir, name), '')
  // Words xargs reads, and a link to msg.txt.
  writeFileSync(join(dir, 'args.txt'), 'prose\n')
  symlinkSync('msg.txt', join(dir, 'link.txt'))
  // Message files: one in a subdirectory, one through a linked directory, one named `-`, one outside the repository.
  writeFileSync(join(dir, 'sub', 'msg.txt'), 'x (#7)\n\nVerified: none\n')
  symlinkSync('sub', join(dir, 'sublink'))
  writeFileSync(join(dir, '-'), 'x (#7)\n\nVerified: none\n')
  const outside = join(elsewhere, 'msg.txt')
  writeFileSync(outside, 'x (#7)\n\nVerified: none\n')
  /**
   * Runs `command` through bash with `config` set in the repository and
   * `text` in msg.txt, and returns the gate's verdict and what git and the
   * trace check read.
   *
   * @param {string} command @param {Record<string, string>} [config] @param {string} [text]
   */
  const run = (command, config = {}, text = 'x (#7)\n\nVerified: none\n') => {
    writeFileSync(file, text)
    for (const [key, value] of Object.entries(config)) git(['config', key, value])
    const why = gate(command)
    // A command that fails records nothing, and HEAD's stamp is not its own.
    const seen = spawnSync('bash', ['-c', command], { cwd: dir, env }).status === 0 ? read() : { git: false, check: false }
    reset()
    return { why, ...seen }
  }
  git(['commit', '-q', '--allow-empty', '-m', 'init (#7)', '-m', 'Verified: none'])

  // The forms of the grammar: each is allowed, and git and the trace check read the stamp too.
  const claude = "Fix `stamped()` in $HOME, don't (#7)\n\nWhy, with `code`, \"quotes\", (parens and $VAR.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nVerified: npm test\nCo-Authored-By: Claude <noreply@anthropic.com>"
  for (const command of [
    'git commit -q --allow-empty -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -m "x (#7)" -m "Why." -m "Verified: npm test, 412 passing"',
    "git commit -q --allow-empty -m 'x (#7)\n\nVerified: none'",
    `git commit -q --allow-empty -m "$(cat <<'EOF'\n${claude}\nEOF\n)"`,
    `git commit -q --allow-empty -m "$(cat <<'EOF'\n${claude}\n\n\nEOF\n)"`,
    // A line that holds the delimiter after a space does not end the heredoc.
    `git commit -q --allow-empty -m "$(cat <<'EOF'\nx (#7)\n EOF\n EOF)\nEOF\n)" -m "$(cat <<'EOF'\nVerified: none\nEOF\n)"`,
    `git commit -q --allow-empty -F ${file}`,
    "git commit -q --allow-empty -F 'msg.txt'",
    'git commit -q --allow-empty -s -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty --signoff --all --quiet -v --verbose -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -a -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -am "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -sm "x (#7)" -asm "Why." -sam "Verified: none"',
    "git commit -q --allow-empty -m 'x (#7)' --trailer 'Verified: npm test'",
    'git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"',
    `git commit -q --allow-empty -m "x (#7)" -m "${sob}\nprose" --trailer "Verified: none"`,
    "git -c user.name='A B' -c user.email=a@b commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'",
    'git -c user.name="A B" -c author.name=C -c committer.email=c@d commit -q --allow-empty -m "x (#7)" -m "Verified: none"',
    "git commit -q --allow-empty -m 'Fix `stamped()` in $HOME (#7)' -m 'Verified: none'",
    "git commit -q --allow-empty -m 'x* ? [a] {b,c} ~ (#7)' -m \"Verified: x* ? [a] {b,c} ~\"",
    `git commit -q --allow-empty -m "$(cat <<'EOF'\nx* ? [a] {b,c} ~ (#7)\n\nVerified: x* ? [a] {b,c} ~\nEOF\n)"`,
    'git add -A && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"',
    "git add . 'sub'&& git commit -q --allow-empty -F msg.txt",
    'cd sub && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"',
    "cd 'sub' && git add -A && git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'",
    "git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'  \n",
    'git commit -q --allow-empty --amend -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty --amend --no-edit',
    'git commit -q --allow-empty --amend --reset-author --no-edit -s',
    // A file in a subdirectory, and a value git keeps because its whitespace is not git's.
    'git commit -q --allow-empty -F sub/msg.txt',
    "git commit -q --allow-empty -m 'x (#7)' --trailer 'Verified: \v'",
    "git commit -q --allow-empty -m 'x (#7)' --trailer 'Verified: \u00a0'",
  ]) {
    assert.deepEqual(run(command), { why: null, git: true, check: true }, command)
  }
  // Forms outside the grammar, git reading a stamp in each: the gate cannot tell, and says so.
  for (const command of [
    "git commit -q --allow-empty -F - <<'EOF'\nx (#7)\n\nVerified: none\nEOF",
    "git commit -q --allow-empty -F - <<< 'x (#7)\n\nVerified: none'",
    'git commit -q --allow-empty -m "x (#7)" --trailer "Verified=npm test"',
    'git commit -q --allow-empty --cleanup=strip -m "x (#7)" -m "Verified: none"',
    'git -c user.name="$(git log -1 --format=%an)" commit -q --allow-empty -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -C HEAD',
    'git commit -q --allow-empty --fixup=HEAD -m "Verified: none"',
    'git commit -q --allow-empty --date=2026-01-01T00:00:00 -m "x (#7)" -m "Verified: none"',
    'git commit -q --allow-empty -m "x (#7)" -m "Verified: none" 2>&1 | tail -1',
    'git commit -q --allow-empty -m "x (#7)" -m "Verified: none" # done',
    'git commit -q --allow-empty -m "x (#7)" -m "Verified: none"; git log -1',
    `git commit -q --allow-empty -m "$(cat<<'EOF'\nx (#7)\n\nVerified: none\nEOF\n)"`,
    'git commit -q --allow-empty -m "$(cat <<EOF\nx (#7)\n\nVerified: none\nEOF\n)"',
    `cd sub && git commit -q --allow-empty -F ${file}`,
    // An -F path the hook and git may resolve otherwise: through a link, /proc, `..`, or outside the repository.
    'git commit -q --allow-empty -F link.txt',
    'git commit -q --allow-empty -F sublink/msg.txt',
    `git commit -q --allow-empty -F /proc/self/root${file}`,
    'git commit -q --allow-empty -F sub/../msg.txt',
    `git commit -q --allow-empty -F ${outside}`,
    // A last `Conflicts:` line, which git reads as an old conflicts list and GitHub, without its newline, does not.
    "git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m 'Conflicts:'",
  ]) {
    const { why, ...seen } = run(command)
    assert.deepEqual(seen, { git: true, check: true }, command)
    assert.match(String(why), /^the trace cannot tell the verification stamp git reads in this commit, /, command)
  }
  // Settings git reads from an included file are its own: one that sets who commits leaves the stamp alone.
  assert.deepEqual(run('git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'include.path': file, 'includeIf.gitdir:/.path': file }, '[user]\n\tname = A\n'), { why: null, git: true, check: true })

  // Each false pass the reviews found: the gate cannot tell, or the gate, git and the trace check agree.
  const commentChar = { 'core.commentChar': ';' }
  for (const [command, config = {}, text] of /** @type {[string, Record<string, string>?, string?][]} */ ([
    // Round 1: a computed paragraph, trailer.* settings, scissors, lone CRs.
    ['X=; git commit -q --allow-empty -m "$X" -m "Verified: none (#7)"'],
    ['X=; git commit -q --allow-empty -m "$X\n\nVerified: none (#7)"'],
    ["X='# c'; git commit -q --allow-empty --cleanup=strip -m \"$X\" -m 'Verified: none (#7)'"],
    [`X='${scissors}'; git commit -q --allow-empty -m 'x (#7)' -m "$X" -m 'Verified: none'`],
    ['git -c trailer.ifmissing=doNothing commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git -c trailer.verified.ifmissing=doNothing commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git -c trailer.verified.key=Other commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git -c trailer.verified.cmd=true commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"', { 'trailer.ifmissing': 'doNothing' }],
    [`git commit -q --allow-empty --cleanup=scissors -m "x (#7)" -m "${scissors}" -m "Verified: none"`],
    [`git commit -q --allow-empty -m "x (#7)" -m "${scissors}" --trailer "Verified: none"`],
    ["git commit -q --allow-empty -m $'Fix (#7)\\r\\rVerified: none'"],
    ["git commit -q --allow-empty -m $'Fix (#7)\\r\\n\\r\\nVerified: none'"],
    // Round 2: a setting written earlier on the line, a computed -c, strip dropping an expansion, core.commentString.
    ['git config trailer.ifmissing doNothing; git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git config trailer.verified.key Other && git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git config --global trailer.ifmissing doNothing && git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git config --file .git/config trailer.ifmissing doNothing && git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ['git config core.commentChar V && git commit -q --allow-empty --cleanup=strip -m "x (#7)" -m "Verified: none"'],
    ['X=trailer.ifmissing=doNothing; git -c "$X" commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    ["X=$'\\nprose'; git commit -q --allow-empty --cleanup=strip -m \"Fix (#7)\" -m \"Verified: none\" -m \"# $X\""],
    ["git -c core.commentString=';' commit -q --allow-empty --cleanup=strip -m 'x (#7)' -m 'Verified: none' -m '; prose'"],
    // Settings that change how git reads trailers.
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'trailer.separators': '=' }],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'trailer.verified.key': 'Other' }],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'trailer.x.key': 'Verifiedish' }],
    ['git -c trailer.separators== commit -q --allow-empty -s -m "x (#7)" -m "Verified: none"'],
    ['git config trailer.separators = && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"'],
    // Round 3: settings git includes, git config in forms that write, and repository settings.
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'include.path': file }, '[trailer]\n\tseparators = =\n'],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'includeIf.gitdir:/.path': file }, '[trailer]\n\tseparators = =\n'],
    ['git config --rename-section foo trailer && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'foo.separators': '=' }],
    ['git config trailer.verified.key list && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"'],
    ['git config trailer.verified.key get && git commit -q --allow-empty -m "x (#7)" -m "Verified: none"'],
    ['git config --unset core.commentChar && git commit -q --allow-empty --cleanup=strip -m "x (#7)" -m "Verified: none" -m "; prose"', commentChar],
    ['git config --remove-section commit && git commit -q --allow-empty -m "x (#7)" -m "Verified: none" -m "# prose"', { 'commit.cleanup': 'strip' }],
    ['git commit -q --allow-empty --cleanup=strip -m "x (#7)" -m "Verified: none" -m "; prose"', commentChar],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none" -m "# prose"', { 'commit.cleanup': 'strip' }],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'core.commentString': ';' }],
    // A heredoc that drops leading tabs, a command substitution the gate does not read as git does, text after one.
    ["git commit -q --allow-empty -F - <<-'EOF'\nx (#7)\n\nVerified: a\n\tb\nEOF"],
    ["git commit -q --allow-empty -F - <<-'EOF'\n\tx (#7)\n\n\tVerified: none\n\tEOF"],
    ["git commit -q --allow-empty -m \"$(cat <<-'EOF'\nx (#7)\n\nVerified: a\n\tb\nEOF\n)\""],
    ["git commit -q --allow-empty -m \"$(cat <<'EOF'\nx (#7)\n\nfoo\n\nEOF\n)Verified: none\""],
    ["git commit -q --allow-empty -m \"$(cat <<'EOF'\nx (#7)\n\nEOF\n)$(cat <<'EOF'\nVerified: none\nEOF\n)\""],
    ["git commit -q --allow-empty -m \"$(cat <<'EOF'\nx (#7)\n\nfoo\n\n\nEOF\n)Verified: none\""],
    ["git commit -q --allow-empty -m \"$(cat <<'EOF'\nx (#7)\n\n\nEOF\n)$(cat <<'EOF'\nVerified: none\nEOF\n)\""],
    ["git commit -q --allow-empty --cleanup=verbatim -m \"$(cat <<'EOF'\nx (#7)\n\nfoo\n\nEOF\n)\" --trailer 'Verified: none'"],
    ['git commit -q --allow-empty -m "$(cat <<EOF\nx (#7)\n\nVerified: $X\nEOF\n)"'],
    ["git commit -q --allow-empty -m \"$(cat <<'EOF'\nx (#7)\nEOF\n)\n\nVerified: none\""],
    // Options that undo an earlier one.
    ['git commit -q --allow-empty --cleanup=strip --no-cleanup -m "x (#7)" -m "Verified: none" -m "# prose"'],
    ['git commit -q --allow-empty --fixup=HEAD --no-fixup -m "Verified: none"'],
    ['git commit -q --allow-empty -m "y (#7)" -C HEAD --no-reuse-message'],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none" --no-message -m "y (#7)"'],
    ['git commit -q --allow-empty -s -m "x (#7)" -m "Verified: none" --no-signoff'],
    ['git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none" --no-trailer'],
    // A scissors line git does not read as one, and a comment char the shell would expand.
    [`git commit -q --allow-empty --cleanup=verbatim -F ${file}`, {}, `x (#7)\r\n\r\nVerified: none\r\n${scissors}\r\n\r\nprose`],
    ["git -c core.commentChar='$' commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m '$ ------------------------ >8 ------------------------' -m prose"],
    ["git -c core.commentChar='$' commit -q --allow-empty -m 'x (#7)' -m prose -m '$ ------------------------ >8 ------------------------' --trailer 'Verified: none'"],
    // Earlier cases: --trailer where git reads it as all token or into a block, an empty subject, a read of a setting.
    ['git commit -q --allow-empty -m "" -m "Verified: none (#7)"'],
    [`git commit -q --allow-empty -m "x (#7)" -m "${sob}\nprose\nprose\nprose\nprose" --trailer "Verified: none"`],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none\nprose" --trailer "Refs: #7"'],
    ['git commit -q --allow-empty -m "x (#7)" --trailer "Verified="'],
    ['git commit -q --allow-empty -m "x (#7)" --trailer " Verified: none"'],
    ['git commit -q --allow-empty -m "x (#7)" --trailer "  Verified=none"'],
    ['git config --get trailer.ifmissing; git commit -q --allow-empty -m "x (#7)" --trailer "Verified: none"'],
    // A setting on the line other than who commits.
    ['git -c commit.cleanup=strip commit -q --allow-empty -m "x (#7)" -m "Verified: none" -m "# prose"'],
    ['CLEANUP=strip git --config-env=commit.cleanup=CLEANUP commit -q --allow-empty -m "x (#7)" -m "Verified: none" -m "# prose"'],
    ['git -c core.commentChar=";" commit -q --allow-empty --cleanup=strip -m "x (#7)" -m "Verified: none"'],
    // Round 4: settings in repository config and in a file it includes, read by the real git.
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'include.path': file }, '[trailer "verified"]\n\tkey = Other\n'],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'includeIf.onbranch:7-stamp.path': file }, '[trailer]\n\tseparators = =\n'],
    ['git commit -q --allow-empty -m "x (#7)" -m "Verified: none"', { 'includeIf.onbranch:other.path': file }, '[user]\n\tname = A\n'],
    // An unquoted expansion, which the shell splits into words, here more options.
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --date=$(cat <<'EOF'\nnow -m prose\nEOF\n)"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --author=$(cat <<'EOF'\nA<a@b> -m prose\nEOF\n)"],
    ["X='now -m prose'; git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --date=$X"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --date=`echo now -m prose`"],
    ["git commit -q --allow-empty -m $(cat <<'EOF'\nx\nEOF\n) -m 'Verified: none (#7)'"],
    // More than one -F: git reads only the last.
    [`git commit -q --allow-empty -F ${file} -F ${other}`, {}, 'x (#7)\n'],
    [`git commit -q --allow-empty -F ${file} -F - <<< 'Verified: none'`, {}, 'x (#7)\n'],
    [`git commit -q --allow-empty -F ${file} -m 'Verified: none'`, {}, 'x (#7)\n'],
    [`git commit -q --allow-empty -F ${file} -C HEAD`, {}, 'x (#7)\n'],
    // An unquoted heredoc whose backslashes the shell reads.
    ['git commit -q --allow-empty -F - <<EOF\nx (#7)\n\nVerified: a\\\\\nb\nEOF'],
    ['git commit -q --allow-empty -F - <<EOF\nx (#7)\n\nVerified: a\\\nb\nEOF'],
    ['git commit -q --allow-empty -F - <<EOF\nx (#7)\n\nVerified: a \\$ b\nEOF'],
    // Escapes in $'…' that bash reads otherwise than the splitter.
    ["git commit -q --allow-empty -m $'x (#7)\\n\\nVerified: none\\u000a\\u000aprose'"],
    ["git commit -q --allow-empty -m $'x (#7)\\n\\nVerified: none\\U0000000a\\U0000000aprose'"],
    ["git commit -q --allow-empty -m $'x (#7)\\n\\nVerified: none\\cJ\\cJprose'"],
    ["git commit -q --allow-empty -m $'x (#7)\\n\\nVerified: none\\x0a\\012prose'"],
    // Verbatim cleanup keeps a whitespace line, after which git signs off in a paragraph of its own.
    ["git commit -q --allow-empty --cleanup=verbatim -s -m 'x (#7)' -m 'Verified: none' -m ' '"],
    ["git commit -q --allow-empty --cleanup=verbatim -m 'x (#7)' -m 'Verified: none' -m ' ' --trailer 'Refs: #7'"],
    ["git ci -q --allow-empty --cleanup=verbatim -m 'x (#7)' -m 'Verified: none' -m ' '", { 'alias.ci': 'commit -s' }],
    // Round 5: what the splitter reads otherwise than bash, in the raw text of the line.
    ["git commit -q --allow-empty -m 'x (#7)' -m <(: 'Verified: none')"],
    ["git commit -q --allow-empty -m 'x (#7)' -m >(: 'Verified: none')"],
    ["git commit -q --allow-empty -m 'x (#7)' -m \"$(cat\n<<'EOF'\nVerified: none\nEOF\n)\""],
    ["git commit -q --allow-empty -m 'x (#7)' -m \"$(cat\f<<'EOF'\nVerified: none\nEOF\n)\""],
    ["git commit -q --allow-empty -m 'x (#7)' -m \r'Verified: none'"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -t $'' -m prose"],
    ["X='now -m prose'; git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --date=$\\\nX"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -t -m\"$\"{a,b}"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m \\"],
    ["git commit -q --allow-empty -F - <<< 'x (#7)' 3<<< $'x (#7)\\n\\nVerified: none'"],
    ["git commit -q --allow-empty -F - <<'a\"b'\nx (#7)\n\nVerified: none\na\"b"],
    ["git commit -q --allow-empty -F - <<'E #'\nx (#7)\n\nVerified: none\nE #"],
    ["bash -c 'git commit -q --allow-empty -m \"x (#7)\" -m \"$1\"' _ 'Verified: none'"],
    // An earlier command that writes, or may write, the -F file; one that runs beside the commit.
    ["cat < msg.txt <<'EOF' && git commit -q --allow-empty -F msg.txt\nx (#7)\n\nVerified: none\nEOF", {}, 'x (#7)\n'],
    ["cat >> msg.txt <<'EOF' && git commit -q --allow-empty -F msg.txt\nx (#7)\n\nVerified: none\nEOF", {}, `x (#7)\n${scissors}\n`],
    ['cat > msg.txt <<EOF && git commit -q --allow-empty -F msg.txt\nx (#7)\n\nVerified: a\\\\\nprose\nEOF'],
    ["cat > sub/msg.txt <<'EOF' && git commit -q --allow-empty -F msg.txt\nx (#7)\n\nVerified: none\nEOF", {}, 'x (#7)\n'],
    ["if false; then cat > msg.txt <<'EOF'\nx (#7)\n\nVerified: none\nEOF\nfi && git commit -q --allow-empty -F msg.txt", {}, 'x (#7)\n'],
    ['git commit -q --allow-empty -F msg.txt > msg.txt'],
    ['git commit -q --allow-empty -F msg.txt | tee msg.txt', {}, 'x (#7)\n'],
    // A commit through an alias, which git splits into words otherwise than the shell.
    ['git ci -q --allow-empty', { 'alias.ci': 'commit -m "x (#7)" -m "Verified: none" -t a; -m prose' }],
    ['git ci -q --allow-empty', { 'alias.ci': 'commit -m "x (#7)" -m{prose,"Verified: none"}' }],
    // An unquoted pattern, brace or tilde, which the shell expands: to a stamp with no value (files
    // `Verified:` and `Verified: ` are there), a word more, or a path.
    ["git commit -q --allow-empty -m 'x (#7)' -m Verified:*"],
    ["git commit -q --allow-empty -m 'x (#7)' -m Verified:?"],
    ["git commit -q --allow-empty -m 'x (#7)' -m Verified:[[:space:]]"],
    ["git commit -q --allow-empty -m 'x (#7)' -m Verified:{\\ none,}"],
    ["git commit -q --allow-empty -m 'x (#7)' --trailer Verified=~"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' --date={1..2}"],
    // Round 6: words another command feeds git, a heredoc bash ends early, quoted expansions that make
    // options, a quoted digit before a redirection, `case` and `#` in `$(…)`, an undone --dry-run, a
    // redirection that empties the -F file, and a function or alias named git.
    ["echo prose | xargs git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m"],
    ["xargs -a args.txt git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m"],
    ...['EOF)', 'EOF )', 'EOF\t)', 'EOF)x'].map(end => [`git commit -q --allow-empty -m "$(cat <<'EOF'\nx (#7)\n\nVerified: none\n${end}\nprose\nEOF\n)"`]),
    ["X=-m; git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' \"$X\" prose"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' \"${X:--m}\" prose"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' \"$(printf -- -m)\" prose"],
    ["set -- -m prose; git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' \"$@\""],
    ["a=(-m prose); git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' \"${a[@]}\""],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -t '1'>/dev/null -m prose"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -t \"1\">/dev/null -m prose"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -t '1'</dev/null -m prose"],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m \"$(case a in a) echo prose;; esac)\""],
    ["git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none' -m \"$(echo prose # )\n)\""],
    ['git commit -q --allow-empty --dry-run --no-dry-run -m "x (#7)"'],
    ['F=msg.txt; git commit -q --allow-empty --allow-empty-message -F msg.txt > "$F"'],
    ['git commit -q --allow-empty --allow-empty-message -F msg.txt > link.txt'],
    ["git() { command git commit -q --allow-empty -m 'x (#7)' -m prose; }; git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'"],
    ["shopt -s expand_aliases\nalias git='git -c core.commentChar=V -c commit.cleanup=strip'\ngit commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'"],
    // Round 7: -s and --trailer on a message with nothing in it, which git writes as one paragraph, the
    // subject; a `cd` to `-` (OLDPWD) or to ''.
    ["git commit -q --allow-empty -s -m '' --trailer 'Verified: none (#7)'"],
    ["git commit -q --allow-empty -s -m ' ' --trailer 'Verified: none (#7)'"],
    ["git commit -q --allow-empty -sm '' --trailer 'Verified: none (#7)'"],
    ["git commit -q --allow-empty -s -m \"$(cat <<'EOF'\nEOF\n)\" --trailer 'Verified: none (#7)'"],
    ["git commit -q --allow-empty -s -F msg.txt --trailer 'Verified: none (#7)'", {}, ' \n\t\n'],
    ["cd '-' && git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'"],
    ["cd '' && git commit -q --allow-empty -m 'x (#7)' -m 'Verified: none'"],
  ])) {
    const { why, git: byGit, check } = run(command, config, text)
    if (!/cannot tell/.test(String(why))) assert.deepEqual({ gate: why === null, check }, { gate: byGit, check: byGit }, `${command} ${JSON.stringify(config)}: ${why}`)
    else assert.match(String(why), /cannot tell the commit message|cannot tell the verification stamp/, command)
  }

  // An amend that keeps an empty HEAD message, signed off and given a trailer: one paragraph, the subject.
  git(['commit', '-q', '--allow-empty', '--allow-empty-message', '-m', ''])
  const amended = run("git commit -q --allow-empty --amend --no-edit -s --trailer 'Verified: none (#7)'")
  assert.deepEqual({ gate: amended.why === null, check: amended.check }, { gate: amended.git, check: amended.git }, String(amended.why))
  git(['commit', '-q', '--allow-empty', '-m', 'x (#7)', '-m', 'Verified: none'])

  // Commands generated in the grammar's forms: the gate tells each, allows one only when git reads a stamp,
  // and the trace check reads what git reads. STAMP_FUZZ=3000 runs more.
  let fuzz = 62
  const any = (/** @type {string[]} */ xs) => {
    fuzz = (fuzz * 1103515245 + 12345) % 2 ** 31
    return /** @type {string} */ (xs[fuzz % xs.length])
  }
  const paragraphs = ['Verified: none', 'Verified: none', 'Verified: npm test', 'prose', sob, '# c', ' ', 'Why `x` and $HOME.', 'Verified: a\n  b', 'x* ? [a] {b,c} ~', `prose\n${sob}`, 'Don\'t "quote" (me)']
  /** @param {string} v @returns {string | undefined} */
  const quoted = v => {
    const ways = [!v.includes("'") ? `'${v}'` : '', !/[$`"\\]/.test(v) ? `"${v}"` : ''].filter(Boolean)
    return ways.length ? any(ways) : undefined
  }
  let allowed = 0
  const count = Number(process.env.STAMP_FUZZ ?? 40)
  for (let i = 0; i < count; i++) {
    const parts = ['x (#7)', ...Array.from({ length: 1 + (i % 3) }, () => any(paragraphs))]
    const text = parts.join('\n\n')
    const each = parts.map(quoted)
    const sources = [`-m "$(cat <<'EOF'\n${text}\nEOF\n)"`, `-F ${file}`, '--amend --no-edit']
    if (each.every(q => q !== undefined)) sources.push(`${any(['-m', '-am', '-sm', '-asm', '-sam'])} ${each.join(' -m ')}`)
    const source = any(sources)
    const options = [any(['', '-s ']), any(['', '-a ', '-q ', '--verbose '])].join('')
    const trailer = any(['', '', " --trailer 'Verified: npm test'", ' --trailer "Verified: none"'])
    const who = any(['', "-c user.name='A B' -c user.email=a@b "])
    const before = any(['', 'git add -A && ', 'git add . && ', ...(source.startsWith('-F') ? [] : ['cd sub && '])])
    const command = `${before}git ${who}commit --allow-empty ${options}${source}${trailer}`
    const { why, git: byGit, check } = run(command, {}, text)
    assert.equal(check, byGit, `trace check: ${command}`)
    assert.doesNotMatch(String(why), /cannot tell/, command)
    assert.equal(why === null, byGit, `${command}: ${why}`)
    if (why === null) allowed++
  }
  // Most carry a stamp, so a gate that allowed nothing fails here.
  assert.ok(allowed > count / 3, `${allowed} of ${count} generated commands allowed`)

  // Messages as git records them, judged as the commit that keeps one: the trace check reads what git reads,
  // and the gate allows only what git reads as stamped.
  /** @param {string} message @param {string} what */
  const agree = (message, what) => {
    git(['commit', '-q', '--allow-empty', '--allow-empty-message', '--cleanup=verbatim', '-F', '-'], message)
    const { git: byGit, check } = read()
    assert.equal(check, byGit, `${what}: ${JSON.stringify(message)}`)
    const why = gate('git commit --amend --no-edit')
    if (!/cannot tell/.test(String(why))) assert.equal(why === null, byGit, `--amend --no-edit: ${JSON.stringify(message)}: ${why}`)
  }
  for (const message of [
    'x (#7)\n\nVerified: none',
    'x (#7)\n\nVerified : npm test\nSigned-off-by: A <a@b>',
    'x (#7)\n\nVerified: npm\n  test',
    'x (#7)\n  \nVerified: none\n\n',
    'x (#7)\nVerified: none',
    'x (#7)\n\nVerified:',
    'x (#7)\n\nVerified: none\nprose',
    'x (#7)\n\nVerified: none\n---\nmore',
    'x (#7)\n\nVerified: none\n\nlater',
    'Verified: none (#7)',
    `x (#7)\n\nVerified: none\n${scissors}\nmore`,
    `x (#7)\n\n${scissors}\nVerified: none`,
    `x (#7)\n\nprose\n\n${scissors}\n\nVerified: none`,
    `x (#7)\n\nprose\n\nVerified: none\n${scissors}`,
    'x (#7)\n\nVerified: none\n# a comment',
    'x (#7)\n\n# a comment\nVerified: none',
    '# a comment\nx (#7)\n\nVerified: none',
    `x (#7)\n\nVerified: none\n${sob}\nprose\nprose\nprose`,
    `x (#7)\n\nVerified: none\nprose\nprose\nprose\nprose\nprose\nprose\nprose\n${sob}`,
    'x (#7)\n\nVerified: none\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)',
    'x (#7)\n\nVerified: a\n  b\nnot',
    'x (#7)\r\rVerified: none',
    'x (#7)\r\n\r\nVerified: none\r\n',
    `x (#7)\r\n\r\nVerified: none\r\n${scissors}\r\n\r\nprose`,
    'x (#7)\n\n\v\nVerified: none',
    'Fix `stamped()` in $HOME (#7)\n\nVerified: none',
    'x (#7)\n\nVerified: npm test `x` $(date)',
    // Round 4: what git keeps at the end of a stored message.
    'x (#7)\n\nVerified: none\n\n\v',
    'x (#7)\n\nVerified: none\n\n\f',
    'x (#7)\n\nVerified: none\n\n\u00a0',
    // Round 5: the character the gate writes for computed text, here written out.
    'x (#7)\n\nVerified: none \uE030',
    // Round 7: a `Conflicts:` line git reads as a conflicts list only with a newline after it.
    'x (#7)\n\nVerified: none\n\nConflicts:',
    'x (#7)\n\nVerified: none\n\nConflicts:\n',
    'x (#7)\n\nVerified: none\n\nConflicts:\r\n',
    'x (#7)\n\nVerified: none\n\nConflicts:\n\ta.txt\n',
  ]) {
    agree(message, 'listed')
  }
  // Scissors lines and line ends of every kind, mixed: the trace check still reads what git reads.
  let seed = 58
  const pick = (/** @type {string[]} */ xs) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return /** @type {string} */ (xs[seed % xs.length])
  }
  for (let i = 0; i < 60; i++) {
    const lines = ['x (#7)', ...Array.from({ length: 2 + (i % 5) }, () => pick(['', '', 'Verified: none', scissors, scissors, 'prose', '# c', sob, ' b']))]
    agree(lines.map(l => l + pick(['\n', '\r\n', '\r\n', '\r'])).join('') + pick(['', 'prose', 'Verified: none']), `generated ${i}`)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('a commit whose stamp the gate cannot read says where the line leaves the forms it reads, or names the setting', t => {
  const stamp = "-m 'x (#7)' -m 'Verified: none'"
  // A repository in a scratch directory, for the -F files the gate reads there.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'msg-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const msg = join(dir, 'msg.txt')
  writeFileSync(msg, 'x (#7)\n\nVerified: none\n')
  writeFileSync(join(dir, '-x'), 'x (#7)\n\nVerified: none\n')
  symlinkSync('msg.txt', join(dir, 'link.txt'))
  mkdirSync(join(dir, 'sub'))
  const outer = mkdtempSync(join(tmpdir(), 'outer-'))
  t.after(() => rmSync(outer, { recursive: true, force: true }))
  writeFileSync(join(outer, 'msg.txt'), 'x (#7)\n\nVerified: none\n')
  writeFileSync(join(dir, 'cr.txt'), 'x (#7)\r\rVerified: none\n')
  writeFileSync(join(dir, 'cut.txt'), 'x (#7)\n\n# ------------------------ >8 ------------------------\nVerified: none\n')
  /** @param {string} command @param {Parameters<typeof world>[0]} [o] */
  const inDir = (command, o) => {
    const w = onSeven(o)
    return commandVerdict(command, dir, { ...w, git: { ...w.git, root: (/** @type {string} */ p) => (p === dir || p.startsWith(`${dir}/`) ? dir : null), traced: (/** @type {string} */ r) => r === dir } })
  }
  const forms = /Implement step: run the commit as the last command on its line, with only `git add <paths> && ` or `cd <dir> && ` before it/
  for (const [command, config, named, fix = forms] of /** @type {[string, Record<string, string>, RegExp, RegExp?][]} */ ([
    // Where the line leaves the grammar.
    [`git commit ${stamp} 2>&1 | tail -1`, {}, /which leaves the forms the gate reads at `2>&1 \| tail -1`/],
    [`npm test && git commit ${stamp}`, {}, /at `npm test && git commit -m 'x \(…`/],
    [`git commit --date=now ${stamp}`, {}, /at `--date=now/],
    ['git ci', { 'alias.ci': `commit ${stamp}` }, /at `git ci`/],
    [`git commit -F - <<'EOF'\nx (#7)\n\nVerified: none\nEOF`, {}, /at `-F - <<'EOF'`/],
    [`git commit -m "$(cat <<'EOF'\nx (#7)\n\nVerified: none\nEOF)\nEOF\n)"`, {}, /at `-m "\$\(cat <<'EOF'`/],
    [`git commit -m 'x (#7)'\r -m 'Verified: none'`, {}, /a carriage return/],
    [`git commit -m 'x (#7)\0' -m 'Verified: none'`, {}, /a NUL byte/],
    ["git commit -F '-x'", {}, /at `-F '-x'`/],
    [`git commit -F ${join(outer, 'msg.txt')}`, {}, /whose -F file is outside the repository/, /write the message out with -m/],
    ['git commit -F link.txt', {}, /whose -F path goes through a symbolic link/, /write the message out with -m/],
    ['git commit -F sub/../msg.txt', {}, /whose -F path holds `\.\.`/, /write the message out with -m/],
    // Parts the grammar holds, in a combination it does not.
    [`git commit -F ${msg} -F ${msg}`, {}, /with more than one -F/],
    [`git commit ${stamp} -F ${msg}`, {}, /with -F beside -m/],
    [`cd sub && git commit -F ${msg}`, {}, /with -F after a `cd`/],
    [`git commit --no-edit ${stamp}`, {}, /with --no-edit other than as `--amend --no-edit` alone/],
    // git's settings for trailers, comments and cleanup.
    [`git commit ${stamp}`, { 'trailer.separators': '=' }, /with git's `trailer\.separators` setting/, /commit where git does not set `trailer\.separators`/],
    [`git commit ${stamp}`, { 'includeIf.onbranch:7-gates.path': '~/x' }, /with git's `includeIf\.onbranch:7-gates\.path` setting/, /commit where git does not set/],
    [`git commit ${stamp}`, { 'core.commentChar': ';' }, /with git's `core\.commentChar` setting/, /commit where git does not set/],
    [`git commit ${stamp}`, { 'commit.cleanup': 'strip' }, /with git's `commit\.cleanup` setting/, /commit where git does not set/],
    // What a file holds.
    [`git commit -F ${join(dir, 'cr.txt')}`, {}, /with a carriage return in its message/, /write the message out with -m/],
    [`git commit -F ${join(dir, 'cut.txt')}`, {}, /with a scissors line \(`>8`\) in its message/, /write the message out with -m/],
  ])) {
    const why = String(inDir(command, { config }))
    assert.match(why, /^the trace cannot tell the verification stamp git reads in this commit, /, command)
    assert.match(why, named, command)
    assert.match(why, fix, command)
    assert.match(why, /and end the commit message with a last paragraph "Verified: <how it was verified>"/, command)
  }
  // Settings for who commits, a file git includes and git's defaults written out leave the stamp alone.
  assert.equal(verdict(`git -c user.name='A B' -c user.email=a@b -c author.name="A B" commit ${stamp}`), null)
  assert.equal(verdict(`git commit ${stamp}`, { config: { 'include.path': '~/x', 'includeIf.gitdir:~/.path': '~/y' } }), null)
  assert.equal(verdict(`git commit ${stamp}`, { config: { 'core.commentChar': '#', 'commit.cleanup': 'default', 'user.name': 'a' } }), null)
  assert.equal(inDir(`git add -A && git commit -F ${msg}`), null)
  assert.equal(inDir('git add -A && git commit -F msg.txt'), null)
  // Claude Code's heredoc form is text: a stamp in the wrong paragraph is missing.
  const footer = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
  assert.match(String(verdict(`git commit -m "$(cat <<'EOF'\nx (#7)\n\nVerified: none\n\n${footer}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`)), /^this commit message carries no verification stamp/)
  assert.equal(verdict(`git commit -m "$(cat <<'EOF'\nx (#7)\n\n${footer}\n\nVerified: none\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`), null)
  assert.match(String(verdict('$(echo git) commit -m x')), /"#7" and a verification stamp/)
})

test('an amend that keeps the message is judged by the commit it rewrites', () => {
  assert.equal(verdict('git commit --amend --no-edit', { messages: { HEAD: 'Add the gate (#7)\n\nVerified: none' } }), null)
  assert.match(String(verdict('git commit --amend --no-edit', { messages: { HEAD: 'Add the gate' } })), /#7/)
  assert.ok(referenced('git commit -C abc123', { messages: { abc123: 'x (#7)' } }))
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
    'git config set trailer.ifmissing doNothing && git commit -m "x (#7)" --trailer "Verified: none"',
    'git config core.commentString ";" && git commit -m "x (#7)" -m "Verified: none"',
    'git config commit.cleanup strip && git commit -m "x" -m "#7" -m "Verified: none"',
  ]) {
    assert.match(String(verdict(command)), /cannot tell/, command)
  }
})

test('a commit through a git alias is judged as the command it runs', () => {
  assert.match(String(verdict('git ci -m x', { aliases: { ci: 'commit -a' } })), /#7/)
  // Its stamp the gate cannot tell: git splits an alias into words otherwise than the shell.
  assert.match(String(verdict('git ci -m "x #7" -m "Verified: none"', { aliases: { ci: 'commit -a' } })), /cannot tell the verification stamp git reads in this commit, which leaves the forms the gate reads at `git ci/)
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
  assert.ok(referenced('git commit --fixup=abc', { messages: { abc: 'Add the gate (#7)\n\nBody' } }))
  assert.match(String(verdict('git commit --fixup abc', { messages: { abc: 'Add the gate\n\nRefs #7' } })), /does not reference #7/)
  assert.ok(referenced('git commit -m x --trailer "Refs: #7"'))
  assert.match(String(verdict('git commit --cleanup=strip -m "#7: add the gate"')), /does not reference #7/)
  assert.match(String(verdict('git -c commit.cleanup=strip commit -m "#7: add the gate"')), /does not reference #7/)
  assert.match(String(verdict('git commit -m "#7: add the gate"', { config: { 'commit.cleanup': 'strip' } })), /does not reference #7/)
  assert.ok(referenced('git -c core.commentChar=";" commit --cleanup=strip -m "#7: add the gate"'))
  // Without an editor, git reads scissors as whitespace.
  assert.ok(referenced('git commit --cleanup=scissors -m "#7 x" -m "# ------------------------ >8 ------------------------"'))
  assert.equal(verdict('git commit --dry-run'), null)
  // git reads the last of --dry-run and --no-dry-run.
  assert.match(String(verdict('git commit --dry-run --no-dry-run -m x')), /does not reference #7/)
  assert.match(String(verdict("git commit --dry-run --no-dry-run -m 'x (#7)' -m 'Verified: none'")), /cannot tell the verification stamp .* at `--dry-run --no-dry-run/)
  assert.equal(verdict('git commit --no-dry-run --dry-run -m x'), null)
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
  assert.ok(referenced("cat > m.txt <<'EOF'\nAdd the gate (#7)\nEOF\ngit commit -F m.txt"))
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
  assert.throws(() => verdict('gh prc', { ghAliases: null }), /GitHub did not answer: gh alias list failed/)
})

test('the shell runs what the gates read: wrappers, case, shells fed a script, fd redirects, cds', () => {
  // `GH` is `gh` only where the file system folds case.
  for (const command of [...(CASE_INSENSITIVE_FS ? ['GH pr create -t t -b x'] : []), 'arch -arm64 gh pr create -t t -b x', 'exec -a x gh pr create -t t -b x', 'env -P /opt/bin gh pr create -t t -b x', 'script -q /dev/null gh pr create -t t -b x', "bash -c -- 'gh pr create -t t -b x'", "bash <<< 'gh pr create -t t -b x'", 'gh pr create -t t -b $\'Refs\\x00 Closes #7\'']) {
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
    assert.ok(referenced(command), command)
  }
  assert.match(String(verdict('git commit -m "$(cat <<EOF\nx (#7$(date)\nEOF\n)"')), /cannot tell/)
})

test('the hook refuses an unreferenced commit or PR in a traced repository, in a subagent too, reading files from cwd', () => {
  const { dir, git } = repo()
  git('checkout', '-qb', '16-gates')
  const issues = { 'owner/name#16': { state: 'open' } }
  writeFileSync(join(dir, 'msg.txt'), 'Add the gate (#16)\n\nVerified: none\n')
  writeFileSync(join(dir, 'bare.txt'), 'Add the gate\n')
  writeFileSync(join(dir, 'body.md'), '## Summary\n\nCloses #16\n')
  const bash = (/** @type {string} */ command, /** @type {object} */ extra = {}) => hook({ tool_name: 'Bash', tool_input: { command }, cwd: dir, ...extra }, {}, issues)
  for (const extra of [{}, { agent_id: 'sub-1', agent_type: 'general-purpose' }]) {
    assert.match(String(bash('git commit -m "Add the gate"', extra)?.permissionDecisionReason), /trace: .*#16/)
    assert.equal(bash('git commit -m "Add the gate (#16)" -m "Verified: none"', extra), null)
    assert.match(String(bash('git commit -m "Add the gate (#16)"', extra)?.permissionDecisionReason), /trace: .*no verification stamp/)
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
