import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { issueContext, stopNudge } from '../plugins/trace/scripts/lib/context.mjs'

/** @typedef {import('../plugins/trace/scripts/lib/docs.mjs').Issue} Issue */

const BODY = `## Parent

#3

## What to build

Keep the issue in context.

## Acceptance criteria

- [ ] After /compact, the issue is back
- [ ] Nothing is injected in an untraced repository

## Blocked by

- #8
`

/** @type {Issue} */
const ISSUE = {
  title: 'Keep the issue in context',
  body: BODY,
  comments: [
    { id: '1', author: 'rocky', body: 'Old note.', at: '2026-10-01T10:00:00Z' },
    { id: '2', author: 'claude', body: '## Progress\n\nRe-injection works.', at: '2026-10-02T10:00:00Z' },
  ],
}

/** A traced repository with a glossary and one ADR, on disk. */
function docsRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-')))
  mkdirSync(join(root, 'docs/adr'), { recursive: true })
  writeFileSync(join(root, 'GLOSSARY.md'), '# Terms\n')
  writeFileSync(join(root, 'docs/adr/0001-a.md'), '---\nstatus: accepted\n---\n# 0001\n')
  return root
}

/**
 * In-memory git and GitHub around `root`, on `branch`, with `issue` open as #9.
 *
 * @param {string} root
 * @param {{ branch?: string, issue?: Issue | null, traced?: boolean, env?: Record<string, string>, pushed?: { sha: string, at: string } | null, onced?: Set<string> }} [o]
 */
function world(root, { branch = '9-keep-context', issue = ISSUE, traced = true, env = {}, pushed = null, onced = new Set() } = {}) {
  return {
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
    },
    github: { issueState: () => (issue ? /** @type {const} */ ('OPEN') : null), issue: () => issue, alias: () => null },
    env,
    reads: { records: () => [], add() {}, clear() {} },
    once: (/** @type {string} */ key) => !onced.has(key) && !!onced.add(key),
  }
}

test("the context names the linked issue, its acceptance criteria, its latest comment and the related docs", () => {
  const root = docsRepo()
  const text = String(issueContext(root, world(root)))
  assert.match(text, /^Trace: this branch belongs to issue #9, "Keep the issue in context" \(owner\/name\)\./)
  assert.match(text, /Acceptance criteria:\n- \[ \] After \/compact, the issue is back\n- \[ \] Nothing is injected in an untraced repository\n\n/)
  assert.doesNotMatch(text, /Blocked by|What to build/)
  assert.match(text, /Latest comment, by claude on 2026-10-02:\n## Progress\n\nRe-injection works\.\n/)
  assert.doesNotMatch(text, /Old note/)
  assert.match(text, /Related docs, each to read in full before any edit or commit \(the hooks refuse otherwise\): GLOSSARY\.md, docs\/adr\/0001-a\.md, and issue #9's title, body and 2 comments\./)
  assert.match(text, /When this and your memory disagree, the issue wins: reread it with `gh issue view 9 -R owner\/name`\.$/)
})

test('an issue without acceptance criteria or comments shows its body, and a long part is cut with how to read it all', () => {
  const root = docsRepo()
  const long = { title: 'T', body: `Do it.\n${'x'.repeat(5000)}`, comments: [] }
  const text = String(issueContext(root, world(root, { issue: long })))
  assert.match(text, /The issue says:\nDo it\.\nx+ … \(cut; read it all with `gh issue view 9 -R owner\/name`\)\n/)
  assert.ok(text.length < 4000)
  assert.doesNotMatch(text, /Latest comment/)
  assert.match(text, /and issue #9's title and body\./)
})

test('off an issue branch the context names the step to go back to; untraced, bypassed or unreachable, it says what it can', () => {
  const root = docsRepo()
  assert.match(String(issueContext(root, world(root, { branch: 'main' }))), /^Trace: this is the default branch \(main\)\. Branch step: /)
  assert.equal(issueContext(root, world(root, { traced: false })), null)
  assert.equal(issueContext(root, world(root, { env: { TRACE_BYPASS: '1' } })), null)
  assert.equal(issueContext('/elsewhere', world(root)), null)
  assert.match(String(issueContext(root, world(root, { issue: null }))), /^Trace: GitHub could not say whether issue #9 is open/)
})

test('stopping after a push newer than the last comment is blocked once, then let through', () => {
  const root = docsRepo()
  const onced = new Set()
  const pushed = { sha: 'abc123', at: '2026-10-03T09:00:00Z' }
  const stop = (/** @type {object} */ input = {}) => stopNudge({ cwd: root, session_id: 's1', stop_hook_active: false, ...input }, world(root, { pushed, onced }))
  assert.match(String(stop()), /^commits were pushed to 9-keep-context after the last comment on #9\. Update step: post a progress comment on #9 \(progress, decisions, verification results\), with `gh issue comment 9 -R owner\/name`\. This asks once\.$/)
  assert.equal(stop(), null, 'once per pushed head')
  assert.equal(stopNudge({ cwd: root, session_id: 's1', stop_hook_active: false }, world(root, { pushed: { sha: 'def456', at: '2026-10-04T09:00:00Z' }, onced })) !== null, true, 'a new push asks again')
  assert.equal(stopNudge({ cwd: root, session_id: 's2', stop_hook_active: true }, world(root, { pushed })), null, 'a stop the hook already blocked goes through')
  assert.equal(stopNudge({ cwd: root, session_id: 's3', stop_hook_active: false }, world(root, { pushed: { sha: 'abc123', at: '2026-10-01T09:00:00Z' } })), null, 'commented since the push')
  assert.equal(stopNudge({ cwd: root, session_id: 's4', stop_hook_active: false }, world(root)), null, 'nothing pushed')
  assert.equal(stopNudge({ cwd: root, session_id: 's5', stop_hook_active: false }, world(root, { pushed, branch: 'main' })), null, 'no linked issue')
  assert.equal(stopNudge({ cwd: root, session_id: 's6', stop_hook_active: false }, world(root, { pushed, issue: null })), null, 'GitHub cannot say: never wedge a stop')
  const none = { ...ISSUE, comments: [] }
  assert.notEqual(stopNudge({ cwd: root, session_id: 's7', stop_hook_active: false }, world(root, { pushed, issue: none })), null, 'no comment at all')
})
