// The band: the trace at a glance above the prompt, and `/trace` for the
// detail (ADR 0005). Both draw what `node scripts/hook.mjs status` prints,
// the state the hooks enforce, and keep none of their own.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TraceStatus, TraceStep } from '../types'

const STEPS: TraceStep[] = ['read', 'track', 'branch', 'implement', 'review', 'update', 'close']
// Change the tag when TraceStatus changes: a reload keeps what was stored.
const status = atom({ plugin: 'trace', key: 'status' } as const, null, { shape: 'status-1' })
// Tool calls after which a step may have completed: a read, a commit, a push, a PR.
const MOVERS = new Set(['Read', 'Bash', 'Edit', 'Write', 'MultiEdit'])
const UNTRACED = 'Trace: this repository has not opted in (no .claude/trace.json), or TRACE_BYPASS=1 is set.'

/** What the hook script says the trace is, for this session's main agent. */
async function traceStatus($: EngineInterface): Promise<TraceStatus | null> {
  const [cwd, session] = await Promise.all([$.session.cwd(), $.session.id()])
  const { exitCode, stdout } = await $.process.run(['node', `${$.plugin.root}/scripts/hook.mjs`, 'status'], {
    stdin: JSON.stringify({ cwd, session_id: session }),
    timeoutMs: 30_000,
  })
  if (exitCode !== 0) throw new Error(`trace status exited ${exitCode}`)
  return stdout.trim() ? (JSON.parse(stdout) as TraceStatus) : null
}

/** `✓ read · ✓ track · ▸ branch · implement …`: each step, done, current or ahead. */
const pipeline = (s: TraceStatus) => STEPS.map(step => (step === s.step ? `▸ ${step}` : s.done.includes(step) ? `✓ ${step}` : step)).join(' · ')

/** A why on one line, for a band of one row. */
const oneLine = (why: string) => why.replace(/\s+/g, ' ')

// One status run at a time; asks made meanwhile fold into one more run.
let running = false
let again = false

/** Reads the status again into the band's state; a failed read keeps the last one. */
async function refresh($: EngineInterface) {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      const next = await traceStatus($).catch(() => undefined)
      if (next !== undefined) await update($, status, () => next)
    } while (again)
  } finally {
    running = false
  }
}

/** Refreshes once the hook that asked has returned, so no turn waits on it. */
function soon($: EngineInterface) {
  $.clock.after(0, () => void refresh($))
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    soon($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    soon($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (MOVERS.has(String(e.tool))) soon($)
    return ran
  })

  // `/trace` is the plugin's trace skill. Typed bare by the person, it prints
  // the status; with arguments, or run by anyone else, it is the skill.
  on('command.run', { command: 'trace:trace' }, async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.args.trim()) return next(e)
    let s: TraceStatus | null
    try {
      s = await traceStatus($)
    } catch (err) {
      return { text: `Trace: the status could not be read (${err instanceof Error ? err.message : String(err)}).` }
    }
    await update($, status, () => s)
    if (!s) return { text: UNTRACED }
    const lines = [
      s.issue ? `Trace: #${s.issue.n} "${s.issue.title}"${s.issue.url ? ` ${s.issue.url}` : ''}` : 'Trace: no linked issue',
      `Step: ${s.step} (${pipeline(s)})`,
      ...(s.why ? [s.why] : []),
      ...(s.docs === 'read' ? ['Docs: every related doc is read.'] : []),
      ...(s.comment ? [`Latest ${s.comment.isProgress ? 'progress ' : ''}comment, by ${s.comment.author}${s.comment.at ? ` on ${s.comment.at.slice(0, 10)}` : ''}:`, s.comment.body.split('\n').map(l => (l ? `  ${l}` : '')).join('\n')] : []),
      ...(s.pr
        ? [`PR #${s.pr.n} (${s.pr.state.toLowerCase()}), CI ${s.pr.ci}: ${s.pr.url}`, ...s.pr.checks.map(c => `  ${c.state === 'SUCCESS' || c.state === 'NEUTRAL' || c.state === 'SKIPPED' ? '✓' : c.state === 'PENDING' ? '…' : '✗'} ${c.name}`)]
        : []),
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, status)
    if (e.props.hasSurvey || !s) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (!s.issue) {
      return (
        <Box>
          <Text wrap="truncate-end">
            <Text bold>trace</Text> {oneLine(s.why ?? `step: ${s.step}`)}
          </Text>
        </Box>
      )
    }
    const ci = s.pr ? ({ passing: 'success', failing: 'error', pending: 'warning', none: 'subtle' } as const)[s.pr.ci] : 'subtle'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>trace</Text> #{s.issue.n} {s.issue.title}
        </Text>
        <Text wrap="truncate-end">
          {pipeline(s)}
          <Text dimColor> · </Text>
          <Text color={s.docs === 'read' ? 'success' : 'warning'}>docs {s.docs ?? 'unknown'}</Text>
          <Text dimColor> · </Text>
          <Text color={ci}>{s.pr ? `PR #${s.pr.n} CI ${s.pr.ci}` : 'no PR'}</Text>
        </Text>
      </Box>
    )
  })
}
