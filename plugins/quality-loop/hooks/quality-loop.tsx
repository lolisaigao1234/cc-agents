// The quality-loop mod: keeps the loop visible while it runs. A band above
// the prompt shows the round, phase, open findings and checks; `/loop-status`
// prints where the loop is and what comes next; a toast marks each change of
// status. Enforcement (guard, stop continuation, context re-injection) lives
// in the classic hooks beside this module, so it also works without mods.
// Past the context cap (`loop.maxContextTokens`) it compacts the session
// between turns: a backstop for Claude Code's own auto-compaction, which
// `ql start` sets to the same cap (scripts/lib/compact.mjs).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { counts, nextAction, phaseOf, statusLine } from '../scripts/lib/report.mjs'
import type { LoopSnapshot } from '../types'

const snapshot = atom({ plugin: 'quality-loop', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const isHidden = atom({ plugin: 'quality-loop', key: 'isHidden' } as const, false)

const STATE_FILE = '.quality-loop/state.json'
const MAX_DEPTH = 8

const COMPACT_INSTRUCTIONS =
  "Keep the user's request, the finish line and every decision or constraint they gave, the files changed, and the quality loop's position (mode, round, phase, open finding ids). .quality-loop/LOOP.md is re-injected after this compaction and holds the loop's full state: point to it rather than copying it."

/** One compaction at a time; a cap compaction cannot get under stops further tries. */
let compaction: { isRunning: boolean; isFutile: boolean } = { isRunning: false, isFutile: false }

/** The nearest state file at or above the session's directory. */
async function findStateFile($: EngineInterface): Promise<string | null> {
  let dir = (await $.session.cwd()).replace(/\/+$/, '')
  for (let i = 0; i < MAX_DEPTH && dir; i++) {
    const candidate = `${dir}/${STATE_FILE}`
    if (await $.fs.exists(candidate)) return candidate
    const up = dir.slice(0, dir.lastIndexOf('/'))
    if (up === dir) break
    dir = up
  }
  return null
}

export function toSnapshot(s: any, contextTokens: number | null = null): LoopSnapshot {
  const c = counts(s)
  const cap = s.config?.loop?.maxContextTokens
  const results: { ok: boolean }[] = s.lastRun?.results ?? []
  return {
    status: String(s.status),
    mode: String(s.mode),
    round: Number(s.round ?? 0),
    maxRounds: Number(s.config?.loop?.maxRounds ?? 0),
    phase: phaseOf(s),
    important: c.important,
    nit: c.nit,
    pending: c.pending,
    fixed: c.fixed,
    stuck: c.stuck,
    checksPassing: results.filter(r => r.ok).length,
    checksTotal: results.length,
    reasons: Array.isArray(s.statusReasons) ? s.statusReasons.map(String) : [],
    line: statusLine(s),
    next: nextAction(s),
    contextCap: typeof cap === 'number' && cap > 0 ? cap : null,
    contextTokens,
  }
}

async function contextTokens($: EngineInterface): Promise<number | null> {
  try {
    return (await $.session.usage()).context.tokens ?? null
  } catch {
    return null
  }
}

const k = (n: number) => `${Math.round(n / 1000)}k`

/** Compacts the main conversation once a turn has left it past the cap. */
function compactPastCap($: EngineInterface, s: LoopSnapshot | null): void {
  if (!s?.contextCap || s.contextTokens === null || s.contextTokens < s.contextCap) return
  if (compaction.isRunning || compaction.isFutile) return
  compaction.isRunning = true
  const before = s.contextTokens
  const cap = s.contextCap
  // After the turn: compaction is refused while one runs.
  $.clock.after(0, async () => {
    try {
      const r = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      if (r.skip !== undefined) return
      const after = r.tokensAfter ?? (await contextTokens($))
      if (after !== null && after >= cap) compaction.isFutile = true
      $.ui.toast(`quality-loop: compacted at ${k(before)} tokens (cap ${k(cap)})${after !== null ? ` → ${k(after)}` : ''}`, { timeoutMs: 8000 })
      await refresh($)
    } catch {
      // A turn started first: the next turn's end tries again.
    } finally {
      compaction.isRunning = false
    }
  })
}

async function refresh($: EngineInterface): Promise<void> {
  const file = await findStateFile($)
  let next: LoopSnapshot | null = null
  if (file) {
    try {
      next = toSnapshot(JSON.parse(await $.fs.read(file)), await contextTokens($))
    } catch {
      // A state file caught mid-write reads again on the next event.
      return
    }
  }
  const prev = await read($, snapshot)
  if (prev?.status !== next?.status && next) {
    if (prev) $.ui.toast(`quality-loop: ${prev.status} → ${next.status}${next.reasons[0] ? ` (${next.reasons[0]})` : ''}`, { timeoutMs: 8000 })
    // A new status is news: show the band again.
    await update($, isHidden, () => false)
  }
  await update($, snapshot, () => next)
}

const COLOR: Record<string, string> = { active: 'cyan', done: 'green', paused: 'magenta', capped: 'yellow', stalled: 'yellow', aborted: 'gray' }
const MARK: Record<string, string> = { active: '◆', done: '✓', paused: '‖', capped: '■', stalled: '■', aborted: '×' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loop-status', description: 'Show where the quality loop is and what it does next' })
    const result = await next(e)
    await refresh($)
    return result
  })

  on('command.run', { command: 'loop-status' }, async $ => {
    await refresh($)
    const s = await read($, snapshot)
    if (!s) return { text: 'No quality loop in this repository. Start one with /quality-loop:improve or /quality-loop:debug.' }
    await update($, isHidden, () => false)
    return { text: [s.line, ...s.reasons.map(r => `  - ${r}`), `Next: ${s.next}`].join('\n') }
  })

  // ql commands change the state mid-turn: redraw right after each one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bql(?:\.mjs)?\b/.test(String(e.command ?? ''))) await refresh($)
    return ran
  }).catch(($, e, next) => next(e)) // an observer: a failure here never blocks the command

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's own window is capped by its frontmatter.
    if (e.agentId !== undefined) return result
    await refresh($)
    compactPastCap($, await read($, snapshot))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (!s || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const color = COLOR[s.status] ?? 'white'
    const parts = [
      `${MARK[s.status] ?? '◆'} quality-loop ${s.mode}`,
      s.status === 'active' ? `round ${s.round}/${s.maxRounds} · ${s.phase}` : `${s.status} after ${s.round} round(s)`,
      `${s.important} important open`,
      s.pending ? `${s.pending} to verify` : '',
      s.fixed ? `${s.fixed} fixed` : '',
      s.stuck ? `${s.stuck} stuck` : '',
      s.checksTotal ? `checks ${s.checksPassing}/${s.checksTotal}` : '',
      s.contextCap && s.contextTokens !== null ? `ctx ${k(s.contextTokens)}/${k(s.contextCap)}` : '',
    ].filter(Boolean)
    const width = Math.max(20, (e.props.bodyColumns ?? 80) - 10)
    const text = parts.join(' · ')
    return (
      <Box paddingX={1}>
        <Text color={color} bold={s.status !== 'active'}>
          {text.length > width ? `${text.slice(0, width - 1)}…` : text}{' '}
        </Text>
        {s.status !== 'active' && <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />}
      </Box>
    )
  })
}
