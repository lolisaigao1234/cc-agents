import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pullRequestVerdict } from '../plugins/trace/scripts/lib/pull-request.mjs'

const CHECK = fileURLToPath(new URL('../plugins/trace/scripts/check.mjs', import.meta.url))

/** @param {string} message @param {number} [parents] @param {string} [stamp] its last paragraph @returns {import('../plugins/trace/scripts/lib/pull-request.mjs').Commit} */
const commit = (message, parents = 1, stamp = 'Verified: none') => ({ sha: 'c0ffee1234567890', message: stamp ? `${message}\n\n${stamp}` : message, parents })

/**
 * In-memory GitHub: the repository owner/name, with pull request 12 from the
 * branch `head`.
 *
 * @param {{ head?: string, body?: string, merged?: boolean, issues?: Record<number, 'OPEN' | 'CLOSED'>, commits?: import('../plugins/trace/scripts/lib/pull-request.mjs').Commit[], count?: number }} [o]
 * @returns {import('../plugins/trace/scripts/lib/pull-request.mjs').GitHub}
 */
function github(o = {}) {
  const { head = '7-check', body = 'Closes #7', merged = false, issues = { 7: 'OPEN' }, commits = [commit('add the check (#7)')], count = commits.length } = o
  return {
    slug: 'owner/name',
    pr: () => ({ head, body, merged, commits: count }),
    commits: () => commits,
    issueState: n => issues[n] ?? 'MISSING',
  }
}

test('a PR from a branch that names no issue breaks the trace, naming the Branch step', () => {
  for (const head of ['feature/x', 'fix-7', 'main']) {
    const why = pullRequestVerdict(12, github({ head }))
    assert.equal(why.length, 1, head)
    assert.match(String(why[0]), new RegExp(`the branch ${head} names no issue\\. Branch step: `), head)
  }
})

test("a PR from the branch of a closed issue, a pull request or no issue breaks the trace, naming the Track step", () => {
  const closed = pullRequestVerdict(12, github({ issues: { 7: 'CLOSED' } }))
  assert.deepEqual(closed.map(w => w.replace(/ Track step: .*/, '')), ['#7, which the branch 7-check names, is a closed issue.'])
  const missing = pullRequestVerdict(12, github({ issues: {} }))
  assert.deepEqual(missing.map(w => w.replace(/ Track step: .*/, '')), ['#7, which the branch 7-check names, is not an issue.'])
  assert.match(String(missing[0]), / Track step: \S/)
})

