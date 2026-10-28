// The trace at a glance (ADR 0005): where the linked issue's work stands in
// the pipeline, read from the same state the hooks enforce, for the band
// and `/trace` to draw.

import { latestProgress } from './context.mjs'
import { real } from './paths.mjs'
import { branchIssue, linkedIssue, readVerdict, tracedRoot } from './trace.mjs'

/** @typedef {import('./trace.mjs').World} World */

/** The pipeline's steps, in order (ADR 0006). */
export const STEPS = /** @type {const} */ (['read', 'track', 'branch', 'implement', 'review', 'update', 'close'])

/** @typedef {typeof STEPS[number]} Step */

/**
 * Where the trace stands: the step reached (the first not done, or `done`)
 * and why, in the hooks' own words; the steps done; the linked issue, its
 * latest progress comment and whether its related docs are read; its PR,
 * with its CI state.
 *
 * @typedef {{
 *   step: Step | 'done',
 *   why: string | null,
 *   done: Step[],
 *   issue: { n: number, title: string, url: string | null } | null,
 *   docs: 'read' | 'unread' | null,
 *   comment: { author: string, at: string, body: string, isProgress: boolean } | null,
 *   pr: (import('./trace.mjs').PullRequest & { ci: 'passing' | 'failing' | 'pending' | 'none' }) | null,
 * }} Status
 */

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/**
 * The trace's status for the main agent of a session working in `cwd`, or
 * null outside a traced repository and under the bypass.
 *
 * @param {string} cwd @param {World} world @returns {Status | null}
 */
export function traceStatus(cwd, world) {
  if (world.env.TRACE_BYPASS === '1') return null
  const root = tracedRoot(real(cwd), world.git)
  if (!root) return null
  const branch = world.git.branch(root)
  const slug = world.git.origin(root)
  /** @type {Status} */
  const status = { step: 'done', why: null, done: [], issue: null, docs: null, comment: null, pr: null }
  const linked = linkedIssue(root, branch, world)
  const n = 'n' in linked ? linked.n : branch !== world.git.defaultBranch(root) && world.github.issueState(root, branchIssue(branch) ?? 0) === 'CLOSED' ? branchIssue(branch) : null
  if (n === null || !branch) {
    const why = 'why' in linked ? linked.why : null
    const named = /\b(\w+) step:/.exec(why ?? '')?.[1]?.toLowerCase()
    return { ...status, step: STEPS.find(s => s === named) ?? 'track', why }
  }
  const issue = world.github.issue(root, n)
  status.issue = { n, title: issue?.title ?? '', url: slug ? `https://github.com/${slug}/issues/${n}` : null }
  const last = issue?.comments.at(-1)
  const shown = issue && latestProgress(issue.comments)
  status.comment = shown ? { author: shown.author, at: shown.at ?? '', body: shown.body, isProgress: shown !== last || /^#+\s*progress\b/im.test(shown.body) } : null
  const pr = world.github.pr(root, branch)
  if (pr && pr !== 'NONE') status.pr = { ...pr, ci: ciOf(pr.checks) }
  if ('why' in linked) return { ...status, done: [...STEPS] }

  const unread = readVerdict(root, n, null, world)
  status.docs = unread ? 'unread' : 'read'
  const pushed = world.git.pushed(root, branch)
  const repo = slug ? ` -R ${slug}` : ''
  /** @type {[Step, string | null][]} */
  const steps = [
    ['read', unread],
    ['track', null],
    ['branch', null],
    ['implement', world.git.committed(root, n) ? null : `no commit on this branch references #${n} yet. Implement step: build it test-first (implement, tdd), committing with #${n} in each message.`],
    ['review', pr === null ? `GitHub could not say whether ${branch} has a PR; check \`gh auth status\` and the network.` : pr === 'NONE' ? `Review step: open a PR for ${branch} that says Closes #${n} (pr), and review it (code-review).` : null],
    [
      'update',
      !pushed
        ? `nothing on ${branch} is pushed yet. Update step: push it, then post a progress comment on #${n} (progress, decisions, verification results), with \`gh issue comment ${n}${repo}\`.`
        : !(last?.at && Date.parse(last.at) >= Date.parse(pushed.at))
          ? `commits were pushed to ${branch} after the last comment on #${n}. Update step: post a progress comment on #${n} (progress, decisions, verification results), with \`gh issue comment ${n}${repo}\`.`
          : null,
    ],
    ['close', status.pr ? `Close step: PR #${status.pr.n} is ${status.pr.state.toLowerCase()}; merging it closes #${n}. The human merges.` : `Close step: #${n} closes when its PR is merged.`],
  ]
  status.done = steps.filter(([, why]) => why === null).map(([s]) => s)
  const current = steps.find(([, why]) => why !== null)
  return current ? { ...status, step: current[0], why: current[1] } : status
}

/** @param {{ state: string }[]} checks @returns {'passing' | 'failing' | 'pending' | 'none'} */
function ciOf(checks) {
  if (!checks.length) return 'none'
  if (checks.some(c => FAILED.has(c.state))) return 'failing'
  return checks.every(c => PASSED.has(c.state)) ? 'passing' : 'pending'
}
