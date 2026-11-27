// The trace at a glance (ADR 0005): where the linked issue's work stands in
// the pipeline, read from the same state the hooks enforce, for the band
// and `/trace` to draw.

import { latestProgress } from './context.mjs'
import { real } from './paths.mjs'
import { branchIssue, linkedIssue, readVerdict, tracedRoot, unreadable } from './trace.mjs'

/** @typedef {import('./trace.mjs').World} World */

/** The pipeline's steps, in order (ADR 0006). */
export const STEPS = /** @type {const} */ (['read', 'track', 'branch', 'implement', 'review', 'update', 'close'])

/** @typedef {typeof STEPS[number]} Step */

/**
 * Where the trace stands: the step reached (the first not done, or `done`)
 * and why, in the hooks' own words; the steps done; the linked issue, its
 * latest progress comment, its last comment when that is another one, and
 * whether its related docs are read; the commit the latest review record on
 * the issue names, if any, and how many commits the head has since it (0:
 * the head is reviewed; null without a record, or when that commit is not
 * in the head's history); its PR, with its CI state and each check's
 * outcome.
 *
 * @typedef {{
 *   step: Step | 'done',
 *   why: string | null,
 *   done: Step[],
 *   issue: { n: number, title: string, url: string | null } | null,
 *   docs: 'read' | 'unread' | null,
 *   review: Review | null,
 *   comment: Comment | null,
 *   last: Comment | null,
 *   pr: (Omit<import('./trace.mjs').PullRequest, 'checks'> & { ci: Outcome | 'none', checks: { name: string, state: string, outcome: Outcome }[] }) | null,
 * }} Status
 */

/** @typedef {{ author: string, at: string, body: string, isProgress: boolean }} Comment */
/** @typedef {'passing' | 'failing' | 'pending'} Outcome */
/** @typedef {{ sha: string | null, unreviewed: number | null }} Review */

// A review round's record of the commit it covered: a line of its own in a
// comment on the issue, which is where a round is recorded (ADR 0006).
const RECORD = /^[ \t]*Reviewed:[ \t]*`?([0-9a-f]{7,40})`?[ \t\r]*$/gim

/** @param {{ body: string }[]} comments @returns {string | null} the commit the latest review record names */
const reviewedCommit = comments => comments.flatMap(c => [...c.body.matchAll(RECORD)]).at(-1)?.[1] ?? null

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
  const status = { step: 'done', why: null, done: [], issue: null, docs: null, review: null, comment: null, last: null, pr: null }
  const linked = linkedIssue(root, branch, world)
  const b = branchIssue(branch)
  const n = 'n' in linked ? linked.n : b !== null && branch !== world.git.defaultBranch(root) && world.github.issueState(root, b) === 'CLOSED' ? b : null
  if (n === null || !branch) {
    const why = 'why' in linked ? linked.why : null
    const named = /\b(\w+) step:/.exec(why ?? '')?.[1]?.toLowerCase()
    return { ...status, step: STEPS.find(s => s === named) ?? 'track', why }
  }
  const issue = world.github.issue(root, n)
  status.issue = { n, title: issue?.title ?? '', url: slug ? `https://github.com/${slug}/issues/${n}` : null }
  const last = issue?.comments.at(-1)
  const shown = issue && latestProgress(issue.comments)
  /** @param {import('./docs.mjs').Issue['comments'][number]} c @param {boolean} isProgress @returns {Comment} */
  const comment = (c, isProgress) => ({ author: c.author, at: c.at ?? '', body: c.body, isProgress })
  status.comment = shown ? comment(shown, shown !== last || /^#+\s*progress\b/im.test(shown.body)) : null
  status.last = last && last !== shown ? comment(last, false) : null
  const pr = world.github.pr(root, branch)
  if (pr && pr !== 'NONE') {
    const checks = pr.checks.map(c => ({ ...c, outcome: outcomeOf(c.state) }))
    status.pr = { ...pr, checks, ci: !checks.length ? 'none' : checks.some(c => c.outcome === 'failing') ? 'failing' : checks.every(c => c.outcome === 'passing') ? 'passing' : 'pending' }
  }
  if ('why' in linked) return { ...status, done: [...STEPS] }

  const unread = readVerdict(root, n, null, world)
  status.docs = unread ? 'unread' : 'read'
  if (issue) {
    const sha = reviewedCommit(issue.comments)
    status.review = { sha, unreviewed: sha ? world.git.since(root, sha) : null }
  }
  const pushed = world.git.pushed(root, branch)
  const repo = slug ? ` -R ${slug}` : ''
  /** @type {[Step, string | null][]} */
  const steps = [
    ['read', unread],
    ['track', null],
    ['branch', null],
    ['implement', world.git.committed(root, n) ? null : `no commit on this branch references #${n} yet. Implement step: build it test-first (mattpocock-skills:tdd), committing with #${n} in each message.`],
    ['review', reviewWhy(pr, branch, n, status.review)],
    [
      'update',
      !pushed
        ? `nothing on ${branch} is pushed yet. Update step: push it, then post a progress comment on #${n} (progress, decisions, verification results), with \`gh issue comment ${n}${repo}\`.`
        : !(last?.at && Date.parse(last.at) >= Date.parse(pushed.at))
          ? `commits were pushed to ${branch} after the last comment on #${n}. Update step: post a progress comment on #${n} (progress, decisions, verification results), with \`gh issue comment ${n}${repo}\`.`
          : null,
    ],
    ['close', `Close step: PR #${status.pr?.n} is open; merging it closes #${n}. The human merges.`],
  ]
  status.done = steps.filter(([, why]) => why === null).map(([s]) => s)
  const current = steps.find(([, why]) => why !== null)
  return current ? { ...status, step: current[0], why: current[1] } : status
}