test('a PR with a commit that does not reference the linked issue breaks the trace, naming the commit and the Implement step', () => {
  const commits = [commit('add the check (#7)'), { sha: 'badc0de987654321', message: 'fix a typo\n\nRefs #70 and owner/other#7.\n\nVerified: none', parents: 1 }, commit('say where it runs\n\nPart of owner/name#7.')]
  const why = pullRequestVerdict(12, github({ commits }))
  assert.equal(why.length, 1)
  assert.match(String(why[0]), /^a commit does not reference #7, the linked issue: badc0de "fix a typo"\. Implement step: /)
})

test('a PR with a commit that carries no verification stamp breaks the trace, naming the commit and the Implement step', () => {
  const commits = [commit('add the check (#7)'), { sha: 'badc0de987654321', message: 'fix a typo (#7)\n\nVerified: npm test\nand prose after it', parents: 1 }, { sha: 'c0ffee1234567890', message: 'say where it runs (#7)\r\n\r\nVerified: none\r\n', parents: 1 }]
  const why = pullRequestVerdict(12, github({ commits }))
  assert.equal(why.length, 1)
  assert.match(String(why[0]), /^a commit carries no verification stamp: badc0de "fix a typo \(#7\)"\. Implement step: end the commit message with a last paragraph "Verified: <how it was verified>", or "Verified: none"/)
  assert.deepEqual(pullRequestVerdict(12, github({ commits: [commit("Merge branch 'main' into 7-check", 2, '')] })), [], 'a merge is not asked for one')
})

test('a merge is not asked for a reference: what it brings in is judged as its own commits', () => {
  const merge = commit("Merge branch 'main' into 7-check", 2)
  assert.deepEqual(pullRequestVerdict(12, github({ commits: [commit('add the check (#7)'), merge] })), [])
  // A merge of another issue's branch brings that issue's commits into the PR, where each is asked for #7.
  const why = pullRequestVerdict(12, github({ commits: [commit('add the check (#7)'), commit('the blocker (#6)'), commit("Merge branch '6-blocker' into 7-check", 2)] }))
  assert.equal(why.length, 1)
  assert.match(String(why[0]), /^a commit does not reference #7, the linked issue: c0ffee1 "the blocker \(#6\)"\./)
})

test('a PR whose body does not close the linked issue breaks the trace, naming the Review step', () => {
  for (const body of ['Refs #7', 'Closes #70', 'Closes owner/other#7', '<!-- Closes #7 -->', '```\nCloses #7\n```', '`Closes #7`', '']) {
    const why = pullRequestVerdict(12, github({ body }))
    assert.equal(why.length, 1, body)
    assert.match(String(why[0]), /^the PR body does not close #7, the linked issue\. Review step: put "Closes #7" in the PR body/, body)
  }
})

test('a PR on an open issue\'s branch, whose commits reference it and whose body closes it, is traced', () => {
  for (const body of ['Closes #7', '## Summary\n\nFixes owner/name#7.', 'resolves https://github.com/owner/name/issues/7']) {
    assert.deepEqual(pullRequestVerdict(12, github({ body })), [], body)
  }
})

test('a body is read with the line ends GitHub stores, as the PR gate reads it with a shell\'s', () => {
  assert.deepEqual(pullRequestVerdict(12, github({ body: '## Summary\r\n\r\nCloses #7\r\n' })), [])
  // An indented code block, which the PR gate does not read either.
  assert.equal(pullRequestVerdict(12, github({ body: 'Intro\r\n\r\n    Closes #7\r\n' })).length, 1)
})

test('a PR breaking several rules is told each', () => {
  const why = pullRequestVerdict(12, github({ body: 'x', commits: [commit('one'), commit('two')] }))
  assert.equal(why.length, 2)
  assert.match(String(why[0]), /^2 commits do not reference #7, the linked issue: c0ffee1 "one", c0ffee1 "two"\./)
  assert.match(String(why[1]), /^the PR body does not close #7/)
})

test('a merged PR is not judged: merging closed its issue, and it cannot merge again', () => {
  assert.deepEqual(pullRequestVerdict(12, github({ merged: true, issues: { 7: 'CLOSED' } })), [])
})

test('a PR with more commits than GitHub lists breaks the trace: the rest cannot be judged', () => {
  const commits = Array.from({ length: 250 }, () => commit('step (#7)'))
  const why = pullRequestVerdict(12, github({ commits, count: 251 }))
  assert.equal(why.length, 1)
  assert.match(String(why[0]), /^GitHub lists 250 of this PR's 251 commits, so the rest cannot be judged\. Implement step: /)
})

/**
 * A `gh` on PATH that answers `gh api <path>` from FAKE_GH_API (JSON keyed
 * by path), a pull request's commits as the check's `--jq` prints them, one
 * JSON line each, and "Not Found" for any other path. With FAKE_GH_FAIL set,
 * every call fails with it.
 */
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (process.env.FAKE_GH_FAIL) { process.stderr.write(process.env.FAKE_GH_FAIL + '\\n'); process.exit(1) }
const path = args.find(a => a.startsWith('repos/')) ?? ''
const answer = JSON.parse(process.env.FAKE_GH_API)[path]
if (args[0] !== 'api' || answer === undefined) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1) }
if (!args.includes('--jq')) process.stdout.write(JSON.stringify(answer))
else for (const c of answer) process.stdout.write(JSON.stringify({ sha: c.sha, message: c.commit.message, parents: c.parents.length }) + '\\n')
`

/** GitHub's answers about owner/name: pull request 12, from the branch of the open issue 7, traced. */
const TRACED = {
  'repos/owner/name/pulls/12': { number: 12, state: 'open', merged: false, body: '## Summary\r\n\r\nCloses #7', commits: 2, head: { ref: '7-check' }, base: { ref: 'main' } },
  'repos/owner/name/pulls/12/commits?per_page=100': [
    { sha: 'c0ffee1234567890', commit: { message: 'add the check (#7)\n\nIt runs on GitHub.\n\nVerified: npm test' }, parents: [{ sha: 'a' }] },
    { sha: 'facade1234567890', commit: { message: "Merge branch 'main' into 7-check" }, parents: [{ sha: 'a' }, { sha: 'b' }] },
  ],
  'repos/owner/name/issues/7': { number: 7, state: 'open' },
}

/** @param {Record<string, unknown>} api @param {Record<string, string>} [env] @param {string[]} [args] */
function check(api, env = {}, args = ['12']) {
  const bin = mkdtempSync(join(tmpdir(), 'gh-'))
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  return spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/name', FAKE_GH_API: JSON.stringify(api), ...env } })
}

test('the check passes a traced PR, as GitHub answers about it', () => {
  const r = check(TRACED)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout, 'trace: PR #12 is traced.\n')
  assert.equal(r.status, 0)
})

test('the check fails a PR that breaks the trace, printing each broken rule as an error', () => {
  const r = check({
    ...TRACED,
    'repos/owner/name/pulls/12': { ...TRACED['repos/owner/name/pulls/12'], body: 'Refs #7', commits: 1 },
    'repos/owner/name/pulls/12/commits?per_page=100': [{ sha: 'badc0de987654321', commit: { message: 'fix 100% of a typo\r\n\r\nRefs #70.\r\n\r\nVerified: none' }, parents: [{ sha: 'a' }] }],
  })
  assert.equal(r.status, 1)
  const lines = r.stdout.trimEnd().split('\n')
  assert.equal(lines.length, 2)
  // A commit's words are data to the workflow run, not commands.
  assert.match(String(lines[0]), /^::error title=trace::PR #12: a commit does not reference #7, the linked issue: badc0de "fix 100%25 of a typo"\. Implement step: /)
  assert.match(String(lines[1]), /^::error title=trace::PR #12: the PR body does not close #7, the linked issue\. Review step: /)
})

test('an issue GitHub does not have is an answer: the check fails the PR for its branch', () => {
  const { 'repos/owner/name/issues/7': _, ...api } = TRACED
  const r = check(api)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^::error title=trace::PR #12: #7, which the branch 7-check names, is not an issue\. Track step: /)
  const pull = check({ ...TRACED, 'repos/owner/name/issues/7': { number: 7, state: 'open', pull_request: {} } })
  assert.match(pull.stdout, /#7, which the branch 7-check names, is not an issue\./)
})

test('when GitHub does not answer, the check fails rather than pass a PR it could not judge', () => {
  for (const fails of ['gh: Bad Gateway (HTTP 502)', 'gh: Not Found (HTTP 404)', 'To get started with GitHub CLI, please run:  gh auth login']) {
    const r = check(TRACED, { FAKE_GH_FAIL: fails })
    assert.equal(r.status, 1, fails)
    assert.match(r.stdout, /^::error title=trace::PR #12 could not be judged: GitHub did not answer: /, fails)
  }
  const unread = check({ ...TRACED, 'repos/owner/name/pulls/12': { number: 12 } })
  assert.equal(unread.status, 1)
  assert.match(unread.stdout, /^::error title=trace::PR #12 could not be judged: gh printed what the trace cannot read of PR #12\./)
})

test('the check judges nothing without a PR number and a repository', () => {
  for (const [args, env] of /** @type {[string[], Record<string, string>][]} */ ([[[], {}], [['12; echo'], {}], [['12'], { GITHUB_REPOSITORY: '' }]])) {
    const r = check(TRACED, env, args)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^::error title=trace::usage: /)
  }
})
