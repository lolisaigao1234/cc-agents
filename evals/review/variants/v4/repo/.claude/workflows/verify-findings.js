export const meta = {
  name: 'verify-findings',
  description: 'Vote on the findings of a review round: three verifiers per finding, two must confirm; survivors come back tagged, sorted by severity and counted',
  whenToUse: 'After both reviews of a round, on the union of their findings. args: {base, findings}, where base is the branch the pull request merges into and each finding is {title, file, line, failure, source}.',
  phases: [
    { title: 'Vote', detail: 'three independent verifiers per finding; a finding survives when two confirm it is a real, non-style defect' },
  ],
}

// The filters between the reviewers and the author, as REVIEW.md states them:
// a finding needs a file and line and a failing input, skipped paths are not
// reviewed, a finding only about style, diagnostics or cleanup is dropped, two
// of three verifiers must confirm it, at most two Nits reach the author, and the
// rest come back sorted by severity under a count.
const VOTERS = 3
const NEEDED = 2
const MAX_NITS = 2
const SKIP = [/(^|\/)vendor\//, /(^|\/)node_modules\//, /(^|\/)package-lock\.json$/]
const SEVERITY = ['high', 'medium', 'low']
const TAGS = ['Important', 'Nit', 'Pre-existing']

// Bad input must not read as a clean round: a call whose findings cannot be
// found returns a request to call again, never "Nothing to fix.".
const parse = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return undefined } }
let a = parse(args)
if (Array.isArray(a)) a = { findings: a }
if (!a || typeof a !== 'object') a = {}
// A git ref only: the base is quoted into the verifiers' commands.
const base = typeof a.base === 'string' && /^[\w./-]+$/.test(a.base.trim()) && !a.base.trim().startsWith('-') ? a.base.trim() : 'main'
let list = parse(a.findings)
if (list === undefined) list = Object.values(a).map(parse).find(Array.isArray)
if (list && typeof list === 'object' && !Array.isArray(list)) list = [list]
if (!Array.isArray(list)) {
  log('no findings array in args')
  return {
    summary: 'No findings received: call again with args {base, findings: [{title, file, line, failure, source}]}, and findings: [] when both reviews found nothing.',
    findings: [], dropped: [],
  }
}
const raw = list

const text = v => (v == null ? '' : String(v).trim())
// Accepts `file` and `line`, or a `file` (or `location`) of the form path:line.
function normalize(f) {
  const o = f && typeof f === 'object' ? f : { title: f }
  let file = text(o.file ?? o.path ?? o.location)
  let line = Number.parseInt(text(o.line), 10)
  const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(file)
  if (m) { file = m[1]; if (!(line > 0)) line = Number.parseInt(m[2], 10) }
  file = file.replace(/^\.\//, '')
  line = line > 0 ? line : null
  const failure = text(o.failure ?? o.failure_scenario ?? o.scenario ?? o.evidence ?? o.description)
  const title = text(o.title ?? o.summary ?? o.finding) || failure.slice(0, 120) || (file ? `${file}${line ? `:${line}` : ''}` : '(untitled finding)')
  return { title, file, line, failure, source: text(o.source) || 'review' }
}

const dropped = []
const candidates = []
const NO_LINE = 'no file and line as evidence'
const NO_FAILURE = 'no failing input or path named'
for (const f of raw.map(normalize)) {
  if (!f.file || !f.line) dropped.push({ ...f, why: NO_LINE })
  else if (!f.failure) dropped.push({ ...f, why: NO_FAILURE })
  else if (SKIP.some(re => re.test(f.file))) dropped.push({ ...f, why: 'skipped path (REVIEW.md)' })
  else candidates.push(f)
}
if (dropped.length) log(`${dropped.length} dropped before the vote: no evidence or a skipped path`)

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: 'The cited file and line show the defect, and a concrete input or path fails.' },
    style_only: { type: 'boolean', description: 'The finding is only about style, diagnostics or cleanup.' },
    tag: { type: 'string', enum: TAGS },
    severity: { type: 'string', enum: SEVERITY },
    reason: { type: 'string', description: 'One or two sentences, citing file:line.' },
  },
  required: ['real', 'style_only', 'tag', 'severity', 'reason'],
  additionalProperties: false,
}

const prompt = (f, k) => `You are verifier ${k + 1} of ${VOTERS} for one finding from a code review of the branch checked out here; its pull request merges into \`${base}\`. Work alone and decide on the evidence, not on how plausible the finding sounds. Do not edit any file or change the checked-out branch.

Finding (from ${f.source}): ${f.title}
Cited at: ${f.file}:${f.line}
Claimed failure: ${f.failure}

Read REVIEW.md, the cited code and the code it calls, and \`git diff ${base}...HEAD -- ${f.file}\` (the rest of the diff only where the cited code calls into it; never vendor/, node_modules/ or package-lock.json). Then judge:
- real: true only if the cited file and line show the defect and you can name a concrete input or path on which it fails. If the line does not support it, if it rests on a guess from a name, or if you are unsure, it is false.
- style_only: true if it is only about style, diagnostics or cleanup, as REVIEW.md says.
- tag: Important (a defect this branch introduces, to fix before merge), Nit (a minor defect this branch introduces) or Pre-existing (the same failure happens on \`${base}\`: check it with \`git show ${base}:<file>\` or \`git diff ${base}...HEAD -- <file>\`, without switching branches, stashing or changing the working tree).
- severity: high, medium or low.
- reason: why, citing file:line.`

