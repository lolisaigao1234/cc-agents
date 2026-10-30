export const meta = {
  name: 'review-finders',
  description: 'One review round: three independent /code-review finders at the Deep level and /security-review, in parallel, with every finding unioned',
  whenToUse: 'Each review round of the trace. args: {target, issue}, where target is what /code-review should review this round (the PR number on the first round, the new commits after it).',
  phases: [
    { title: 'Find', detail: 'three /code-review xhigh finders and /security-review, each with fresh context' },
  ],
}

// The repository's review depth: Deep, where one missed bug costs more than the
// extra review time. The finders run independently and their findings are
// unioned; nothing is voted on or dropped here.
const LEVEL = 'xhigh'
const FINDERS = 3

// args should be {issue, target}; a stringified object reaches the script as one string.
let a = args
if (typeof a === 'string') { try { const p = JSON.parse(a); if (p && typeof p === 'object') a = p } catch {} }
a = a && typeof a === 'object' && !Array.isArray(a) ? a : { target: a }
const target = a.target == null ? '' : String(a.target).trim()
const rawIssue = a.issue == null ? '' : String(a.issue).trim().replace(/^#/, '')
const issue = /^\d+$/.test(rawIssue) ? rawIssue : ''
if (rawIssue && !issue) log(`issue "${rawIssue}" is not a number: finders get no issue context`)
if (!target) log('no target given: finders review the current diff')

const FINDINGS = {
  type: 'object',
  properties: {
    via: { type: 'string', enum: ['code-review', 'security-review', 'self'] },
    root_cause: { type: 'string', description: "On a bug-fix issue: the bug's root cause, and whether the diff removes it or only its symptom. Empty otherwise." },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'file:line' },
          summary: { type: 'string' },
          failure: { type: 'string', description: 'the input or path that goes wrong, and what happens then' },
          bug_class: { type: 'string', description: 'the general mistake this is one instance of' },
          other_instances: { type: 'array', items: { type: 'string' }, description: 'file:line of every other place in the repository with the same mistake' },
        },
        required: ['location', 'summary', 'failure', 'bug_class', 'other_instances'],
      },
    },
  },
  required: ['via', 'root_cause', 'findings'],
}

const context = `${issue ? `Issue #${issue} states what this change is for (\`gh issue view ${issue} --comments\`). ` : ''}Do not edit files, commit, or post to GitHub: only report.`

const after = `For each finding, name its class of bug (the general mistake, not the one line) and search the whole repository for every other place that makes the same mistake, listing each. If the issue reports a bug, state its root cause and whether the diff removes it or only treats the symptom; a fix that leaves the root cause in place is itself a finding. Report every finding; do not drop, merge or rank any.`

const finder = i => agent(
  `You are bug finder ${i + 1} of ${FINDERS}, reviewing one change independently of the others. ${context}

Call the Skill tool with skill \`code-review\` and args \`${[LEVEL, target].filter(Boolean).join(' ')}\` (no --fix, no --comment). If that call is refused or unavailable, review the same diff yourself for correctness bugs and set via to "self".

${after}`,
  { label: `finder ${i + 1}`, phase: 'Find', schema: FINDINGS },
)

const security = () => agent(
  `You are the security reviewer for one change, working independently of the bug finders. ${context}

Call the Skill tool with skill \`security-review\`.${target ? ` This round reviews \`${target}\` (what the bug finders were given): report only findings in those changes.` : ''} If that call is refused or unavailable, do a security review of the branch's changes yourself and set via to "self".

${after}`,
  { label: 'security review', phase: 'Find', schema: FINDINGS },
)

phase('Find')
const lenses = [...Array.from({ length: FINDERS }, (_, i) => ({ source: `finder ${i + 1}`, run: () => finder(i) })),
  { source: 'security review', run: security }]
const reports = await parallel(lenses.map(l => l.run))

const failed = lenses.filter((_, i) => !reports[i]).map(l => l.source)
if (failed.length) log(`no report from: ${failed.join(', ')}`)

const findings = []
const rootCauses = []
reports.forEach((r, i) => {
  if (!r) return
  const source = `${lenses[i].source} (${r.via})`
  if (r.root_cause && r.root_cause.trim()) rootCauses.push({ source, root_cause: r.root_cause })
  for (const f of r.findings ?? []) findings.push({ source, ...f })
})
log(`${findings.length} findings from ${reports.filter(Boolean).length} of ${lenses.length} reviewers`)

return { level: LEVEL, target: target || '(current diff)', failed, root_causes: rootCauses, findings }
