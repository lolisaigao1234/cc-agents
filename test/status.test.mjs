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
 * @param {{ branch?: string, issue?: Issue | null, state?: 'OPEN' | 'CLOSED', traced?: boolean, env?: Record<string, string>, pushed?: { sha: string, at: string } | null, committed?: boolean, pr?: PullRequest | 'NONE' | null, records?: ReadRecord[] }} [o]
 */
function world(root, { branch = '10-trace-band', issue = ISSUE, state = 'OPEN', traced = true, env = {}, pushed = null, committed = false, pr = 'NONE', records = [] } = {}) {
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
      headDocs: () => ({}),
      pushed: () => pushed,
      committed: () => committed,
    },
    github: { issueState: (/** @type {string} */ _, /** @type {number} */ n) => (asked.push(n), issue ? state : null), issue: () => issue, alias: () => null, pr: () => pr },
    env,
    reads: { records: () => records, add() {}, clear() {} },
    once: () => true,
  }
}

/** @param {string} root @returns {ReadRecord[]} what an agent that read the glossary and the whole issue has on record */
function readEverything(root) {
  const w = world(root)
  const glossary = join(root, 'GLOSSARY.md')
  const as = { cwd: root, session_id: 's' }
  return [
    ...readRecord({ tool_name: 'Read', tool_input: { file_path: glossary }, tool_response: { type: 'text', file: { filePath: glossary, content: '# Terms\n', numLines: 2, startLine: 1, totalLines: 2 } }, ...as }, w),
    ...readRecord({ tool_name: 'Bash', tool_input: { command: 'gh issue view 10 --comments' }, tool_response: { stdout: [ISSUE.title, ISSUE.body, ...ISSUE.comments.map(c => c.body)].join('\n'), stderr: '', interrupted: false }, ...as }, w),
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
  assert.match(String(review?.why), /Review step: review 10-trace-band since its base \(\/code-review, mattpocock-skills:code-review\), then open a PR for it that says Closes #10 \(mattpocock-skills:pr\)\./)

  const pushed = { sha: 'abc', at: '2026-10-04T10:00:00Z' }
  const update = at({ committed: true, pr: PR, pushed })
  assert.equal(update?.step, 'update')
  assert.deepEqual(update?.pr, { ...PR, ci: 'passing', checks: PR.checks.map(c => ({ ...c, outcome: 'passing' })) })
  assert.match(String(update?.why), /Update step: post a progress comment on #10 .*`gh issue comment 10 -R owner\/name`/)

  const close = at({ committed: true, pr: PR, pushed: { sha: 'abc', at: '2026-10-03T09:00:00Z' } })
  assert.deepEqual([close?.step, close?.done], ['close', ['read', 'track', 'branch', 'implement', 'review', 'update']])
  assert.match(String(close?.why), /Close step: PR #19 is open; merging it closes #10/)

  const closed = at({ committed: true, pr: { ...PR, state: 'CLOSED' }, pushed })
  assert.equal(closed?.step, 'review', 'a closed PR closes nothing')
  assert.match(String(closed?.why), /^PR #19 for 10-trace-band was closed unmerged\. Review step: review 10-trace-band/)
  const merged = at({ committed: true, pr: { ...PR, state: 'MERGED' }, pushed })
  assert.equal(merged?.step, 'review', 'a PR merged into another branch leaves the issue open')
  assert.match(String(merged?.why), /^PR #19 for 10-trace-band was merged, but #10 is still open: .*Review step: /)

  const done = at({ committed: true, pr: { ...PR, state: 'MERGED' }, pushed, state: 'CLOSED' })
  assert.deepEqual([done?.step, done?.done], ['done', ['read', 'track', 'branch', 'implement', 'review', 'update', 'close']])
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

test('when GitHub cannot say, the status says so instead of guessing', () => {
  const root = docsRepo()
  const s = traceStatus(root, world(root, { issue: null }))
  assert.equal(s?.step, 'track')
  assert.match(String(s?.why), /GitHub could not say whether issue #10 is open/)
  const pr = traceStatus(root, world(root, { committed: true, pr: null, records: readEverything(root) }))
  assert.deepEqual([pr?.step, pr?.pr], ['review', null])
  assert.match(String(pr?.why), /GitHub could not say whether 10-trace-band has a PR/)
})
