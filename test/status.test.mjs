import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { traceStatus } from '../plugins/trace/scripts/lib/status.mjs'
import { readRecord } from '../plugins/trace/scripts/lib/trace.mjs'

/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').Issue} Issue */
/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').ReadRecord} ReadRecord */
/** @typedef {import('../plugins/trace/scripts/lib/trace.mjs').PullRequest} PullRequest */

/** @type {Issue} */
const ISSUE = {
  title: 'Trace band',
  body: 'Show the trace.',
  comments: [
    { id: '1', author: 'claude', body: '## Progress\n\nThe band draws.', at: '2026-10-02T10:00:00Z' },
    { id: '2', author: 'rocky', body: 'Thanks!', at: '2026-10-03T10:00:00Z' },
  ],
}

/** A traced repository with a glossary, on disk. */
function docsRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'status-')))
  writeFileSync(join(root, 'GLOSSARY.md'), '# Terms\n')
  return root
}

/**
 * In-memory git and GitHub around `root`.
 *
 * @param {string} root
 * @param {{ branch?: string, issue?: Issue | null, state?: 'OPEN' | 'CLOSED', traced?: boolean, env?: Record<string, string>, pushed?: { sha: string, at: string } | null, committed?: boolean, pr?: PullRequest | 'NONE' | null, records?: ReadRecord[], since?: (rev: string) => number | null }} [o]
 */
function world(root, { branch = '10-trace-band', issue = ISSUE, state = 'OPEN', traced = true, env = {}, pushed = null, committed = false, pr = 'NONE', records = [], since = () => null } = {}) {
  /** @type {number[]} the issues GitHub was asked the state of */
  const asked = []
  return {
    asked,
    git: {
      root: (/** @type {string} */ p) => (p === root || p.startsWith(`${root}/`) ? root : null),
      traced: () => traced,
      branch: () => branch,
      defaultBranch: () => 'main',
      origin: () => 'owner/name',
      ghBase: () => 'owner/name',
      message: () => null,
      config: () => null,
      configKeys: () => [],
      headDocs: () => ({}),
      pushed: () => pushed,
      committed: () => committed,
      since: (/** @type {string} */ _, /** @type {string} */ rev) => since(rev),
    },
    github: { issueState: (/** @type {string} */ _, /** @type {number} */ n) => (asked.push(n), issue ? state : null), issue: () => issue, alias: () => null, pr: () => pr },
    env,
    reads: { records: () => records, add() {}, clear() {} },
    once: () => true,
  }
}

/** @param {string} root @param {Issue} [issue] @returns {ReadRecord[]} what an agent that read the glossary and the whole issue has on record */
function readEverything(root, issue = ISSUE) {
  const w = world(root, { issue })
  const glossary = join(root, 'GLOSSARY.md')
  const as = { cwd: root, session_id: 's' }
  return [
    ...readRecord({ tool_name: 'Read', tool_input: { file_path: glossary }, tool_response: { type: 'text', file: { filePath: glossary, content: '# Terms\n', numLines: 2, startLine: 1, totalLines: 2 } }, ...as }, w),
    ...readRecord({ tool_name: 'Bash', tool_input: { command: 'gh issue view 10 --comments' }, tool_response: { stdout: [issue.title, issue.body, ...issue.comments.map(c => c.body)].join('\n'), stderr: '', interrupted: false }, ...as }, w),
  ]
}

/** @type {PullRequest} */
const PR = { n: 19, url: 'https://github.com/owner/name/pull/19', state: 'OPEN', checks: [{ name: 'test', state: 'SUCCESS' }, { name: 'lint', state: 'SUCCESS' }] }

test('outside a traced repository, or under the bypass, there is no status', () => {
  const root = docsRepo()
  assert.equal(traceStatus(root, world(root, { traced: false })), null)
  assert.equal(traceStatus(root, world(root, { env: { TRACE_BYPASS: '1' } })), null)
  assert.equal(traceStatus('/elsewhere', world(root)), null)
})

