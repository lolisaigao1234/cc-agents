// The issue as the record that survives compaction (ADR 0006): what each
// agent is told about the linked issue when it starts or its context is
// compacted, and the nudge for a progress comment when it stops.

import { relatedDocNames } from './docs.mjs'
import { real } from './paths.mjs'
import { linkedIssue, tracedRoot } from './trace.mjs'

/** @typedef {import('./trace.mjs').World} World */

// How much of one part of the issue the context carries.
const PART = 1_500

/**
 * What an agent starting in `cwd` should know of the trace: the linked
 * issue's title, acceptance criteria and latest comment, and the related
 * docs it must read; or, off an issue's branch, the step to go back to.
 * Null outside a traced repository and under the bypass.
 *
 * @param {string} cwd @param {World} world @returns {string | null}
 */
export function issueContext(cwd, world) {
  if (world.env.TRACE_BYPASS === '1') return null
  const root = tracedRoot(real(cwd), world.git)
  if (!root) return null
  const linked = linkedIssue(root, world.git.branch(root), world)
  if ('why' in linked) return `Trace: ${linked.why}`
  const { n } = linked
  const issue = world.github.issue(root, n)
  const slug = world.git.origin(root)
  const view = `\`gh issue view ${n}${slug ? ` -R ${slug}` : ''}\``
  if (!issue) return `Trace: GitHub could not say what issue #${n} says. Read step: read it with ${view} before working.`
  const cut = (/** @type {string} */ text) => (text.length > PART ? `${text.slice(0, PART)} … (cut; read it all with ${view})` : text)
  const criteria = section(issue.body, /^acceptance criteria$/i)
  const last = issue.comments.at(-1)
  const { comments } = issue
  const docs = relatedDocNames(root, issue, world.git.headDocs(root))
  const parts = comments.length ? `title, body and ${comments.length} comment${comments.length === 1 ? '' : 's'}` : 'title and body'
  return [
    `Trace: this branch belongs to issue #${n}, "${issue.title}"${slug ? ` (${slug})` : ''}.`,
    criteria === null ? `The issue says:\n${cut(issue.body.trim())}\n` : `Acceptance criteria:\n${cut(criteria)}\n`,
    ...(last ? [`Latest comment, by ${last.author}${last.at ? ` on ${last.at.slice(0, 10)}` : ''}:\n${cut(last.body.trim())}\n`] : []),
    `Related docs, each to read in full before any edit or commit (the hooks refuse otherwise): ${docs.length ? `${docs.join(', ')}, and ` : ''}issue #${n}'s ${parts}.`,
    `When this and your memory disagree, the issue wins: reread it with ${view}.`,
  ].join('\n')
}

/**
 * @param {string} body markdown @param {RegExp} heading
 * @returns {string | null} the text under the first heading matching `heading`, up to the next heading
 */
function section(body, heading) {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex(l => heading.test(l.replace(/^#+\s*/, '').trim()) && /^#+\s/.test(l))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
}

/**
 * Why the agent should not stop yet: commits were pushed to the linked
 * issue's branch after the issue's last comment, so the issue does not say
 * what was done. A nudge: it asks once per pushed head, and never when the
 * hook already blocked this stop or cannot tell.
 *
 * @param {{ cwd?: string, session_id?: unknown, stop_hook_active?: unknown }} input
 * @param {World} world
 * @returns {string | null}
 */
export function stopNudge(input, world) {
  if (input.stop_hook_active === true || world.env.TRACE_BYPASS === '1') return null
  const root = tracedRoot(real(input.cwd ?? process.cwd()), world.git)
  if (!root) return null
  const branch = world.git.branch(root)
  const linked = linkedIssue(root, branch, world)
  if ('why' in linked || !branch) return null
  const pushed = world.git.pushed(root, branch)
  if (!pushed) return null
  const issue = world.github.issue(root, linked.n)
  if (!issue) return null
  const last = issue.comments.at(-1)?.at
  if (last && Date.parse(last) >= Date.parse(pushed.at)) return null
  if (!world.once(`stop-${String(input.session_id)}-${pushed.sha}`)) return null
  const { n } = linked
  const slug = world.git.origin(root)
  return `commits were pushed to ${branch} after the last comment on #${n}. Update step: post a progress comment on #${n} (progress, decisions, verification results), with \`gh issue comment ${n}${slug ? ` -R ${slug}` : ''}\`. This asks once.`
}