/**
 * Why Review is not done: only an open PR whose branch's head is the commit
 * the latest review record names does it. A PR that was closed, or merged
 * while the issue stays open (into a branch other than the default), closes
 * nothing; a head no review is recorded for is unreviewed, and the why says
 * which commits are.
 *
 * @param {import('./trace.mjs').PullRequest | 'NONE' | null} pr @param {string} branch @param {number} n
 * @param {Review | null} review null when the issue's comments cannot be read
 */
function reviewWhy(pr, branch, n, review) {
  if (pr === null) return `the trace cannot read whether ${branch} has a PR: ${unreadable(`gh pr view ${branch}`)}.`
  if (pr === 'NONE' || pr.state !== 'OPEN') {
    const was = pr === 'NONE' ? '' : pr.state === 'CLOSED' ? `PR #${pr.n} for ${branch} was closed unmerged. ` : `PR #${pr.n} for ${branch} was merged, but #${n} is still open: a PR closes its issue only when it merges into the default branch. `
    return `${was}Review step: review ${branch} (/code-review, mattpocock-skills:code-review), then open a PR for it that says Closes #${n} (mattpocock-skills:pr).`
  }
  if (!review) return `the trace cannot read whether a review of ${branch} is recorded on #${n}: ${unreadable(`gh issue view ${n}`)}.`
  if (review.unreviewed === 0) return null
  /** @param {string} what @returns {string} the step to go back to: the review is not run twice for a missing record */
  const step = what =>
    `Review step: review ${what} (/code-review, mattpocock-skills:code-review) unless this round already has, then record the commit the reviews covered, as a line \`Reviewed: <sha>\` in the progress comment on #${n}.`
  if (review.sha === null) return `PR #${pr.n} is open, but no review of ${branch} is recorded on #${n}. ${step('it')}`
  const at = review.sha.slice(0, 7)
  if (review.unreviewed === null) return `the last review recorded on #${n} covered ${at}, which is not in ${branch}'s history, so all of ${branch} is unreviewed. ${step('it')}`
  const commits = review.unreviewed === 1 ? '1 commit' : `${review.unreviewed} commits`
  return `${commits} on ${branch} since ${at}, the commit the last review recorded on #${n} covered, ${review.unreviewed === 1 ? 'is' : 'are'} unreviewed (\`git log ${at}..HEAD\`). ${step('the new diff')}`
}

/** @param {string} state a check's state @returns {Outcome} */
const outcomeOf = state => (FAILED.has(state) ? 'failing' : PASSED.has(state) ? 'passing' : 'pending')
