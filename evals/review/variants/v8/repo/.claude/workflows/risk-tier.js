export const meta = {
  name: 'risk-tier',
  description: 'Set the review risk tier of the change on this branch from its diff, then ask a second classifier whether it needs more scrutiny than its tier gives',
  whenToUse: 'At the start of the Review step, before the first review round. args: {base: "<the base branch>"}',
  phases: [
    { title: 'Tier', detail: 'classify the diff against .claude/risk-tiers.md' },
    { title: 'Escalate', detail: 'does this change need more scrutiny than its tier gives?' },
  ],
}

// The base ref goes into a git command an agent runs, so only a plain ref is taken.
// args may come as {base}, as that object JSON-encoded, or as the bare ref.
const parsedArgs = (() => {
  if (typeof args !== 'string') return args
  try { return JSON.parse(args) } catch { return { base: args } }
})()
const rawBase = parsedArgs && typeof parsedArgs === 'object' && typeof parsedArgs.base === 'string' ? parsedArgs.base.trim() : ''
const base = /^[A-Za-z0-9._\/@^~-]{1,200}$/.test(rawBase) && !rawBase.startsWith('-') ? rawBase : 'main'
const TIERS = ['Low', 'Medium', 'High']

// The sensitive paths of .claude/risk-tiers.md. The script matches them itself against
// the changed paths, so a sensitive path forces High whatever tier the classifier picks.
const SENSITIVE = [
  /^plugins\/[^/]+\/hooks\/hooks\.json$/,
  /^plugins\/[^/]+\/scripts\/hook\.mjs$/,
  /^plugins\/[^/]+\/bin\//,
  /^plugins\/[^/]+\/scripts\/lib\/(trace|guard|halt|archive)\.mjs$/,
  /^\.claude\/settings[^/]*\.json$/,
  /^\.claude\/trace\.json$/,
  /^\.claude-plugin\//,
  /^plugins\/[^/]+\/\.claude-plugin\//,
  /^plugins\/[^/]+\/skills\/setup\//,
  /^\.github\/workflows\//,
]

const TIER_SCHEMA = {
  type: 'object',
  properties: {
    changed_paths: { type: 'array', items: { type: 'string' }, description: `the output of git diff --name-only ${base}...HEAD, verbatim, one path per item` },
    tier: { type: 'string', enum: TIERS },
    reason: { type: 'string', description: 'one or two sentences: what in the diff sets the tier' },
  },
  required: ['changed_paths', 'tier', 'reason'],
}

const ESCALATION_SCHEMA = {
  type: 'object',
  properties: {
    escalate: { type: 'boolean' },
    reason: { type: 'string', description: 'one or two sentences: the risk a review at this tier would likely miss, or why the tier fits' },
  },
  required: ['escalate', 'reason'],
}

const READ_CHANGE = `Read \`.claude/risk-tiers.md\` in full, then the change itself: \`git diff --name-only ${base}...HEAD\` and \`git diff ${base}...HEAD\`. Do not edit anything.`

phase('Tier')
const first = await agent(
  `Classify the risk tier of the change on this branch, for its code review. ${READ_CHANGE}

The change sets the tier, not its author: judge it from the diff, not from what the issue, the PR or the commit messages say about it. Return the changed paths exactly as \`git diff --name-only\` prints them. When the change sits between two tiers, take the higher.`,
  { label: 'tier classifier', phase: 'Tier', schema: TIER_SCHEMA },
)

let tier = first && TIERS.includes(first.tier) ? first.tier : 'High'
if (!first || !TIERS.includes(first.tier)) log('The tier classifier returned no valid tier; starting strict at High.')
const changed = first && Array.isArray(first.changed_paths)
  ? first.changed_paths.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim().replace(/^"|"$/g, '').replace(/^\.\//, ''))
  : null
const sensitive = changed ? changed.filter(p => SENSITIVE.some(r => r.test(p))) : []
if (!changed) {
  // Without the changed paths the script cannot rule a sensitive path out.
  if (first) log('The tier classifier returned no changed paths; starting strict at High.')
  tier = 'High'
} else if (!changed.length) log('The tier classifier found no changed paths.')
if (sensitive.length) tier = 'High'

let escalated = false
let escalation_reason = ''
if (tier !== 'High') {
  phase('Escalate')
  const second = await agent(
    `A first classifier set the review risk tier of the change on this branch to ${tier}: ${first ? first.reason : ''}

Your question is a different one: does this particular change need more scrutiny than a ${tier} review gives, even though its tier says it does not? ${READ_CHANGE}

Weigh what the change touches, what reads or runs it, and what a mistake in it would cost. Say yes only when this change carries a risk a ${tier} review is likely to miss and a miss would be costly: it changes what runs, not just what is described, or it alters behaviour that other code or every agent relies on. Otherwise say no; most changes fit their tier.`,
    { label: 'escalation classifier', phase: 'Escalate', schema: ESCALATION_SCHEMA },
  )
  if (!second) log('The escalation classifier returned nothing; keeping the tier.')
  else if (second.escalate === true) {
    escalated = true
    escalation_reason = String(second.reason ?? '')
    tier = 'High'
  }
}

log(`Tier: ${tier}${escalated ? ' (escalated)' : ''}${sensitive.length ? ` (sensitive: ${sensitive.join(', ')})` : ''}`)
return {
  tier,
  classified_tier: first && TIERS.includes(first.tier) ? first.tier : null,
  reason: first ? String(first.reason ?? '') : 'the tier classifier returned nothing',
  changed_paths: changed,
  sensitive_paths: sensitive,
  escalated,
  escalation_reason,
  review: 'review at the depth .claude/risk-tiers.md gives this tier',
}
