export const meta = {
  name: 'latent-sweep',
  description: 'Sweep the existing code, not a diff, for bugs that are already there: one /code-review per area of the repository, in parallel',
  whenToUse: 'When the issue asks for a sweep of the existing code, before the first review round of the trace. No args needed.',
  phases: [
    { title: 'Map', detail: 'split the tracked hand-written code into areas one reviewer can cover' },
    { title: 'Sweep', detail: 'one /code-review of each area as it stands, with fresh context' },
  ],
}

// Old bugs hide outside any diff, so this reviews the code as it stands. It
// only reports: the session that called it decides what to fix here and what
// to file. Nothing is voted on or filtered.
const LEVEL = 'high'
const MAX_AREAS = 12

const AREAS = {
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'one directory or file, relative to the repository root' },
          files: { type: 'integer' },
          lines: { type: 'integer' },
        },
        required: ['path', 'files', 'lines'],
      },
    },
    left_out: { type: 'array', items: { type: 'string' }, description: 'paths or patterns left out, each with why' },
  },
  required: ['areas', 'left_out'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    via: { type: 'string', enum: ['code-review', 'self'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'file:line' },
          summary: { type: 'string' },
          failure: { type: 'string', description: 'the input, state or environment that goes wrong, and what happens then' },
          bug_class: { type: 'string', description: 'the general mistake this is one instance of' },
        },
        required: ['location', 'summary', 'failure', 'bug_class'],
      },
    },
  },
  required: ['via', 'findings'],
}

const NO_WRITES = 'Do not edit files, commit, or post to GitHub: only report.'

phase('Map')
const map = await agent(
  `List the areas of this repository to sweep for bugs. Use \`git ls-files\`, so only tracked files count.

An area is one directory or one file of hand-written code (source, scripts, hooks, tests) that one reviewer can read in a single pass: aim for at most about 3,000 lines, and split a larger directory by subdirectory or file. Put every hand-written code file in exactly one area. Areas must not overlap: no path may lie inside another area. Count config that changes how the code runs (hook manifests, package scripts, plugin manifests) as part of the area of the code it configures. Leave out \`.claude/\` (the agent's own tooling), docs, lockfiles, data and fixtures, and generated or vendored files (declarations copied from elsewhere, bundles), and list what you left out. ${NO_WRITES}`,
  { label: 'map areas', phase: 'Map', schema: AREAS, effort: 'low' },
)

// One spelling per path, and no area inside another: overlapping areas would
// review the same code twice and report each of its findings twice.
const norm = p => p.trim().replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.'
const within = (p, q) => p !== q && (q === '.' || p.startsWith(`${q}/`))
const named = (Array.isArray(map?.areas) ? map.areas : [])
  .filter(a => a && typeof a.path === 'string' && a.path.trim())
  .map(a => ({ ...a, path: norm(a.path) }))
  .filter((a, i, all) => all.findIndex(b => b.path === a.path) === i)
const listed = named.filter(a => !named.some(b => within(a.path, b.path)))
const nested = named.filter(a => !listed.includes(a)).map(a => a.path)
if (nested.length) log(`inside another area, so not swept on their own: ${nested.join(', ')}`)
const areas = listed.slice(0, MAX_AREAS)
const notSwept = listed.slice(MAX_AREAS).map(a => a.path)
if (!map) log('the area map failed: nothing was swept')
if (notSwept.length) log(`more than ${MAX_AREAS} areas; not swept: ${notSwept.join(', ')}`)
log(`sweeping ${areas.length} areas at /code-review ${LEVEL}`)

const sweep = a => agent(
  `Sweep \`${a.path}\` of this repository for bugs that are already there. This is not a diff review: the code is merged, and some of it has been there a long time. ${NO_WRITES}

Call the Skill tool with skill \`code-review\` and args \`${LEVEL} ${a.path}\` (no --fix, no --comment), so it reviews the code at that path as it stands. If the call is refused or unavailable, or it reviews only a diff, read every file in \`${a.path}\` yourself and review it for correctness bugs, and set via to "self".

Report correctness bugs only. Each needs a concrete input, state or environment that makes the code do the wrong thing, and what happens then. Follow a bug's path into callers and callees outside the area when it leads there. Leave out style, naming, cleanup, and speculation that names no failure. Report every bug you can support; do not rank or drop any.`,
  { label: `sweep ${a.path}`, phase: 'Sweep', schema: FINDINGS },
)

phase('Sweep')
const reports = await pipeline(areas, sweep)

const failed = areas.filter((_, i) => !reports[i]).map(a => a.path)
if (failed.length) log(`no report from: ${failed.join(', ')}`)

const findings = []
reports.forEach((r, i) => {
  if (!r) return
  for (const f of r.findings ?? []) findings.push({ area: areas[i].path, via: r.via, ...f })
})
log(`${findings.length} findings from ${reports.filter(Boolean).length} of ${areas.length} areas`)

return {
  level: LEVEL,
  areas: areas.map(a => a.path),
  not_swept: notSwept,
  left_out: map?.left_out ?? [],
  nested,
  failed,
  findings,
}
