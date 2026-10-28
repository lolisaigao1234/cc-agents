// Agent briefs as files. The orchestrator's context window is the loop's
// scarcest resource: instead of writing each subagent's brief inline (the
// lens, the diff, a finding's JSON, the checks), `ql brief` writes one
// markdown brief per agent under .quality-loop/work/round-<n>/briefs/ and
// prints one line per brief. The Agent prompt is then just "Brief: <path>".
// Reads the state; never changes it (ql stays the single writer of state).

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

import { slug } from './config.mjs'
import * as loop from './loop.mjs'
import { currentRound } from './report.mjs'
import { formatSize } from './size.mjs'
import { paths, readJson, writeJson, writeText } from './store.mjs'

/** @typedef {import('./findings.mjs').Finding} Finding */
/** @typedef {{ agent: string, brief: string, output: string, note?: string }} Brief */

/** Verifier stances, cycled per finding so each voter checks a different way. */
export const STANCES = {
  reproduce: 'make the failure happen: run the failure scenario through tests, a REPL or a throwaway script outside the repository.',
  trace: 'follow the data and control flow from the inputs to the cited line and show the wrong outcome is reachable.',
  intent: "check the behaviour against the change's intent, REVIEW.md, CLAUDE.md, comments, tests and docs.",
  counterexample: 'look for the guard, validation, type or caller contract that makes the scenario impossible.',
  'blast-radius': 'find who calls this and whether any real caller can hit the failure.',
}

const MAX_FILES_LISTED = 40

// The file-name form of a lens, finding id or bug class; config validation
// keeps two lenses from sharing one.
export { slug }

/**
 * Removes every round's work files (briefs, agents' outputs, scope diffs).
 * Round numbers and finding ids restart with each loop and the output paths
 * are built from them, so a file left by an earlier loop sits at the very
 * path a new agent writes to, and a glob over the round directory would
 * record it as this loop's. `ql start` calls this once the new loop exists.
 *
 * @param {string} root
 */
export function clearRoundWork(root) {
  const work = paths(root).work
  if (!existsSync(work)) return
  for (const name of readdirSync(work)) {
    if (/^round-\d+$/.test(name)) rmSync(join(work, name), { recursive: true, force: true })
  }
}

/**
 * The configured lens a --lens value names: itself, or the configured lens
 * whose file-name form (the one in a hunter brief's path) it is.
 *
 * @param {string[]} lenses
 * @param {string} given
 */
export function resolveLens(lenses, given) {
  if (lenses.includes(given)) return given
  const bySlug = lenses.filter(l => slug(l) === given)
  return bySlug.length === 1 ? /** @type {string} */ (bySlug[0]) : given
}

/** @param {string} root */
function context(root) {
  const s = loop.loadState(root)
  if (!s) throw new loop.LoopError('no loop has been started here: run `ql start` first')
  const r = currentRound(s)
  if (!r) throw new loop.LoopError('no round in progress: run `ql round begin`')
  const dir = join(paths(root).work, `round-${s.round}`)
  const rel = (/** @type {string} */ p) => relative(root, p)
  return { s, dir, briefs: join(dir, 'briefs'), rel }
}

/**
 * The change's intent: given with --intent (kept for the rest of this loop),
 * or the last one given in this loop.
 *
 * @param {string} root
 * @param {any} s
 * @param {string | undefined} given
 */
function intentOf(root, s, given) {
  const file = join(paths(root).work, 'intent.json')
  if (given?.trim()) {
    writeJson(file, { loopId: s.id, intent: given.trim() })
    return given.trim()
  }
  const saved = readJson(file)
  return saved?.loopId === s.id && typeof saved.intent === 'string' ? saved.intent : null
}

