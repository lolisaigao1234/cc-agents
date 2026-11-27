// The band: the trace at a glance above the prompt, and `/trace` for the
// detail (ADR 0005). Both draw what `node scripts/hook.mjs status` prints,
// the state the hooks enforce, and keep none of their own.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TraceComment, TraceHalt, TraceOutcome, TraceState, TraceStatus, TraceStep } from '../types'

const STEPS: TraceStep[] = ['read', 'track', 'branch', 'implement', 'review', 'update', 'close']
// Change the tag when TraceState changes: a reload keeps what was stored.
const status = atom({ plugin: 'trace', key: 'status' } as const, null, { shape: 'status-4' })
// Tool calls after which a step may have completed: a read, a commit, a push, a PR.
const MOVERS = new Set(['Read', 'Bash', 'Edit', 'Write', 'MultiEdit'])
// A status run asks git and GitHub, so while work goes on it runs at most once per GAP.
const GAP = 5_000
// While a PR's CI is pending, the band asks again this often, idle or not.
const RECHECK = 60_000
const UNTRACED = 'Trace: this repository has not opted in (no .claude/trace.json), or TRACE_BYPASS=1 is set.'
const MARK: Record<TraceOutcome, string> = { passing: '✓', failing: '✗', pending: '…' }

/** What the hook script says the trace is, for this session's main agent. */
async function traceStatus($: EngineInterface): Promise<TraceState> {
  const [cwd, session] = await Promise.all([$.session.cwd(), $.session.id()])
  const { exitCode, stdout } = await $.process.run(['node', `${$.plugin.root}/scripts/hook.mjs`, 'status'], {
    stdin: JSON.stringify({ cwd, session_id: session }),
    timeoutMs: 30_000,
  })
  if (exitCode !== 0) throw new Error(`trace status exited ${exitCode}`)
  return stdout.trim() ? (JSON.parse(stdout) as TraceStatus | TraceHalt) : null
}

/** `✓ read · ✓ track · ▸ branch · implement …`: each step, done, current or ahead. */
const pipeline = (s: TraceStatus) => STEPS.map(step => (step === s.step ? `▸ ${step}` : s.done.includes(step) ? `✓ ${step}` : step)).join(' · ')

/** `2 commits`, counted. */
const commits = (n: number) => (n === 1 ? '1 commit' : `${n} commits`)

/** What the last recorded review leaves unreviewed, in a few words; null when the head is reviewed. */
function unreviewed(review: NonNullable<TraceStatus['review']>): string | null {
  if (review.unreviewed === 0) return null
  if (review.sha === null) return 'no review recorded'
  return review.unreviewed === null ? `review of ${review.sha.slice(0, 7)} is off this branch` : `${commits(review.unreviewed)} unreviewed`
}

/** The same in full, for `/trace`. */
function reviewLine({ sha, unreviewed: n }: NonNullable<TraceStatus['review']>): string {
  if (sha === null) return 'Review: no review is recorded on the issue.'
  const at = sha.slice(0, 7)
  if (n === null) return `Review: the last review covered ${at}, which is not in this branch's history: all of it is unreviewed.`
  if (n === 0) return `Review: the head is the commit the last review covered (${at}).`
  return `Review: ${commits(n)} since ${at}, the commit the last review covered, ${n === 1 ? 'is' : 'are'} unreviewed.`
}

/** A why on one line, for a band of one row. */
const oneLine = (why: string) => why.replace(/\s+/g, ' ')

/** A comment's heading and its body, indented. */
const quote = (what: string, c: TraceComment) => [`${what}, by ${c.author}${c.at ? ` on ${c.at.slice(0, 10)}` : ''}:`, c.body.split('\n').map(l => (l ? `  ${l}` : '')).join('\n')]

// One status run at a time; asks made meanwhile fold into one more run.
let running = false
let again = false
// When the last run started, whether an ask waits out the GAP, and whether a recheck is set.
let started = -Infinity
let waiting = false
let rechecking = false

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
      started = await $.clock.now()
      const next = await traceStatus($).catch(() => undefined)
      if (next !== undefined) {
        await update($, status, () => next)
        recheck($, next)
      }
    } while (again)
  } finally {
    running = false
  }
}

/** Refreshes after the GAP since the last run; asks made while it waits are covered by it. */
async function throttled($: EngineInterface) {
  if (waiting) return
  waiting = true
  try {
    const wait = started + GAP - (await $.clock.now())
    if (wait > 0) await $.clock.sleep(wait)
  } finally {
    waiting = false
  }
  await refresh($)
}