const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i }

function decide(f, votes) {
  const cast = votes.filter(Boolean)
  const keep = cast.filter(v => v.real && !v.style_only)
  const reasons = cast.map(v => v.reason)
  // A vote that could not be held drops nothing: the finding goes to the author unverified.
  if (cast.length < NEEDED) {
    log(`"${f.title}": only ${cast.length} of ${VOTERS} verifiers answered; passed on unverified`)
    return { ...f, survived: true, tag: 'Important', severity: 'medium', votes: `unverified (${cast.length} of ${VOTERS} answered)`, reasons }
  }
  if (keep.length < NEEDED) {
    const style = cast.filter(v => v.style_only).length
    const why = style >= NEEDED ? 'only style, diagnostics or cleanup' : `confirmed by ${keep.length} of ${VOTERS} verifiers`
    return { ...f, survived: false, why, reasons }
  }
  // The tag most verifiers gave; a tie goes to the one that leaves the author responsible.
  const count = t => keep.filter(v => v.tag === t).length
  const tag = [...TAGS].sort((x, y) => count(y) - count(x) || rank(TAGS, x) - rank(TAGS, y))[0]
  // The median severity; of two, the higher.
  const sev = keep.map(v => rank(SEVERITY, v.severity)).sort((x, y) => x - y)
  const severity = SEVERITY[sev[Math.floor((sev.length - 1) / 2)]] ?? 'low'
  return { ...f, survived: true, tag, severity, votes: `${keep.length}/${VOTERS}`, reasons: keep.map(v => v.reason) }
}

phase('Vote')
const decided = !candidates.length ? [] : await pipeline(candidates,
  (f, _, i) => parallel(Array.from({ length: VOTERS }, (__, k) => () =>
    agent(prompt(f, k), { label: `finding ${i + 1}, verifier ${k + 1}`, phase: 'Vote', schema: VERDICT })))
    .then(votes => decide(f, votes)))

const survivors = []
decided.forEach((d, i) => {
  if (!d) survivors.push({ ...candidates[i], tag: 'Important', severity: 'medium', votes: 'unverified (the vote failed)', reasons: [] })
  else if (!d.survived) dropped.push(d)
  else survivors.push(d)
})
survivors.sort((x, y) => rank(SEVERITY, x.severity) - rank(SEVERITY, y.severity) || rank(TAGS, x.tag) - rank(TAGS, y.tag))

const findings = []
let nits = 0
for (const s of survivors) {
  if (s.tag === 'Nit' && ++nits > MAX_NITS) { dropped.push({ ...s, why: `over the cap of ${MAX_NITS} Nits` }); continue }
  findings.push(s)
}
if (nits > MAX_NITS) log(`${nits - MAX_NITS} Nits dropped over the cap of ${MAX_NITS}`)

const n = t => findings.filter(f => f.tag === t).length
const toFix = n('Important') + n('Nit')
const parts = TAGS.map(t => [n(t), t]).filter(([c]) => c).map(([c, t]) => `${c} ${t}`).join(', ')
const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`
// A finding dropped for missing evidence may have lost it in the merge, so a
// round with such drops is never called clean: the summary says so.
const unproven = dropped.filter(d => d.why === NO_LINE || d.why === NO_FAILURE).length
const pre = n('Pre-existing')
let summary = toFix ? `${plural(findings.length, 'finding')}: ${parts}.`
  : unproven ? `0 findings to fix yet${pre ? `, ${pre} Pre-existing` : ''}: ${unproven} dropped for missing evidence.`
  : pre ? `Nothing to fix in this branch; ${plural(pre, 'Pre-existing finding')} to file as ${pre === 1 ? 'a new issue' : 'new issues'}.`
  : 'Nothing to fix.'
if (dropped.length) {
  const why = {}
  for (const d of dropped) why[d.why] = (why[d.why] ?? 0) + 1
  summary += ` Dropped: ${Object.entries(why).map(([w, c]) => `${c} × ${w}`).join('; ')}.`
}
if (unproven) summary += ' Re-send any finding dropped for missing evidence whose review gave a file, line and failing input; leave out one whose review gave none.'
log(summary)

return {
  summary,
  findings: findings.map(({ survived, why, ...f }, i) => ({ n: i + 1, ...f })),
  dropped: dropped.map(({ title, file, line, source, why }) => ({ title, file, line, source, why })),
}
