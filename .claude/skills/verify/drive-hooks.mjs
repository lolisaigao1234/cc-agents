#!/usr/bin/env node
// Drives the trace plugin's hooks the way Claude Code calls them, and prints
// every call and what it returned: `node .claude/skills/verify/drive-hooks.mjs`.
//
// Each call takes its command from plugins/trace/hooks/hooks.json, as its
// matcher selects it, and runs it through `sh -c` with CLAUDE_PLUGIN_ROOT
// set, the hook input as JSON on stdin, in the session's directory, under
// the timeout hooks.json gives it.
//
// The calls run in scratch repositories that are made new on each run and
// removed after it, so a run asks nothing of this repository or of GitHub and
// leaves nothing behind. git is the real one. `gh` is a stand-in that gives
// fixed answers (GH below), and the hook keeps its records (what each agent
// read, a halt) in a scratch temp directory. The same tree therefore prints
// the same lines on every run.
//
// It exits 0 when every call returned what CALLS expects of it, and 1 otherwise.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const PLUGIN = join(REPO, 'plugins/trace')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'verify-hooks-')))

// --- the scratch world -----------------------------------------------------------

// The one issue GitHub has, as its API gives it.
const ISSUE = { state: 'open', title: 'Fix the thing', body: '## Acceptance criteria\n\n- [ ] The thing is fixed.\n', comments: 0 }