/** Refreshes once the hook that asked has returned, so no turn waits on it. */
function soon($: EngineInterface) {
  $.clock.after(0, () => void throttled($))
}

/** While CI is pending, asks again in a while: nothing else moves the band while the session is idle. */
function recheck($: EngineInterface, s: TraceState) {
  if (rechecking || !s || 'halt' in s || s.pr?.state !== 'OPEN' || s.pr.ci !== 'pending') return
  rechecking = true
  $.clock.after(RECHECK, () => {
    rechecking = false
    soon($)
  })
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    soon($)
    return next(e)
  })

  // /clear and /compact forget the reads; a worktree or `cd` changes the repository.
  on('classic.SessionStart', ($, e, next) => {
    soon($)
    return next(e)
  })
  on('classic.PostCompact', ($, e, next) => {
    soon($)
    return next(e)
  })
  on('classic.CwdChanged', ($, e, next) => {
    soon($)
    return next(e)
  })

  // A prompt may lift a halt (the hooks' UserPromptSubmit), so the band reads again once those hooks ran.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const ran = await next(e)
    soon($)
    return ran
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

  // `/trace` is the plugin's trace skill. Typed bare by the person, at the
  // terminal or through Remote Control, it prints the status; with
  // arguments, or run by the model, the SDK or a plugin, it is the skill.
  on('command.run', { command: 'trace:trace' }, async ($, e, next) => {
    if ((e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') || e.args.trim()) return next(e)
    let s: TraceState
    try {
      s = await traceStatus($)
    } catch (err) {
      return { text: `Trace: the status could not be read (${err instanceof Error ? err.message : String(err)}).` }
    }
    await update($, status, () => s)
    if (!s) return { text: UNTRACED }
    if ('halt' in s) return { text: s.halt }
    const lines = [
      s.issue ? `Trace: #${s.issue.n} "${s.issue.title}"${s.issue.url ? ` ${s.issue.url}` : ''}` : 'Trace: no linked issue',
      `Step: ${s.step} (${pipeline(s)})`,
      ...(s.why ? [s.why] : []),
      ...(s.docs === 'read' ? ['Docs: every related doc is read.'] : []),
      ...(s.review ? [reviewLine(s.review)] : []),
      ...(s.last ? quote('Last comment', s.last) : []),
      ...(s.comment ? quote(s.comment.isProgress ? 'Latest progress comment' : 'Last comment', s.comment) : []),
      ...(s.pr ? [`PR #${s.pr.n} (${s.pr.state.toLowerCase()}), CI ${s.pr.ci}: ${s.pr.url}`, ...s.pr.checks.map(c => `  ${MARK[c.outcome]} ${c.name}`)] : []),
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, status)
    if (e.props.hasSurvey || !s) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // A halt shows whole, in place of the trace it stopped.
    if ('halt' in s) {
      return (
        <Box>
          <Text wrap="wrap">
            <Text bold>trace</Text> <Text color="error">{oneLine(s.halt.replace(/^trace:? /, ''))}</Text>
          </Text>
        </Box>
      )
    }
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
    const docs = `docs ${s.docs ?? 'unknown'}`
    const pr = s.pr ? `PR #${s.pr.n} CI ${s.pr.ci}` : 'no PR'
    // An open PR is what a review holds up: beside it, what the last recorded review leaves unreviewed.
    const left = s.pr?.state === 'OPEN' && s.review ? unreviewed(s.review) : null
    // The whole pipeline when the row has room for it beside the docs, the PR and that.
    const steps = pipeline(s)
    const shown = steps.length + docs.length + pr.length + 6 + (left ? left.length + 3 : 0) <= e.props.bodyColumns ? steps : `▸ ${s.step} (${s.done.length}/${STEPS.length} done)`
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>trace</Text> #{s.issue.n} {s.issue.title}
        </Text>
        <Text wrap="truncate-end">
          {shown}
          <Text dimColor> · </Text>
          <Text color={s.docs === 'read' ? 'success' : 'warning'}>{docs}</Text>
          <Text dimColor> · </Text>
          <Text color={ci}>{pr}</Text>
          {left ? <Text dimColor> · </Text> : null}
          {left ? <Text color="warning">{left}</Text> : null}
        </Text>
      </Box>
    )
  })
}