/** @param {string} root @param {any} s @param {string | null} intent */
function intentSection(root, s, intent) {
  return [
    '## Intent',
    '',
    intent ?? `Not stated: read the commit messages, \`git log --format=%s%n%b ${s.baseCommit.slice(0, 12)}..HEAD\`.`,
    '',
    `Finish line of this run: ${s.goal}`,
    '',
    `Repository rules: \`${relative(root, paths(root).reviewMd)}\`${existsSync(join(root, 'CLAUDE.md')) ? ', `CLAUDE.md`' : ''}.`,
  ]
}

/** @param {string} root */
const header = root => `Repository: \`${root}\` (relative paths below are from there; run commands from there).`

/** @param {Finding} f */
function findingForVerifier(f) {
  return {
    id: f.id,
    title: f.title,
    file: f.file,
    line: f.line,
    endLine: f.endLine,
    quote: f.quote,
    category: f.category,
    severity: f.severity,
    bugClass: f.bugClass,
    origin: f.origin,
    explanation: f.explanation,
    failureScenario: f.failureScenario,
    suggestedFix: f.suggestedFix,
  }
}

/** @param {unknown} v */
const json = v => ['```json', JSON.stringify(v, null, 2), '```']

/**
 * One brief per configured lens for the current round, from a freshly
 * written scope (so a fix made after `ql round begin` is in it).
 *
 * @param {string} root
 * @param {{ intent?: string }} [opts]
 * @returns {{ empty: boolean, briefs: Brief[] }}
 */
export function hunterBriefs(root, opts = {}) {
  const { s, dir, briefs, rel } = context(root)
  const sc = loop.scope(root)
  if (sc.empty) return { empty: true, briefs: [] }
  const intent = intentOf(root, s, opts.intent)
  // Later rounds look for what is new: the findings so far, as a file.
  const earlier = /** @type {Finding[]} */ (Object.values(s.ledger.findings)).filter(f => f.firstRound < s.round && f.status !== 'rejected')
  const knownFile = join(dir, 'known-findings.json')
  if (earlier.length) writeJson(knownFile, loop.exportFindings(root, { all: true }))
  const files = sc.files.slice(0, MAX_FILES_LISTED).map((/** @type {any} */ f) => `- ${f.status} \`${f.path}\` (+${f.added} -${f.removed})`)
  if (sc.files.length > MAX_FILES_LISTED) files.push(`- … ${sc.files.length - MAX_FILES_LISTED} more: see the diff`)
  return {
    empty: false,
    briefs: sc.lenses.map((/** @type {{ name: string, focus: string }} */ lens) => {
      const output = join(dir, `hunter-${slug(lens.name)}.json`)
      const brief = join(briefs, `hunter-${slug(lens.name)}.md`)
      writeText(
        brief,
        [
          `# Bug hunter brief: ${lens.name}`,
          '',
          header(root),
          '',
          '## Lens',
          '',
          `**${lens.name}**: ${lens.focus}`,
          '',
          ...intentSection(root, s, intent),
          '',
          '## Scope',
          '',
          `Round ${s.round}: ${sc.diffOnly ? 'only what changed since the last kept round (diff-only re-review)' : `the whole change against the base \`${s.baseCommit.slice(0, 12)}\``}.`,
          `Read the diff first: \`${rel(sc.diffFile)}\`. Read any file for context.`,
          '',
          `Changed files (${sc.files.length}):`,
          ...files,
          ...(earlier.length ? ['', `Findings from earlier rounds: \`${rel(knownFile)}\`. Report only what is new.`] : []),
          '',
          '## Output',
          '',
          `Write the JSON array of findings to \`${rel(output)}\` (\`[]\` when the change is sound under this lens).`,
          `Then reply with one line: \`${rel(output)}: <N> findings\`.`,
          '',
        ].join('\n'),
      )
      return { agent: 'bug-hunter', brief: rel(brief), output: rel(output), note: `lens ${JSON.stringify(lens.name)}` }
    }),
  }
}

/**
 * One brief per vote each candidate still needs, each with a stance the
 * finding's voters have not taken yet.
 *
 * @param {string} root
 * @param {{ intent?: string }} [opts]
 * @returns {Brief[]}
 */