// The stand-in for gh: it answers what the hooks ask of issue #7 in owner/name,
// and fails, saying so, on anything it has no fixed answer for.
const GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
const say = (text, code = 0) => { (code ? process.stderr : process.stdout).write(text); process.exit(code) }
if (args[0] === 'alias' && args[1] === 'list') say('')
if (args[0] === 'api' && args[1] === 'repos/owner/name/issues/7') say(${JSON.stringify(JSON.stringify(ISSUE))})
if (args[0] === 'pr' && args[1] === 'view') say('no pull requests found for branch "' + args[2] + '"\\n', 1)
say('gh stand-in: no fixed answer for: gh ' + args.join(' ') + '\\n', 1)
`

// git for the scratch repositories, and for the hooks' own questions: no
// configuration of the machine's, and fixed dates.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }

/** @param {string} dir @param {string[]} args */
const git = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...GIT_ENV } })

/** @param {string} name @param {Record<string, string>} files @returns {string} a repository on `main` holding `files` */
function repo(name, files) {
  const dir = join(SCRATCH, name)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'Start')
  return dir
}

const TRACED = {
  '.claude/trace.json': '{}\n',
  'GLOSSARY.md': '# Glossary\n\n**Thing**:\nWhat the issue fixes.\n',
  'docs/adr/0001-things-are-fixed.md': '---\nstatus: accepted\n---\n\n# 0001: Things are fixed\n',
  'notes.md': 'Notes.\n',
}

/** The scratch repositories and the two PATHs the calls run under. */
function world() {
  const bin = join(SCRATCH, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), GH, { mode: 0o755 })
  // A PATH with node and no git, for the call git gives no answer to.
  const noGit = join(SCRATCH, 'no-git')
  mkdirSync(noGit)
  symlinkSync(process.execPath, join(noGit, 'node'))
  mkdirSync(join(SCRATCH, 'tmp'))

  // Not opted in to the trace, with an archive.
  const plain = repo('plain', { 'notes.md': 'Notes.\n', 'archive/old.md': 'Superseded.\n' })
  // Opted in, on the default branch.
  const onMain = repo('on-main', TRACED)
  // Opted in, on issue #7's branch, its one commit pushed.
  const onIssue = repo('on-issue', TRACED)
  git(onIssue, 'remote', 'add', 'origin', 'https://github.com/owner/name.git')
  git(onIssue, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(onIssue, 'checkout', '-qb', '7-fix-the-thing')
  writeFileSync(join(onIssue, 'notes.md'), 'Notes, fixed.\n')
  git(onIssue, 'commit', '-qam', 'Fix the thing (#7)')
  git(onIssue, 'update-ref', 'refs/remotes/origin/7-fix-the-thing', 'HEAD')
  return { plain, onMain, onIssue, path: `${bin}:${process.env.PATH}`, noGit }
}

// --- the hook inputs, as Claude Code sends them ----------------------------------

/** @param {string} command */
const bash = command => ({ tool_name: 'Bash', tool_input: { command } })
/** @param {string} file_path */
const edit = file_path => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'Notes', new_string: 'Notes!' } })
/** @param {string} file_path */
const read = file_path => ({ tool_name: 'Read', tool_input: { file_path } })
/** @param {string} file_path @returns {object} a Read that returned the whole file */
function readDone(file_path) {
  const content = readFileSync(file_path, 'utf8')
  const lines = content.split('\n').length
  return { ...read(file_path), tool_response: { type: 'text', file: { filePath: file_path, content, numLines: lines, startLine: 1, totalLines: lines } } }
}
/** @param {string} command @param {string} stdout @returns {object} a Bash command that printed `stdout` */
const bashDone = (command, stdout) => ({ ...bash(command), tool_response: { stdout, stderr: '', interrupted: false, isImage: false } })

const SUBAGENT = { agent_id: 'agent-1', agent_type: 'general-purpose' }

/**
 * The calls, in order. Calls of one `session` share the hook's records, as the
 * calls of one Claude Code session do, so their order is part of what they show.
 *
 * `expect` is what the hook must return: 'silent' (exit 0 and no output: the
 * action goes ahead), 'deny' (a refused tool call), 'context' (text added to
 * the agent's context), 'block' (a refused stop) or 'halt' (the session
 * stopped). `says`, when given, must match what the hook said.
 *
 * @typedef {{ what: string, session: string, cwd: string, event: string, input?: object, expect: 'silent' | 'deny' | 'context' | 'block' | 'halt', says?: RegExp, path?: string }} Call
 * @param {ReturnType<typeof world>} w @returns {Call[]}
 */
const CALLS = ({ plain, onMain, onIssue, noGit }) => [
  // Everywhere: the guard and the archive block (ADR 0008).
  { what: 'a command nothing refuses', session: 'plain', cwd: plain, event: 'PreToolUse', input: bash('git status'), expect: 'silent' },
  { what: 'the guard: a command that destroys work', session: 'plain', cwd: plain, event: 'PreToolUse', input: bash('git reset --hard HEAD~1'), expect: 'deny', says: /^trace guard: / },
  { what: 'the archive block: a read inside the archive', session: 'plain', cwd: plain, event: 'PreToolUse', input: read(join(plain, 'archive/old.md')), expect: 'deny', says: /archive/ },

  // A traced repository, on the default branch (ADR 0006).
  { what: 'a session starting on the default branch is told the step to go back to', session: 'main', cwd: onMain, event: 'SessionStart', input: { source: 'startup' }, expect: 'context', says: /^Trace: this is the default branch \(main\)/ },
  { what: 'an edit on the default branch', session: 'main', cwd: onMain, event: 'PreToolUse', input: edit(join(onMain, 'notes.md')), expect: 'deny', says: /^trace: this is the default branch \(main\)/ },

  // A traced repository, on issue #7's branch: the forced reads (ADR 0007), then the gates (ADR 0006).
  { what: "a session starting on an issue's branch is told the issue", session: 'issue', cwd: onIssue, event: 'SessionStart', input: { source: 'startup' }, expect: 'context', says: /issue #7, "Fix the thing"/ },
  { what: 'an edit before the related docs are read', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: edit(join(onIssue, 'notes.md')), expect: 'deny', says: /Unread: / },
  { what: 'the glossary, read in full', session: 'issue', cwd: onIssue, event: 'PostToolUse', input: readDone(join(onIssue, 'GLOSSARY.md')), expect: 'silent' },
  { what: 'the ADR, read in full', session: 'issue', cwd: onIssue, event: 'PostToolUse', input: readDone(join(onIssue, 'docs/adr/0001-things-are-fixed.md')), expect: 'silent' },
  { what: 'the issue, read', session: 'issue', cwd: onIssue, event: 'PostToolUse', input: bashDone('gh issue view 7 --comments', `${ISSUE.title}\n${ISSUE.body}`), expect: 'silent' },
  { what: 'the same edit, once the related docs are read', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: edit(join(onIssue, 'notes.md')), expect: 'silent' },
  { what: 'a commit that does not reference the issue', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: bash('git commit -m "Fix the thing"'), expect: 'deny', says: /#7/ },
  { what: 'a commit that references the issue', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: bash('git commit -m "Fix the thing (#7)"'), expect: 'silent' },
  { what: 'a PR whose body does not close the issue', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: bash('gh pr create --title "Fix the thing" --body "Fixes the thing."'), expect: 'deny', says: /Closes #7/ },
  { what: 'a PR whose body closes the issue', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: bash('gh pr create --title "Fix the thing" --body "Closes #7"'), expect: 'silent' },
  { what: 'a stop after a push, with no progress comment since', session: 'issue', cwd: onIssue, event: 'Stop', input: { stop_hook_active: false }, expect: 'block', says: /progress comment on #7/ },
  { what: 'the next stop: the nudge asks once', session: 'issue', cwd: onIssue, event: 'Stop', input: { stop_hook_active: false }, expect: 'silent' },
  { what: 'a subagent starting is told the issue', session: 'issue', cwd: onIssue, event: 'SubagentStart', input: SUBAGENT, expect: 'context', says: /issue #7, "Fix the thing"/ },
  { what: "the subagent's edit: its parent's reads are not its own", session: 'issue', cwd: onIssue, event: 'PreToolUse', input: { ...edit(join(onIssue, 'notes.md')), ...SUBAGENT }, expect: 'deny', says: /Unread: / },
  { what: 'a compaction', session: 'issue', cwd: onIssue, event: 'PostCompact', input: { trigger: 'auto', compact_summary: 'Fixing the thing.' }, expect: 'silent' },
  { what: 'the edit after the compaction: the reads are forgotten', session: 'issue', cwd: onIssue, event: 'PreToolUse', input: edit(join(onIssue, 'notes.md')), expect: 'deny', says: /Unread: / },

  // The halt (ADR 0006): git gives no answer, every call halts, a prompt lifts it.
  { what: 'an edit while git is not on PATH', session: 'halt', cwd: onIssue, event: 'PreToolUse', input: edit(join(onIssue, 'notes.md')), expect: 'halt', says: /^trace halted the session: git did not answer/, path: noGit },
  { what: 'the next call, git back: the halt stands', session: 'halt', cwd: onIssue, event: 'PreToolUse', input: bash('git status'), expect: 'halt', says: /^trace halted the session: git did not answer/ },
  { what: 'a prompt', session: 'halt', cwd: onIssue, event: 'UserPromptSubmit', input: { prompt: 'git is back' }, expect: 'silent' },
  { what: 'the call after the prompt: the halt is lifted', session: 'halt', cwd: onIssue, event: 'PreToolUse', input: bash('git status'), expect: 'silent' },
]

// --- calling a hook as Claude Code does ------------------------------------------

/** @type {Record<string, { matcher?: string, hooks: { type: string, command: string, timeout?: number }[] }[]>} the hooks the plugin registers, by event */
let REGISTERED = {}

// What each event's matcher is compared with; the other events take none.
const MATCHED = /** @type {Record<string, string>} */ ({ PreToolUse: 'tool_name', PostToolUse: 'tool_name', SessionStart: 'source', SubagentStart: 'agent_type', PostCompact: 'trigger' })

/** @param {string | undefined} matcher @param {unknown} subject @returns {boolean} whether Claude Code would run a hook with `matcher` for `subject` */
function matches(matcher, subject) {
  if (!matcher || matcher === '*' || typeof subject !== 'string') return true
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some(m => m.trim() === subject)
  return new RegExp(matcher).test(subject)
}

/** @param {string} text @returns {string} `text` with this run's own paths named, so every run prints the same */
const named = text => text.replaceAll(SCRATCH, '<scratch>').replaceAll(REPO, '<repo>')

/**
 * What a hook's exit code and output mean to Claude Code. A hook that prints
 * to stderr and exits 0 has failed open, which is not the action going ahead.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} r @param {string} event
 * @returns {{ kind: string, says?: string }}
 */
function outcome(r, event) {
  if (r.error) return { kind: /** @type {NodeJS.ErrnoException} */ (r.error).code === 'ETIMEDOUT' ? 'timed out' : `did not run (${r.error.message})` }
  let out = null
  if (r.stdout.trim()) {
    try {
      out = JSON.parse(r.stdout)
    } catch {
      return { kind: 'output that is not JSON' }
    }
  }
  if (out?.continue === false) {
    const exit = event === 'PreToolUse' ? 2 : 0
    return r.status === exit ? { kind: 'halt', says: String(out.stopReason) } : { kind: `a halt that exits ${r.status}, not ${exit}` }
  }
  if (r.status !== 0) return { kind: `exit ${r.status}` }
  if (r.stderr.trim()) return { kind: 'an error on stderr' }
  if (!out) return { kind: 'silent' }
  const specific = out.hookSpecificOutput ?? {}
  if (specific.permissionDecision === 'deny') return { kind: 'deny', says: String(specific.permissionDecisionReason) }
  if (out.decision === 'block') return { kind: 'block', says: String(out.reason) }
  if (typeof specific.additionalContext === 'string') return { kind: 'context', says: specific.additionalContext }
  return { kind: 'output this script cannot place' }
}

/** @param {string} label @param {string} text */
const show = (label, text) => console.log(`     ${label.padEnd(7)}${named(text.trimEnd()).replaceAll('\n', `\n     ${' '.repeat(7)}`) || '(nothing)'}`)

/** @param {Call} call @param {number} i @param {ReturnType<typeof world>} w @returns {{ ok: boolean, line: string }} whether the call returned what it expects, and its line of the summary */
function run(call, i, w) {
  const input = { session_id: `verify-${call.session}`, transcript_path: join(SCRATCH, `${call.session}.jsonl`), cwd: call.cwd, permission_mode: 'default', hook_event_name: call.event, ...call.input }
  const subject = /** @type {Record<string, unknown>} */ (input)[MATCHED[call.event] ?? '']
  const commands = (REGISTERED[call.event] ?? []).filter(group => matches(group.matcher, subject)).flatMap(group => group.hooks.filter(h => h.type === 'command'))
  const { TRACE_BYPASS: _, ...inherited } = process.env
  const env = { ...inherited, ...GIT_ENV, PATH: call.path ?? w.path, TMPDIR: join(SCRATCH, 'tmp'), CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: call.cwd }

  const title = `[${String(i + 1).padStart(2, '0')}] ${call.event}: ${call.what}`
  console.log(`\n${title}`)
  show('cwd', call.cwd)
  if (call.path) show('PATH', call.path)
  show('stdin', JSON.stringify(input))
  /** @type {{ kind: string, says?: string }} */
  let got = { kind: commands.length ? 'silent' : 'no hook registered for it' }
  for (const { command, timeout = 600 } of commands) {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: call.cwd, env, input: JSON.stringify(input), encoding: 'utf8', timeout: timeout * 1000 })
    show('$', command)
    show('exit', String(r.status ?? r.signal ?? r.error?.message))
    show('stdout', r.stdout ?? '')
    show('stderr', r.stderr ?? '')
    const o = outcome(r, call.event)
    // Of several hooks on one event, the first that is not silent decides.
    if (got.kind === 'silent') got = o
  }
  const ok = got.kind === call.expect && (!call.says || call.says.test(got.says ?? ''))
  const verdict = `${got.kind}: ${ok ? 'as expected' : `NOT AS EXPECTED, which is ${call.expect}${call.says ? ` saying ${call.says}` : ''}`}`
  console.log(`     => ${verdict}`)
  return { ok, line: `${title} => ${verdict}` }
}

// --- the run ---------------------------------------------------------------------

let passed = false
try {
  console.log('verify hooks: the hooks registered in <repo>/plugins/trace/hooks/hooks.json, with CLAUDE_PLUGIN_ROOT=<repo>/plugins/trace.')
  console.log("<repo> is this repository and <scratch> this run's scratch directory. git is real; gh is a stand-in with fixed answers.")
  REGISTERED = JSON.parse(readFileSync(join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks
  const w = world()
  const results = CALLS(w).map((call, i) => run(call, i, w))
  const failed = results.filter(r => !r.ok).length
  console.log(`\nverify hooks: summary\n${results.map(r => r.line).join('\n')}`)
  console.log(failed ? `verify hooks: FAILED. ${failed} of ${results.length} hook calls did not return what was expected.` : `verify hooks: passed. ${results.length} of ${results.length} hook calls returned what was expected.`)
  passed = failed === 0
} catch (err) {
  console.log(`\nverify hooks: summary\nverify hooks: FAILED. It could not run: ${named(String(/** @type {Error} */ (err).stack ?? err))}`)
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
process.exitCode = passed ? 0 : 1
