// full-send's merge gate (ADR 0004): from a PR as `gh pr view --json` reports
// it, decide whether to merge, wait, fix or stop for a human. The gate is
// CI: every check on the head must pass. People are not waited for, and a
// rule that demands one is reported, never bypassed. Pure.

/**
 * @typedef {'MERGE' | 'WAIT' | 'FIX' | 'BLOCKED' | 'MERGED'} Verdict
 * @typedef {{ name: string, url: string, result: 'pass' | 'fail' | 'pending', detail: string }} Check
 * @typedef {{
 *   state: string, isDraft?: boolean, mergeable?: string, mergeStateStatus?: string,
 *   headRefOid: string, statusCheckRollup?: any[], url?: string,
 * }} PullRequest
 * @typedef {{ failedHeads: string[], headSeenAt: Record<string, number>, merging: string | null }} ShipState
 * @typedef {{ requireChecks: boolean, checksGraceSec: number, maxFixAttempts: number }} ShipConfig
 */

const PASS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const PENDING_STATES = ['PENDING', 'EXPECTED']

/**
 * One line per check on the head: check runs (GitHub Actions and apps) and
 * commit statuses alike.
 *
 * @param {any[]} rollup
 * @returns {Check[]}
 */
export function classifyChecks(rollup) {
  return rollup.map(c => {
    if (c.__typename === 'StatusContext' || ('context' in c && !('conclusion' in c))) {
      const state = String(c.state ?? '').toUpperCase()
      return {
        name: String(c.context ?? 'status'),
        url: String(c.targetUrl ?? ''),
        result: state === 'SUCCESS' ? 'pass' : PENDING_STATES.includes(state) || !state ? 'pending' : 'fail',
        detail: state.toLowerCase(),
      }
    }
    const status = String(c.status ?? '').toUpperCase()
    const conclusion = String(c.conclusion ?? '').toUpperCase()
    const name = c.workflowName && c.workflowName !== c.name ? `${c.workflowName} / ${c.name}` : String(c.name ?? 'check')
    return {
      name,
      url: String(c.detailsUrl ?? ''),
      result: status !== 'COMPLETED' ? 'pending' : PASS.includes(conclusion) ? 'pass' : 'fail',
      detail: (status !== 'COMPLETED' ? status : conclusion).toLowerCase(),
    }
  })
}

/**
 * @param {{ pr: PullRequest, localHead: string | null, ship: ShipState, now: number, config: ShipConfig }} i
 * @returns {{ verdict: Verdict, reasons: string[], checks: Check[], failedHeads: string[] }}
 */
export function decideGate(i) {
  const { pr, ship, config } = i
  const head = pr.headRefOid
  const checks = classifyChecks(pr.statusCheckRollup ?? [])
  let failedHeads = ship.failedHeads
  /** @param {Verdict} verdict @param {string[]} reasons */
  const out = (verdict, ...reasons) => ({ verdict, reasons, checks, failedHeads })
  const state = String(pr.state).toUpperCase()
  const merge = String(pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase()
  const mergeable = String(pr.mergeable ?? 'UNKNOWN').toUpperCase()

  if (state === 'MERGED') return out('MERGED', 'the PR is merged')
  if (state === 'CLOSED') return out('BLOCKED', 'the PR was closed without merging: reopening it is the user\'s call')
  if (pr.isDraft) return out('FIX', 'the PR is a draft: mark it ready (`gh pr ready`) so it can merge')
  if (i.localHead && i.localHead !== head) {
    return out('FIX', `the PR head is ${head.slice(0, 12)} but the local HEAD is ${i.localHead.slice(0, 12)}: push the branch (or pull what someone else pushed), then gate again`)
  }
  if (ship.merging === head) return out('WAIT', 'a merge of this head was requested: waiting for GitHub to merge it (a merge queue, or the merge in progress)')
  if (mergeable === 'CONFLICTING' || merge === 'DIRTY') return out('FIX', 'the branch conflicts with its base: merge the base in, resolve, run the checks, push')

  const failing = checks.filter(c => c.result === 'fail')
  if (failing.length) {
    failedHeads = [...new Set([...ship.failedHeads, head])]
    if (failedHeads.length > config.maxFixAttempts) {
      return out('BLOCKED', `CI has failed on ${failedHeads.length} heads, past ship.maxFixAttempts (${config.maxFixAttempts}): it needs the user`)
    }
    return out('FIX', `${failing.length} check(s) failed on the head: ${failing.map(c => c.name).join(', ')}`)
  }
  const pending = checks.filter(c => c.result === 'pending')
  if (pending.length) return out('WAIT', `${pending.length} check(s) still running: ${pending.map(c => c.name).join(', ')}`)
  if (!checks.length && config.requireChecks) {
    const seen = ship.headSeenAt[head] ?? i.now
    if (i.now - seen < config.checksGraceSec * 1000) return out('WAIT', 'no checks have reported on the head yet')
    return out(
      'BLOCKED',
      `no CI check reported on the head within ${config.checksGraceSec}s: full send merges only on passing CI (ship.requireChecks: false merges on the loop's local checks alone)`,
    )
  }
  if (merge === 'BEHIND') return out('FIX', 'the branch is behind its base and the base requires it up to date: merge the base in, run the checks, push')
  if (mergeable === 'UNKNOWN' || merge === 'UNKNOWN') return out('WAIT', 'GitHub is still computing whether the PR can merge')
  if (merge === 'BLOCKED') {
    return out('BLOCKED', 'branch protection refuses the merge with every check green (a required review or another rule): a push cannot clear it, and full send never bypasses it')
  }
  return out('MERGE', checks.length ? `all ${checks.length} check(s) passed on ${head.slice(0, 12)}` : `no checks, and ship.requireChecks is off`)
}

/**
 * The merge method: the configured one, or for `auto` the repository's own
 * habit (merge commits when its base history is made of them), else squash,
 * else merge, else rebase, among the methods the repository allows.
 *
 * @param {{ squash: boolean, merge: boolean, rebase: boolean }} allowed
 * @param {string} configured
 * @param {boolean | null} mergeHistory whether the base branch's recent first-parent history has merge commits
 * @returns {'squash' | 'merge' | 'rebase' | null}
 */
export function pickMergeMethod(allowed, configured, mergeHistory) {
  if (configured !== 'auto') {
    const m = /** @type {'squash' | 'merge' | 'rebase'} */ (configured)
    return allowed[m] ? m : null
  }
  if (mergeHistory && allowed.merge) return 'merge'
  if (allowed.squash) return 'squash'
  if (allowed.merge) return 'merge'
  if (allowed.rebase) return 'rebase'
  return null
}