export function verifierBriefs(root, opts = {}) {
  const { s, dir, briefs, rel } = context(root)
  const p = loop.pending(root)
  const intent = intentOf(root, s, opts.intent)
  const names = Object.keys(STANCES)
  /** @type {Brief[]} */
  const out = []
  for (const f of p.findings) {
    const taken = new Set(f.votes.map(v => v.voter))
    const free = []
    for (let round = 0; free.length < Math.max(1, f.votesNeeded); round++) {
      for (const stance of names) {
        const voterStance = round ? `${stance}${round + 1}` : stance
        if (free.length < Math.max(1, f.votesNeeded) && !taken.has(`${voterStance}-${f.id}`)) free.push({ stance, voterStance })
      }
    }
    for (const { stance, voterStance } of free) {
      const voter = `${voterStance}-${f.id}`
      const output = join(dir, `vote-${slug(f.id)}-${voterStance}.json`)
      const brief = join(briefs, `verify-${slug(f.id)}-${voterStance}.md`)
      writeText(
        brief,
        [
          `# Verifier brief: ${f.id}, stance ${stance}`,
          '',
          header(root),
          '',
          `Stance: **${stance}**: ${/** @type {Record<string, string>} */ (STANCES)[stance]}`,
          `Voter name: \`${voter}\``,
          '',
          ...intentSection(root, s, intent),
          '',
          '## Finding',
          '',
          ...json(findingForVerifier(f)),
          '',
          '## Output',
          '',
          `Write \`{ "id": "${f.id}", "voter": "${voter}", "verdict": "confirm|reject", "severity": "important|nit", "reason": "<evidence>" }\` to \`${rel(output)}\`.`,
          `Then reply with one line: \`${rel(output)}: 1 vote, <verdict>\`.`,
          '',
        ].join('\n'),
      )
      out.push({ agent: 'finding-verifier', brief: rel(brief), output: rel(output) })
    }
  }
  return out
}

/**
 * The fixer's view of the change's size: how big it is, and whether the
 * loop's fixes have already grown it past `loop.maxGrowth`.
 *
 * @param {ReturnType<typeof loop.sizeNow>} size
 */
function sizeSection(size) {
  return [
    `The change is ${formatSize(size.now)} against the base${size.start ? ` (${formatSize(size.start)} when the loop started)` : ''}. Keep it the size your findings need: the smallest fix, preferring one that deletes or narrows code over a new lock, cache, helper or option.`,
    // Cutting what earlier fixes added is the orchestrator's (4-fix.md): a fixer edits its own class only.
    ...(size.warning ? ['', 'The loop\'s fixes have already grown it past `loop.maxGrowth`: add nothing your findings do not need.'] : []),
  ]
}

/**
 * One brief per open bug class (or the one named), with every instance, the
 * verifiers' evidence and the check commands. Classes that share a file get
 * later waves: a wave's fixers run in parallel, waves one after another.
 *
 * @param {string} root
 * @param {{ bugClass?: string, intent?: string }} [opts]
 * @returns {Brief[]}
 */
