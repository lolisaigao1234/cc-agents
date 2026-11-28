// The trace's rules for a change, judged on GitHub itself (ADR 0006): a pull
// request's branch names an open issue, each of its commits references that
// issue and carries a verification stamp, and its body closes it. The hooks' gates judge the same rules where
// a session works; this judges what reached GitHub, however it got there. A
// branch's issue, a commit's reference and stamp, and a body's closing words
// are read by the gates' own readers (trace.mjs).

import { spawnSync } from 'node:child_process'

import { NO_ANSWERS, answered } from './halt.mjs'
import { STAMP_HINT, branchIssue, closesIssue, dropMarkdownCode, refersTo, stamped } from './trace.mjs'

/**
 * A pull request as the check reads it: the branch it comes from, its body,
 * whether it is merged, and how many commits it has.
 *
 * @typedef {{ head: string, body: string, merged: boolean, commits: number }} PullRequest
 */

/**
 * A commit of a pull request: its message as git recorded it, and how many
 * parents it has.
 *
 * @typedef {{ sha: string, message: string, parents: number }} Commit
 */

/**
 * What the check needs from GitHub, about the repository `slug`
 * (`owner/name`): a pull request, the commits its branch has and its base
 * branch does not, and an issue's state, 'MISSING' when the number is a pull
 * request's or no one's. Each throws when GitHub does not answer.
 *
 * @typedef {{
 *   slug: string,
 *   pr(n: number): PullRequest,
 *   commits(n: number): Commit[],
 *   issueState(n: number): 'OPEN' | 'CLOSED' | 'MISSING',
 * }} GitHub
 */

/**
 * Why pull request `n` breaks the trace: one reason for each rule it breaks,
 * naming the pipeline step to go back to. None when it is traced.
 *
 * @param {number} n
 * @param {GitHub} github
 * @returns {string[]}
 */
export function pullRequestVerdict(n, github) {
  const pr = github.pr(n)
  // Merging closed its issue, so an edit of it now would be judged against a closed one; it cannot merge again.
  if (pr.merged) return []
  const issue = branchIssue(pr.head)
  if (!issue) {
    return [`the branch ${pr.head} names no issue. Branch step: a change is made on its issue's branch, \`<n>-<slug>\` (\`gh issue develop <n> --checkout\`), and its PR is opened from there.`]
  }
  const state = github.issueState(issue)
  if (state !== 'OPEN') {
    return [`#${issue}, which the branch ${pr.head} names, is ${state === 'CLOSED' ? 'a closed issue' : 'not an issue'}. Track step: a change belongs to an open issue, so reopen #${issue} if this is still its change, or open an issue for it (\`gh issue create\`) and work on that issue's branch.`]
  }
  /** @type {string[]} */
  const why = []
  const refers = refersTo(issue, github.slug)
  // A merge is made by `git merge` or GitHub's "Update branch", which the commit gate does not ask for a reference either.
  const commits = github.commits(n)
  if (commits.length < pr.commits) {
    why.push(`GitHub lists ${commits.length} of this PR's ${pr.commits} commits, so the rest cannot be judged. Implement step: a change this long is split into tickets, each with its own branch and PR.`)
  }
  const judged = commits.filter(c => c.parents < 2)
  /** @param {Commit[]} cs */
  const named = cs => cs.map(c => `${c.sha.slice(0, 7)} "${c.message.split(/\r?\n/)[0]}"`).join(', ')
  const rewrite = "A pushed commit's message changes only by rewriting the branch, which is the human's to do"
  const unreferenced = judged.filter(c => !refers.test(c.message))
  if (unreferenced.length) {
    why.push(`${unreferenced.length === 1 ? 'a commit does' : `${unreferenced.length} commits do`} not reference #${issue}, the linked issue: ${named(unreferenced)}. Implement step: every commit message carries "#${issue}". ${rewrite}; commits of a blocker's branch leave the PR when its base is set to that branch (\`gh pr edit --base <blocker's branch>\`).`)
  }
  const unstamped = judged.filter(c => !stamped(c.message))
  if (unstamped.length) {
    why.push(`${unstamped.length === 1 ? 'a commit carries' : `${unstamped.length} commits carry`} no verification stamp: ${named(unstamped)}. Implement step: ${STAMP_HINT}. ${rewrite}.`)
  }
  // GitHub stores a body typed in the browser with CRLF line ends; the readers know a shell's.
  if (!closesIssue(issue, github.slug).test(dropMarkdownCode(pr.body.replace(/\r\n?/g, '\n')))) {
    why.push(`the PR body does not close #${issue}, the linked issue. Review step: put "Closes #${issue}" in the PR body, outside code and HTML comments.`)
  }
  return why
}

// gh's words for an issue that is not there, or was deleted.
const GH_GONE = /HTTP (?:404|410)/

/**
 * GitHub, asked through `gh api` about the repository `slug`. gh failing in
 * any way but "not found" of an issue is GitHub not answering, and throws
 * Unanswered (halt.mjs), as it does for the hooks; so does an answer that
 * cannot be read.
 *
 * @param {string} slug `owner/name`
 * @returns {GitHub}
 */
export function realGitHub(slug) {
  /** @param {string[]} args @param {RegExp} [answers] gh's words for a no */
  const api = (args, answers = NO_ANSWERS) => answered('GitHub', spawnSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 }), answers)
  return {
    slug,
    pr(n) {
      const pr = JSON.parse(api([`repos/${slug}/pulls/${n}`]).stdout)
      if (typeof pr?.head?.ref !== 'string' || !Number.isInteger(pr.commits)) throw new Error(`gh printed what the trace cannot read of PR #${n}`)
      return { head: pr.head.ref, body: String(pr.body ?? ''), merged: pr.merged === true, commits: pr.commits }
    },
    // The commits the branch has and the PR's base branch does not, 250 at most.
    commits(n) {
      const lines = api(['--paginate', `repos/${slug}/pulls/${n}/commits?per_page=100`, '--jq', '.[] | {sha, message: .commit.message, parents: (.parents | length)}']).stdout
      return lines.split('\n').filter(Boolean).map(l => {
        const c = JSON.parse(l)
        if (typeof c?.sha !== 'string' || typeof c.message !== 'string' || !Number.isInteger(c.parents)) throw new Error(`gh printed what the trace cannot read of PR #${n}'s commits`)
        return { sha: c.sha, message: c.message, parents: c.parents }
      })
    },
    issueState(n) {
      const r = api([`repos/${slug}/issues/${n}`], GH_GONE)
      if (r.status !== 0) return 'MISSING'
      const issue = JSON.parse(r.stdout)
      if (issue?.pull_request) return 'MISSING'
      return issue?.state === 'open' ? 'OPEN' : 'CLOSED'
    },
  }
}
