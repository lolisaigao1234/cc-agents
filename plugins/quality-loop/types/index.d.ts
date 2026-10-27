export type LoopSnapshot = {
  status: string
  mode: string
  round: number
  maxRounds: number
  phase: string
  important: number
  nit: number
  pending: number
  fixed: number
  stuck: number
  checksPassing: number
  checksTotal: number
  reasons: string[]
  line: string
  next: string
  /** loop.maxContextTokens, or null when there is no cap */
  contextCap: number | null
  /** The main conversation's context at the last refresh, when known */
  contextTokens: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'quality-loop': {
      snapshot: Shaped<LoopSnapshot | null>
      isHidden: boolean
    }
  }
}
