// The band's contract: the trace's status as `node scripts/hook.mjs status`
// prints it (scripts/lib/status.mjs), kept in `$.state` for the band to draw.

export type TraceStep = 'read' | 'track' | 'branch' | 'implement' | 'review' | 'update' | 'close'

export type TraceComment = { author: string; at: string; body: string; isProgress: boolean }

export type TraceOutcome = 'passing' | 'failing' | 'pending'

export type TraceStatus = {
  step: TraceStep | 'done'
  why: string | null
  done: TraceStep[]
  issue: { n: number; title: string; url: string | null } | null
  docs: 'read' | 'unread' | null
  comment: TraceComment | null
  last: TraceComment | null
  pr: {
    n: number
    url: string
    state: 'OPEN' | 'MERGED' | 'CLOSED'
    ci: TraceOutcome | 'none'
    checks: { name: string; state: string; outcome: TraceOutcome }[]
  } | null
}

/** A halt of the session, or git or GitHub not answering the status itself: what failed, and what to restore (scripts/lib/halt.mjs). */
export type TraceHalt = { halt: string }

/** What the status prints: nothing (null) outside a traced repository and under the bypass. */
export type TraceState = TraceStatus | TraceHalt | null

declare module 'claude-code' {
  interface PluginState {
    trace: { status: Shaped<TraceState> }
  }
}