export function fixBriefs(root, opts = {}) {
  const { s, dir, briefs, rel } = context(root)
  const groups = loop.openByClass(root)
  if (opts.bugClass && !groups[opts.bugClass]) {
    throw new loop.LoopError(`no open bug class "${opts.bugClass}"; open: ${Object.keys(groups).join(', ') || 'none'}`)
  }
  const intent = intentOf(root, s, opts.intent)
  const checks = [...s.config.checks, ...(s.repro ? [{ name: 'repro', cmd: s.repro, required: true }] : [])]
  const size = loop.sizeNow(root)
  /** @type {Set<string>[]} */
  const waves = []
  /** @type {Brief[]} */
  const out = []
  for (const [cls, fs] of Object.entries(groups)) {
    const files = new Set(fs.map(f => f.file))
    let wave = waves.findIndex(w => ![...files].some(f => w.has(f)))
    if (wave < 0) wave = waves.push(new Set()) - 1
    for (const f of files) waves[wave]?.add(f)
    if (opts.bugClass && cls !== opts.bugClass) continue
    const output = join(dir, `fix-${slug(cls)}.json`)
    const brief = join(briefs, `fix-${slug(cls)}.md`)
    writeText(
      brief,
      [
        `# Fixer brief: bug class \`${cls}\``,
        '',
        header(root),
        '',
        ...intentSection(root, s, intent),
        '',
        `## Findings (${fs.length}): fix every instance, and search for more`,
        '',
        ...json(
          fs.map(f => ({
            ...findingForVerifier(f),
            verifierEvidence: f.votes.filter(v => v.verdict === 'confirm').map(v => v.reason.slice(0, 800)),
          })),
        ),
        '',
        '## Size',
        '',
        ...sizeSection(size),
        '',
        '## Checks',
        '',
        'The loop runs every check after you and reverts the round on any regression. Run the ones that cover your change:',
        '',
        ...(checks.length ? checks.map(c => `- ${c.name}: \`${c.cmd}\``) : ['- none configured: find the repository\'s test command and say which you ran.']),
        '',
        '## Output',
        '',
        `Write the fix report JSON to \`${rel(output)}\`.`,
        `Then reply with one line: \`${rel(output)}: <N> fixed, <M> not fixed\`.`,
        '',
      ].join('\n'),
    )
    out.push({ agent: 'fixer', brief: rel(brief), output: rel(output), note: `wave ${wave + 1}` })
  }
  return out
}

/**
 * One brief for a root-cause investigator testing one hypothesis.
 *
 * @param {string} root
 * @param {{ hypothesis: string, k?: number, intent?: string }} opts
 * @returns {Brief}
 */
export function investigateBrief(root, opts) {
  const { s, dir, briefs, rel } = context(root)
  if (s.mode !== 'debug' || !s.repro) throw new loop.LoopError('`ql brief investigate` belongs to a debug loop (`ql start --mode debug --repro ...`)')
  if (!opts.hypothesis?.trim()) throw new loop.LoopError('ql brief investigate --hypothesis "<falsifiable hypothesis>" [--k N]')
  const used = existsSync(dir) ? readdirSync(dir).map(f => /^hypothesis-(\d+)\.json$/.exec(f)?.[1]) : []
  const usedBriefs = existsSync(briefs) ? readdirSync(briefs).map(f => /^investigate-(\d+)\.md$/.exec(f)?.[1]) : []
  const k = opts.k ?? 1 + Math.max(0, ...[...used, ...usedBriefs].filter(Boolean).map(Number))
  const intent = intentOf(root, s, opts.intent)
  const output = join(dir, `hypothesis-${k}.json`)
  const brief = join(briefs, `investigate-${k}.md`)
  writeText(
    brief,
    [
      `# Root-cause investigator brief: hypothesis ${k}`,
      '',
      header(root),
      '',
      `Symptom and finish line: ${s.goal}`,
      ...(intent ? ['', `Context: ${intent}`] : []),
      '',
      `Repro (exits non-zero while the bug exists): \`${s.repro}\``,
      '',
      '## Hypothesis',
      '',
      opts.hypothesis.trim(),
      '',
      '## Output',
      '',
      `Write the verdict JSON to \`${rel(output)}\`.`,
      `Then reply with one line: \`${rel(output)}: 1 hypothesis, <supported|refuted|inconclusive>\`.`,
      '',
    ].join('\n'),
  )
  return { agent: 'root-cause-investigator', brief: rel(brief), output: rel(output) }
}

/** @param {Brief} b */
export const briefLine = b => `${b.agent} ${b.brief} -> ${b.output}${b.note ? ` (${b.note})` : ''}`
