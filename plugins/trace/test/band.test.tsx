import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TraceState, TraceStatus } from '../types'

const BAND = {
  plugin: 'trace',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// `/trace` as the person types it at the prompt: the plugin's trace skill's
// name, which the band answers with the status.
const TRACE = { command: 'trace:trace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const AT_UPDATE: TraceStatus = {
  step: 'update',
  why: 'commits were pushed to 10-trace-band after the last comment on #10. Update step: post a progress comment on #10.',
  done: ['read', 'track', 'branch', 'implement', 'review'],
  issue: { n: 10, title: 'Trace band and /trace command', url: 'https://github.com/owner/name/issues/10' },
  docs: 'read',
  comment: { author: 'claude', at: '2026-10-28T10:00:00Z', body: '## Progress\n\nThe band draws.', isProgress: true },
  last: null,
  pr: {
    n: 21,
    url: 'https://github.com/owner/name/pull/21',
    state: 'OPEN',
    ci: 'failing',
    checks: [
      { name: 'test', state: 'SUCCESS', outcome: 'passing' },
      { name: 'lint', state: 'FAILURE', outcome: 'failing' },
      { name: 'e2e', state: 'PENDING', outcome: 'pending' },
    ],
  },
}

/**
 * Stands for the engine: a session in /repo whose `node hook.mjs status`
 * prints `status` (nothing for null; a throw is a failed run), and what each
 * run was asked.
 */
function engine(on: On, status: () => TraceState) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('command.run', () => ({ text: 'the trace skill' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's-1' }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    let s: TraceState
    try {
      s = status()
    } catch {
      return { value: { exitCode: 1, stdout: '', stderr: 'trace hook: out of time', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: s ? JSON.stringify(s) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return runs
}

const text = (re: RegExp) => ({ type: 'Text', text: re }) as const

test('the band shows the issue, the step reached, the docs and the PR with its CI, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, () => AT_UPDATE)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(runs[0]?.argv.slice(-2)).toEqual([expect.stringMatching(/\/scripts\/hook\.mjs$/), 'status'])
  expect(JSON.parse(runs[0]?.stdin ?? '{}')).toEqual({ cwd: '/repo', session_id: 's-1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find(text(/#10 Trace band and \/trace command/)))?.text).toBeDefined()
    expect((await ui.find(text(/✓ read · .*✓ review · ▸ update · close/)))?.text).toBeDefined()
    expect((await ui.find(text(/docs read/)))?.text).toBeDefined()
    expect((await ui.find(text(/PR #21 CI failing/)))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('the band names each CI state, no PR, and the trace done', async ($, on) => {
  const clock = mock.clock(on)
  let status: TraceStatus = AT_UPDATE
  engine(on, () => status)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const cases: [TraceStatus, RegExp][] = [
    [{ ...AT_UPDATE, pr: { ...AT_UPDATE.pr!, ci: 'passing' } }, /PR #21 CI passing/],
    [{ ...AT_UPDATE, pr: { ...AT_UPDATE.pr!, ci: 'pending' } }, /PR #21 CI pending/],
    [{ ...AT_UPDATE, pr: { ...AT_UPDATE.pr!, ci: 'none', checks: [] } }, /PR #21 CI none/],
    [{ ...AT_UPDATE, step: 'review', done: ['read', 'track', 'branch', 'implement'], pr: null }, /▸ review · .*no PR/],
    [{ ...AT_UPDATE, step: 'done', why: null, done: ['read', 'track', 'branch', 'implement', 'review', 'update', 'close'], pr: { ...AT_UPDATE.pr!, state: 'MERGED', ci: 'passing' } }, /✓ update · ✓ close · .*PR #21 CI passing/],
  ]
  for (const [s, re] of cases) {
    status = s
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(5_000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find(text(re)))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('on a narrow row the band shortens the pipeline, so the docs and the PR stay in view', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, () => AT_UPDATE)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 80 }, surface: 'terminal' })
  expect((await ui.find(text(/^▸ update \(5\/7 done\) · docs read · PR #21 CI failing$/)))?.text).toBeDefined()
  await ui.unmount()
})

test('off an issue branch the band names the step the gates ask for', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, () => ({ ...AT_UPDATE, step: 'branch', why: 'this is the default branch (main). Branch step: work on the issue branch.', done: [], issue: null, docs: null, comment: null, pr: null }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(text(/Branch step: work on the issue branch/)))?.text).toBeDefined()
  expect(await ui.find(text(/engine/))).toBeUndefined()
  await ui.unmount()
})

test('in a repository that has not opted in, or under a survey, the band yields', async ($, on) => {
  const clock = mock.clock(on)
  let status: TraceStatus | null = null
  engine(on, () => status)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const untraced = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await untraced.find(text(/engine/)))?.text).toBe('engine')
  expect(await untraced.find(text(/trace/))).toBeUndefined()
  await untraced.unmount()

  status = AT_UPDATE
  await $.classic.SessionStart({ source: 'compact' })
  await clock.advance(5_000)
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect((await survey.find(text(/engine/)))?.text).toBe('engine')
  await survey.unmount()
})

test('the band follows the trace: a tool call that completes a step moves it, at most once per few seconds', async ($, on) => {
  const clock = mock.clock(on)
  let status: TraceStatus = { ...AT_UPDATE, step: 'read', done: ['track', 'branch'], docs: 'unread', pr: null }
  const runs = engine(on, () => status)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(text(/▸ read/)))?.text).toBeDefined()
  expect((await ui.find(text(/docs unread/)))?.text).toBeDefined()
  status = { ...status, step: 'implement', done: ['read', 'track', 'branch'], docs: 'read' }
  await $.tool.call({ tool: 'Read', file_path: '/repo/GLOSSARY.md' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/adr/0005.md' })
  await clock.advance(0)
  expect(runs).toHaveLength(1)
  await clock.advance(5_000)
  expect(runs).toHaveLength(2)
  expect((await ui.find(text(/✓ read · .*▸ implement/)))?.text).toBeDefined()
  await ui.unmount()
})

test('while CI is pending the band asks again, idle or not', async ($, on) => {
  const clock = mock.clock(on)
  let status: TraceStatus = { ...AT_UPDATE, pr: { ...AT_UPDATE.pr!, ci: 'pending' } }
  const runs = engine(on, () => status)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  status = { ...AT_UPDATE, pr: { ...AT_UPDATE.pr!, ci: 'passing' } }
  await clock.advance(60_000)
  expect(runs).toHaveLength(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(text(/PR #21 CI passing/)))?.text).toBeDefined()
  await ui.unmount()
  await clock.advance(120_000)
  expect(runs).toHaveLength(2)
})

test('a failed status run keeps the band as it was, and /trace says it could not be read', async ($, on) => {
  const clock = mock.clock(on)
  let fail = false
  engine(on, () => {
    if (fail) throw new Error('out of time')
    return AT_UPDATE
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  fail = true
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(text(/▸ update/)))?.text).toBeDefined()
  await ui.unmount()
  expect((await $.command.run(TRACE)).text).toBe('Trace: the status could not be read (trace status exited 1).')
})

test('a halt replaces what the band showed with its reason, and /trace prints it', async ($, on) => {
  const clock = mock.clock(on)
  const halt = 'trace halted the session: git did not answer: git is not on PATH. Restore git, then reply to continue.'
  let s: TraceState = AT_UPDATE
  engine(on, () => s)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  s = { halt }
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find(text(/git did not answer: git is not on PATH\. Restore git, then reply to continue\./)))?.text).toBeDefined()
  expect(await ui.find(text(/▸ update/))).toBeUndefined()
  await ui.unmount()
  expect((await $.command.run(TRACE)).text).toBe(halt)
  s = AT_UPDATE
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.md' })
  await clock.advance(5_000)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await after.find(text(/▸ update/)))?.text).toBeDefined()
  await after.unmount()
})

test('/trace prints the unread docs, the last comment, the latest progress comment and the PR checks', async ($, on) => {
  mock.clock(on)
  engine(on, () => ({
    ...AT_UPDATE,
    step: 'read',
    why: 'the related docs are not all read. Unread: GLOSSARY.md. Read step: read it.',
    docs: 'unread',
    last: { author: 'rocky', at: '2026-10-29T09:00:00Z', body: 'Thanks!', isProgress: false },
  }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run(TRACE)
  expect(text).toMatch(/^Trace: #10 "Trace band and \/trace command" https:\/\/github\.com\/owner\/name\/issues\/10\n/)
  expect(text).toMatch(/\nStep: read \(▸ read · ✓ track · ✓ branch · ✓ implement · ✓ review · update · close\)\n/)
  expect(text).toMatch(/\nthe related docs are not all read\. Unread: GLOSSARY\.md\. Read step: read it\.\n/)
  expect(text).toMatch(/\nLast comment, by rocky on 2026-10-29:\n {2}Thanks!\nLatest progress comment, by claude on 2026-10-28:\n {2}## Progress\n\n {2}The band draws\.\n/)
  expect(text).toMatch(/\nPR #21 \(open\), CI failing: https:\/\/github\.com\/owner\/name\/pull\/21\n {2}✓ test\n {2}✗ lint\n {2}… e2e$/)
})

test('/trace in a repository that has not opted in says so', async ($, on) => {
  mock.clock(on)
  engine(on, () => null)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run(TRACE)
  expect(text).toBe('Trace: this repository has not opted in (no .claude/trace.json), or TRACE_BYPASS=1 is set.')
})

test("/trace typed through Remote Control prints the status; with arguments, or run by the model or the SDK, it is the trace skill's", async ($, on) => {
  mock.clock(on)
  engine(on, () => AT_UPDATE)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TRACE, origin: { kind: 'bridge' } })).text).toMatch(/^Trace: #10 /)
  expect((await $.command.run({ ...TRACE, args: 'which step?' })).text).toBe('the trace skill')
  expect((await $.command.run({ ...TRACE, origin: { kind: 'sdk' } })).text).toBe('the trace skill')
})
