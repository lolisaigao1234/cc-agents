import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'quality-loop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
} as const

const STATE_PATH = '/work/.quality-loop/state.json'

// The test runner's own timer, to let the mod's after-turn timer run.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10))

/** A loop state as ql writes it, cut down to what the band reads. */
function loopState(over: Record<string, unknown> = {}) {
  return {
    status: 'active',
    mode: 'review',
    round: 1,
    goal: 'checks pass and nothing important open',
    baseCommit: 'abc123',
    statusReasons: [],
    config: { loop: { maxRounds: 3, maxContextTokens: 300000 }, review: {} },
    ledger: {
      findings: {
        F1: { id: 'F1', status: 'candidate', origin: 'introduced', severity: 'important' },
        F2: { id: 'F2', status: 'confirmed', origin: 'introduced', severity: 'important' },
      },
    },
    rounds: [{ n: 1, ended: false, ingests: 2 }],
    lastRun: { results: [{ ok: true }, { ok: true }, { ok: false }] },
    ...over,
  }
}

type On = Parameters<TestBody>[1]

/** Stands in for the engine: a session in /work/sub, with or without a loop. */
function engine(on: On, files: { state: string | null }, toasts: string[], context = { tokens: 120000, compactions: [] as string[] }) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: context.tokens, window: 1000000 }, rateLimits: [] } }))
  on('clock.after', () => ({ value: undefined }))
  on('session.compact', (_, e) => {
    context.compactions.push(String(e.instructions))
    context.tokens = 40000
    return { messages: [{ role: 'user', text: 'summary', toolUses: [], toolResults: [] }], tokensBefore: 320000, tokensAfter: 40000 } as any
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/sub' }))
  on('command.register', () => ({ value: { command: 'loop-status' } }))
  on('fs.exists', (_, e) => ({ value: files.state !== null && e.path === STATE_PATH }))
  on('fs.read', (_, e) => {
    if (e.path !== STATE_PATH || files.state === null) throw new Error('ENOENT')
    return { value: files.state }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
}

test('the band follows the loop from the state file above the session directory', async ($, on) => {
  const files = { state: JSON.stringify(loopState()) as string | null }
  const toasts: string[] = []
  engine(on, files, toasts)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/work/sub', surface: 'terminal', isInteractive: true } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    const row = await ui.find({ type: 'Text', text: /quality-loop review/ })
    expect(row?.text).toContain('round 1/3 · verify')
    expect(row?.text).toContain('1 important open')
    expect(row?.text).toContain('1 to verify')
    expect(row?.text).toContain('checks 2/3')
    expect(row?.text).toContain('ctx 120k/300k')
    await ui.unmount()
  }

  // The loop finishes: the next turn's end redraws the band and toasts the change.
  files.state = JSON.stringify(
    loopState({ status: 'done', statusReasons: ['all required checks pass'], ledger: { findings: {} }, rounds: [{ n: 1, ended: true }] }),
  )
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /quality-loop/ }))?.text).toContain('done after 1 round(s)')
  expect(toasts).toEqual(['quality-loop: active → done (all required checks pass)'])

  // A finished loop's band can be hidden.
  await ui.press({ key: 'hide' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('with no loop the band yields to the engine', async ($, on) => {
  engine(on, { state: null }, [])
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/work/sub', surface: 'terminal', isInteractive: true } as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('/loop-status prints the status, reasons and next action', async ($, on) => {
  const files = { state: JSON.stringify(loopState({ status: 'capped', statusReasons: ['round cap (3) reached'] })) as string | null }
  engine(on, files, [])
  await $.session.start({ cwd: '/work/sub', surface: 'terminal', isInteractive: true } as any)
  const { text } = await $.command.run({ command: 'loop-status', args: '' } as any)
  expect(text).toContain('quality-loop review · capped')
  expect(text).toContain('round cap (3) reached')
  expect(text).toContain('Next: Loop finished (capped)')

  files.state = null
  const none = await $.command.run({ command: 'loop-status', args: '' } as any)
  expect(none.text).toContain('No quality loop')
})

test('past the context cap the session compacts once the turn has ended, keeping the loop', async ($, on) => {
  const context = { tokens: 120000, compactions: [] as string[] }
  const toasts: string[] = []
  engine(on, { state: JSON.stringify(loopState()) }, toasts, context)
  await $.session.start({ cwd: '/work/sub', surface: 'terminal', isInteractive: true } as any)

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  expect(context.compactions).toEqual([])

  // A subagent's turn is its own window: its frontmatter caps it.
  context.tokens = 320000
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
  expect(context.compactions).toEqual([])

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  await settle()
  expect(context.compactions.length).toBe(1)
  expect(context.compactions[0]).toContain('.quality-loop/LOOP.md')
  expect(toasts.some(t => t.includes('compacted at 320k'))).toBe(true)

  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  await settle()
  expect(context.compactions.length).toBe(1)
})

test('with the cap off, nothing compacts', async ($, on) => {
  const context = { tokens: 900000, compactions: [] as string[] }
  engine(on, { state: JSON.stringify(loopState({ config: { loop: { maxRounds: 3, maxContextTokens: null }, review: {} } })) }, [], context)
  await $.session.start({ cwd: '/work/sub', surface: 'terminal', isInteractive: true } as any)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
  await settle()
  expect(context.compactions).toEqual([])
})