test('off an issue branch, the step is the one the gates name', () => {
  const root = docsRepo()
  const main = traceStatus(root, world(root, { branch: 'main' }))
  assert.equal(main?.step, 'branch')
  assert.match(String(main?.why), /^this is the default branch \(main\)\. Branch step: /)
  assert.deepEqual([main?.issue, main?.done, main?.docs, main?.pr], [null, [], null, null])
  const feature = world(root, { branch: 'feature' })
  assert.equal(traceStatus(root, feature)?.step, 'track')
  assert.deepEqual(feature.asked, [], 'a branch that names no issue asks GitHub nothing')
})

test('on an open issue whose docs are unread, the step is Read, with what is unread', () => {
  const root = docsRepo()
  const s = traceStatus(root, world(root))
  assert.equal(s?.step, 'read')
  assert.deepEqual(s?.issue, { n: 10, title: 'Trace band', url: 'https://github.com/owner/name/issues/10' })
  assert.deepEqual(s?.done, ['track', 'branch'])
  assert.equal(s?.docs, 'unread')
  assert.match(String(s?.why), /^the related docs are not all read\. Unread: GLOSSARY\.md; issue #10: .*Read step: /)
  assert.deepEqual(s?.comment, { author: 'claude', at: '2026-10-02T10:00:00Z', body: '## Progress\n\nThe band draws.', isProgress: true })
  assert.deepEqual(s?.last, { author: 'rocky', at: '2026-10-03T10:00:00Z', body: 'Thanks!', isProgress: false }, 'the last comment too, when it is another one')
  const one = traceStatus(root, world(root, { issue: { ...ISSUE, comments: ISSUE.comments.slice(0, 1) } }))
  assert.deepEqual([one?.comment?.author, one?.last], ['claude', null])
})

// A commit, and the issue once a round's progress comment has recorded a review of it.
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
/** @param {string} body @returns {Issue} */
const withComment = body => ({ ...ISSUE, comments: [...ISSUE.comments, { id: '3', author: 'claude', body, at: '2026-10-03T11:00:00Z' }] })
const REVIEWED = withComment(`## Progress\n\nRound 1: both reviews ran, no findings.\n\nReviewed: ${HEAD}`)

test('the step moves on as each one completes, up to Close', () => {
  const root = docsRepo()
  const records = readEverything(root)
  const at = (/** @type {Parameters<typeof world>[1]} */ o) => traceStatus(root, world(root, { records, ...o }))

  const implement = at({})
  assert.equal(implement?.docs, 'read')
  assert.deepEqual([implement?.step, implement?.done], ['implement', ['read', 'track', 'branch']])
  assert.match(String(implement?.why), /no commit on this branch references #10 yet\. Implement step: build it test-first \(mattpocock-skills:tdd\)/)

  const review = at({ committed: true })
  assert.deepEqual([review?.step, review?.pr], ['review', null])
  assert.match(String(review?.why), /Review step: review 10-trace-band \(\/code-review, mattpocock-skills:code-review\), then open a PR for it that says Closes #10 \(mattpocock-skills:pr\)\./)

  // From here the head is reviewed: the issue's last comment records a review of it.
  const reviewed = { issue: REVIEWED, records: readEverything(root, REVIEWED), since: () => 0, committed: true }
  const pushed = { sha: 'abc', at: '2026-10-04T10:00:00Z' }
  const update = at({ ...reviewed, pr: PR, pushed })
  assert.equal(update?.step, 'update')
  assert.deepEqual(update?.pr, { ...PR, ci: 'passing', checks: PR.checks.map(c => ({ ...c, outcome: 'passing' })) })
  assert.match(String(update?.why), /Update step: post a progress comment on #10 .*`gh issue comment 10 -R owner\/name`/)

  const close = at({ ...reviewed, pr: PR, pushed: { sha: 'abc', at: '2026-10-03T09:00:00Z' } })
  assert.deepEqual([close?.step, close?.done], ['close', ['read', 'track', 'branch', 'implement', 'review', 'update']])
  assert.match(String(close?.why), /Close step: PR #19 is open; merging it closes #10/)

  const closed = at({ ...reviewed, pr: { ...PR, state: 'CLOSED' }, pushed })
  assert.equal(closed?.step, 'review', 'a closed PR closes nothing')
  assert.match(String(closed?.why), /^PR #19 for 10-trace-band was closed unmerged\. Review step: review 10-trace-band/)
  const merged = at({ ...reviewed, pr: { ...PR, state: 'MERGED' }, pushed })
  assert.equal(merged?.step, 'review', 'a PR merged into another branch leaves the issue open')
  assert.match(String(merged?.why), /^PR #19 for 10-trace-band was merged, but #10 is still open: .*Review step: /)

  const done = at({ committed: true, pr: { ...PR, state: 'MERGED' }, pushed, state: 'CLOSED' })
  assert.deepEqual([done?.step, done?.done], ['done', ['read', 'track', 'branch', 'implement', 'review', 'update', 'close']])
})

test('an open PR completes Review only once a review of the head is recorded on the issue', () => {
  const root = docsRepo()
  const pushed = { sha: 'abc', at: '2026-10-03T09:00:00Z' }
  const step = 'Review step: review it (/code-review, mattpocock-skills:code-review) unless this round already has, then record the commit the reviews covered, as a line `Reviewed: <sha>` in the progress comment on #10.'
  /** @param {Issue} issue @param {(rev: string) => number | null} [since] */
  const at = (issue, since) => traceStatus(root, world(root, { issue, records: readEverything(root, issue), since, committed: true, pr: PR, pushed }))

  const none = at(ISSUE)
  assert.deepEqual([none?.step, none?.done], ['review', ['read', 'track', 'branch', 'implement', 'update']])
  assert.deepEqual(none?.review, { sha: null, unreviewed: null })
  assert.equal(none?.why, `PR #19 is open, but no review of 10-trace-band is recorded on #10. ${step}`)

  /** @type {string[]} the commits git was asked about */
  const asked = []
  const head = at(REVIEWED, rev => (asked.push(rev), 0))
  assert.deepEqual(asked, [HEAD], 'git says how far the head is past the recorded commit')
  assert.deepEqual(head?.review, { sha: HEAD, unreviewed: 0 })
  assert.deepEqual([head?.step, head?.done], ['close', ['read', 'track', 'branch', 'implement', 'review', 'update']])
})

test('a review of an older head no longer counts: the status says which commits are unreviewed', () => {
  const root = docsRepo()
  const records = readEverything(root, REVIEWED)
  const at = (/** @type {number | null} */ since) => traceStatus(root, world(root, { issue: REVIEWED, records, since: () => since, committed: true, pr: PR }))
  const step = (/** @type {string} */ what) =>
    `Review step: review ${what} (/code-review, mattpocock-skills:code-review) unless this round already has, then record the commit the reviews covered, as a line \`Reviewed: <sha>\` in the progress comment on #10.`

  const two = at(2)
  assert.equal(two?.step, 'review')
  assert.deepEqual(two?.review, { sha: HEAD, unreviewed: 2 })
  assert.equal(two?.why, `2 commits on 10-trace-band since a1b2c3d, the commit the last review recorded on #10 covered, are unreviewed (\`git log a1b2c3d..HEAD\`). ${step('the new diff')}`)
  assert.match(String(at(1)?.why), /^1 commit on 10-trace-band since a1b2c3d, the commit the last review recorded on #10 covered, is unreviewed /)

  // A commit a rebase left behind, or one git does not have here: nothing on the branch descends from it.
  const gone = at(null)
  assert.deepEqual([gone?.step, gone?.review], ['review', { sha: HEAD, unreviewed: null }])
  assert.equal(gone?.why, `the last review recorded on #10 covered a1b2c3d, which is not in 10-trace-band's history, so all of 10-trace-band is unreviewed. ${step('it')}`)
})

test('the review record is the latest line `Reviewed: <sha>` of its own in a comment on the issue', () => {
  const root = docsRepo()
  const sha = (/** @type {string} */ body) => traceStatus(root, world(root, { issue: withComment(body) }))?.review?.sha
  const OLD = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(sha(`Reviewed: ${OLD}\n\nRound 2, after the fixes.\n\nReviewed: ${HEAD}`), HEAD, 'the latest record counts')
  assert.equal(traceStatus(root, world(root, { issue: { ...REVIEWED, comments: [...REVIEWED.comments, { id: '4', author: 'rocky', body: 'Merging tomorrow.', at: '2026-10-04T08:00:00Z' }] } }))?.review?.sha, HEAD, 'a later comment without one leaves it standing')
  assert.equal(sha('  reviewed: `A1B2C3D`\r\n'), 'A1B2C3D', 'an abbreviated commit, in backticks, in any case')
  for (const body of [`> Reviewed: ${HEAD}`, `I Reviewed: ${HEAD} yesterday`, `Reviewed: ${HEAD} and the tests`, 'Reviewed: the whole branch', 'Reviewed: abc12', `Reviewed-by: ${HEAD}`, `Reviewed: \`${HEAD}`]) {
    assert.equal(sha(body), null, body)
  }
  // An example of the line, or one GitHub does not show, is not a record.
  for (const body of [`\`\`\`\nReviewed: ${HEAD}\n\`\`\``, `~~~text\r\nReviewed: ${HEAD}\r\n~~~`, `The line:\n\n    Reviewed: ${HEAD}`, `\tReviewed: ${HEAD}`, `<!--\nReviewed: ${HEAD}\n-->`]) {
    assert.equal(sha(body), null, body)
  }
  assert.equal(sha(`Reviewed: ${HEAD}\n\nRecord the next round the same way:\n\n\`\`\`\nReviewed: ${OLD}\n\`\`\``), HEAD, 'a later example in a code fence leaves the record standing')
})

test("the PR's CI is failing on any failed check, pending on any unfinished one, and none without checks", () => {
  const root = docsRepo()
  const ci = (/** @type {{ name: string, state: string }[]} */ checks) => traceStatus(root, world(root, { committed: true, pr: { ...PR, checks } }))?.pr?.ci
  assert.equal(ci([{ name: 'a', state: 'SUCCESS' }, { name: 'b', state: 'FAILURE' }, { name: 'c', state: 'PENDING' }]), 'failing')
  const outcomes = traceStatus(root, world(root, { committed: true, pr: { ...PR, checks: [{ name: 'a', state: 'EXPECTED' }, { name: 'b', state: 'TIMED_OUT' }, { name: 'c', state: 'NEUTRAL' }] } }))?.pr?.checks
  assert.deepEqual(outcomes?.map(c => c.outcome), ['pending', 'failing', 'passing'], 'each check is judged as the CI state is')
  assert.equal(ci([{ name: 'a', state: 'SUCCESS' }, { name: 'c', state: 'PENDING' }]), 'pending')
  assert.equal(ci([{ name: 'a', state: 'SKIPPED' }, { name: 'b', state: 'NEUTRAL' }]), 'passing')
  assert.equal(ci([]), 'none')
})

test("when GitHub's answer cannot be read, the status says so instead of guessing", () => {
  const root = docsRepo()
  const s = traceStatus(root, world(root, { issue: null }))
  assert.equal(s?.step, 'track')
  // Either cause may be why: an origin not on GitHub, or an answer gh printed that the trace cannot parse.
  assert.match(String(s?.why), /the trace cannot read whether issue #10 is open: origin is not a GitHub repository \(`git remote get-url origin`\), or gh printed what the trace cannot read \(`gh issue view 10` shows it\)/)
  const pr = traceStatus(root, world(root, { committed: true, pr: null, records: readEverything(root) }))
  assert.deepEqual([pr?.step, pr?.pr], ['review', null])
  assert.match(String(pr?.why), /the trace cannot read whether 10-trace-band has a PR: origin is not a GitHub repository \(`git remote get-url origin`\), or gh printed what the trace cannot read \(`gh pr view 10-trace-band` shows it\)/)
})
