import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TraceStatus } from '../types'

const BAND = {
  plugin: 'trace',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// `/trace` as the person types it at the prompt: the plugin's trace skill's
// name, which the band answers with the status.
const TRACE = { command: 'trace:trace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const AT_REVIEW: TraceStatus = {
  step: 'update',
  why: 'commits were pushed to 10-trace-band after the last comment on #10. Update step: post a progress comment on #10.',
  done: ['read', 'track', 'branch', 'implement', 'review'],
  issue: { n: 10, title: 'Trace band and /trace command', url: 'https://github.com/owner/name/issues/10' },
  docs: 'read',
  comment: { author: 'claude', at: '2026-10-28T10:00:00Z', body: '## Progress\n\nThe band draws.', isProgress: true },
  pr: {
    n: 21,
    url: 'https://github.com/owner/name/pull/21',
    state: 'OPEN',
    ci: 'failing',
    checks: [
      { name: 'test', state: 'SUCCESS' },
      { name: 'lint', state: 'FAILURE' },
      { name: 'e2e', state: 'PENDING' },
    ],
  },
}

/**
 * Stands for the engine: a session in /repo whose `node hook.mjs status`
 * prints `status` (nothing for null), and what each run was asked.
 */
function engine(on: On, status: () => TraceStatus | null) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('command.run', () => ({ text: 'the trace skill' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's-1' }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const s = status()
    return { value: { exitCode: 0, stdout: s ? JSON.stringify(s) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return runs
}

test('the band shows the issue, the step reached, the docs and the PR with its CI, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, () => AT_REVIEW)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(runs[0]?.argv.slice(-2)).toEqual([expect.stringMatching(/\/scripts\/hook\.mjs$/), 'status'])
  expect(JSON.parse(runs[0]?.stdin ?? '{}')).toEqual({ cwd: '/repo', session_id: 's-1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /#10 Trace band and \/trace command/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /✓ read · .*✓ review · ▸ update · close/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /docs read/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /PR #21 CI failing/ }))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('off an issue branch the band names the step the gates ask for', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, () => ({ ...AT_REVIEW, step: 'branch', why: 'this is the default branch (main). Branch step: work on the issue branch.', done: [], issue: null, docs: null, comment: null, pr: null }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Branch step: work on the issue branch/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await ui.unmount()
})

test('in a repository that has not opted in, the band yields', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, () => null)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /trace/ })).toBeUndefined()
  await ui.unmount()
})

test('the band follows the trace: a turn that completes a step moves it', async ($, on) => {
  const clock = mock.clock(on)
  let status: TraceStatus = { ...AT_REVIEW, step: 'read', done: ['track', 'branch'], docs: 'unread', pr: null }
  engine(on, () => status)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /▸ read/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /docs unread/ }))?.text).toBeDefined()
  status = { ...status, step: 'implement', done: ['read', 'track', 'branch'], docs: 'read' }
  await $.tool.call({ tool: 'Read', file_path: '/repo/GLOSSARY.md' })
  await clock.advance(0)
  expect((await ui.find({ type: 'Text', text: /✓ read · .*▸ implement/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('/trace prints the unread docs, the latest progress comment and the PR checks', async ($, on) => {
  mock.clock(on)
  engine(on, () => ({ ...AT_REVIEW, step: 'read', why: 'the related docs are not all read. Unread: GLOSSARY.md. Read step: read it.', docs: 'unread' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run(TRACE)
  expect(text).toMatch(/^Trace: #10 "Trace band and \/trace command" https:\/\/github\.com\/owner\/name\/issues\/10\n/)
  expect(text).toMatch(/\nStep: read \(▸ read · ✓ track · ✓ branch · ✓ implement · ✓ review · update · close\)\n/)
  expect(text).toMatch(/\nthe related docs are not all read\. Unread: GLOSSARY\.md\. Read step: read it\.\n/)
  expect(text).toMatch(/\nLatest progress comment, by claude on 2026-10-28:\n {2}## Progress\n\n {2}The band draws\.\n/)
  expect(text).toMatch(/\nPR #21 \(open\), CI failing: https:\/\/github\.com\/owner\/name\/pull\/21\n {2}✓ test\n {2}✗ lint\n {2}… e2e$/)
})

test('/trace in a repository that has not opted in says so', async ($, on) => {
  mock.clock(on)
  engine(on, () => null)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run(TRACE)
  expect(text).toBe('Trace: this repository has not opted in (no .claude/trace.json), or TRACE_BYPASS=1 is set.')
})

test("/trace with arguments, or run by anyone but the person, is the trace skill's", async ($, on) => {
  mock.clock(on)
  engine(on, () => AT_REVIEW)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ ...TRACE, args: 'which step?' })).text).toBe('the trace skill')
  expect((await $.command.run({ ...TRACE, origin: { kind: 'sdk' } })).text).toBe('the trace skill')
})
