// Renderings of the loop state: the one-line status, the next action, the
// LOOP.md progress file that survives context compaction, and the final
// report. Pure, so the mod can import it too.

/**
 * @typedef {import('./findings.mjs').Finding} Finding
 * @typedef {any} LoopState
 */

import { formatSize, growthWarning } from './size.mjs'

const TERMINAL = ['done', 'capped', 'stalled', 'aborted', 'paused']

/** @param {LoopState} s */
export function isActive(s) {
  return !!s && s.status === 'active'
}

/** @param {LoopState} s */
export function currentRound(s) {
  const r = s?.rounds?.at(-1)
  return r && !r.ended ? r : null
}

/**
 * Where the loop is inside the current round, derived from the state rather
 * than stored, so it can never disagree with it.
 *
 * @param {LoopState} s
 * @returns {'begin' | 'investigate' | 'review' | 'verify' | 'fix' | 'end' | 'report' | 'terminal'}
 */
export function phaseOf(s) {
  if (!s || TERMINAL.includes(s.status)) return 'terminal'
  const r = currentRound(s)
  if (!r) return 'begin'
  if (r.ingests === 0) return s.mode === 'debug' ? 'investigate' : 'review'
  if (missingLenses(s).length) return 'review'
  const all = /** @type {Finding[]} */ (Object.values(s.ledger.findings))
  if (all.some(f => f.status === 'candidate')) return 'verify'
  if (s.reviewOnly) return 'report'
  if (all.some(f => f.status === 'confirmed' && inScope(s, f))) return 'fix'
  return 'end'
}

/**
 * Configured lenses whose hunters have not been ingested this round, by
 * name: another lens (a typo, the default "general") never stands in for a
 * configured one. A `--none` ingest under the lens `scope`, which `ql`
 * accepts only for an empty scope, closes the review.
 *
 * @param {LoopState} s
 * @returns {string[]}
 */
export function missingLenses(s) {
  const r = currentRound(s)
  const done = new Set(r?.lensesDone ?? [])
  if (!r || done.has('scope')) return []
  const lenses = /** @type {string[]} */ (s.config?.review?.lenses ?? [])
  return lenses.filter(l => !done.has(l))
}

/**
 * Whether an edit made now must still be reviewed this round: the review
 * was closed by an empty-scope record that does not cover the fix step
 * (recorded before a debug fix, or with no important finding open, or the
 * fix step it covered has ended). `ql` drops such a record once the tree
 * changes, so `round end` asks for the review.
 *
 * @param {LoopState} s
 */
export function editsNeedReview(s) {
  const r = currentRound(s)
  return !!r?.lensesDone?.includes('scope') && !(r.scopeEmptyBeforeFix && !r.fixEndTree)
}

/** @param {LoopState} s @param {Finding} f */
export function inScope(s, f) {
  return f.origin === 'introduced' || !!s.config?.review?.fixPreExisting
}

/** @param {LoopState} s */
export function counts(s) {
  const all = /** @type {Finding[]} */ (Object.values(s?.ledger?.findings ?? {}))
  const open = all.filter(f => f.status === 'confirmed' && inScope(s, f))
  return {
    important: open.filter(f => f.severity === 'important').length,
    nit: open.filter(f => f.severity === 'nit').length,
    pending: all.filter(f => f.status === 'candidate').length,
    fixed: all.filter(f => f.status === 'fixed').length,
    rejected: all.filter(f => f.status === 'rejected').length,
    stuck: all.filter(f => f.status === 'stuck').length,
    preExisting: all.filter(f => f.status === 'confirmed' && f.origin === 'pre-existing').length,
  }
}

/** @param {LoopState} s */
export function statusLine(s) {
  if (!s) return 'quality-loop: no loop'
  const c = counts(s)
  const max = s.config?.loop?.maxRounds ?? '?'
  const failing = (s.lastRun?.results ?? []).filter((/** @type {any} */ r) => !r.ok).length
  const total = (s.lastRun?.results ?? []).length
  return [
    `quality-loop ${s.mode} · ${s.status}`,
    `round ${s.round}/${max}`,
    `phase ${phaseOf(s)}`,
    `open ${c.important} important, ${c.nit} nit`,
    c.pending ? `${c.pending} to verify` : '',
    `${c.fixed} fixed`,
    total ? `checks ${total - failing}/${total}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The next thing the orchestrator should do. Skills tell the model to run
 * `ql next` whenever it is unsure, which keeps a long run on the protocol
 * even after its context has been summarised.
 *
 * @param {LoopState} s
 */
export function nextAction(s) {
  if (!s) return 'No loop. Start one with `ql start --mode review|debug --goal "..."`.'
  switch (phaseOf(s)) {
    case 'terminal':
      if (s.status === 'paused' && s.reproPassedAtStart) {
        return 'Paused: the repro passes before any fix, so the bug does not reproduce and there is nothing to resume. Build a repro that fails while the bug exists, then `ql start --mode debug --repro "<command>"` again.'
      }
      return s.status === 'paused'
        ? 'Paused for the user. Resume with `ql resume` once they have answered.'
        : `Loop finished (${s.status}). Write the final report with \`ql report\` and present it.`
    case 'begin':
      return 'Start the next round: `ql round begin`.'
    case 'investigate':
      return 'Debug round: reproduce with the repro command, test hypotheses in parallel (`ql brief investigate --hypothesis "<h>"` for each), apply the smallest root-cause fix, then review the fix: `ql brief hunters`, one bug-hunter per brief, and `ql ingest <file> --lens <lens>` for each (`ql ingest --none --lens <lens>` for a lens that found nothing; `ql ingest --none --lens scope` only when the scope is empty). `ql round end` once every lens is in and verified.'
    case 'review': {
      const missing = missingLenses(s)
      const r = currentRound(s)
      if (r?.ingests && missing.length) {
        const total = s.config.review.lenses.length
        return `Review: ${total - missing.length} of ${total} lenses in; still to come: ${missing.join(', ')}. \`ql ingest <file> --lens <lens>\` as each hunter reports (\`ql ingest --none --lens <lens>\` if it found nothing); verifying candidates already in (\`ql brief verifiers\`) meanwhile is fine.`
      }
      return 'Review: `ql brief hunters`, then one bug-hunter subagent per printed line, all in one message, each prompted "Brief: <brief path>"; `ql ingest <output> --lens <lens>` as each reports (`ql ingest --none --lens scope` if the scope is empty).'
    }
    case 'verify':
      return 'Verify: `ql brief verifiers`, then one finding-verifier subagent per printed line, all in one message, each prompted "Brief: <brief path>"; then `ql vote <output files>`.'
    case 'fix': {
      const fix =
        'Fix: `ql brief fix --all`, one fixer subagent per printed line (a wave in parallel, waves in order); check each fixer\'s evidence, then `ql mark <id> fixed --reason "<evidence>"` or `ql mark <id> wontfix --reason "..."`.'
      if (!editsNeedReview(s)) return `${fix} Then \`ql round end\`.`
      const debugFix = s.repro && !s.lastRun?.results?.find((/** @type {any} */ x) => x.name === 'repro')?.ok
      return (
        `${fix}${debugFix ? ' The repro still fails, so this round\'s root-cause fix is still to come.' : ''} ` +
        'The scope was recorded empty, and that record does not cover an edit made now: once the tree changes, review it before `ql round end` ' +
        '(`ql brief hunters`, one bug-hunter per printed line, `ql ingest <output> --lens <lens>` for each; `ql next` says when).'
      )
    }
    case 'end':
      return 'Validate: `ql round end` (runs the checks, compares against the round start, reverts on regression, decides).'
    case 'report':
      return 'Review complete: `ql export --out <file>` for the verified findings, `ql finish`, then present `ql report`.'
  }
}

/**
 * The round-protocol step file (in `references/round/`) for the step the
 * loop is at, or null when no protocol step applies (a review-only report is
 * the review skill's own step). The orchestrator reads a step file only when
 * ql names it, so a run loads the steps it reaches and no others.
 *
 * @param {LoopState} s
 * @returns {string | null}
 */
export function stepFile(s) {
  switch (phaseOf(s)) {
    case 'begin':
      return '1-begin.md'
    case 'investigate':
    case 'review':
      return '2-review.md'
    case 'verify':
      return '3-verify.md'
    case 'fix':
      return '4-fix.md'
    case 'end':
      return '5-validate.md'
    case 'report':
      return null
    case 'terminal':
      return s && !s.reviewOnly ? 'decisions.md' : null
  }
}

const OPEN_ORDER = ['stuck', 'confirmed', 'candidate']
/** LOOP.md is re-injected after every compaction: it lists this many open findings at most. */
export const LOOP_MD_MAX_FINDINGS = 10

/** @param {Finding} f */
function findingRow(f) {
  const tag = f.origin === 'pre-existing' ? 'Pre-existing' : f.severity === 'important' ? 'Important' : 'Nit'
  return `| ${f.id} | ${tag} | ${f.status} | \`${f.file}:${f.line}\` | ${f.bugClass} | ${f.title.replace(/\|/g, '\\|')} |`
}

/**
 * LOOP.md: the run's durable memory. Read this file, not the scrollback.
 *
 * @param {LoopState} s
 */
export function renderLoopMd(s) {
  const all = /** @type {Finding[]} */ (Object.values(s.ledger.findings))
  const num = (/** @type {Finding} */ f) => Number(f.id.replace(/\D/g, '')) || 0
  // Most urgent first: stuck, then confirmed (important before nit), then candidates.
  const open = all
    .filter(f => OPEN_ORDER.includes(f.status))
    .sort(
      (a, b) =>
        OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status) ||
        (a.severity === b.severity ? 0 : a.severity === 'important' ? -1 : 1) ||
        num(a) - num(b),
    )
  const shown = open.slice(0, LOOP_MD_MAX_FINDINGS)
  const more = open.length - shown.length
  const closed = (/** @type {string} */ st) => all.filter(f => f.status === st).length
  const lines = [
    '# Quality loop',
    '',
    `- **Goal (finish line):** ${s.goal}`,
    `- **Mode:** ${s.mode}${s.repro ? ` · repro: \`${s.repro}\`` : ''}`,
    `- **Status:** ${s.status}${s.statusReasons?.length ? ` (${s.statusReasons.join('; ')})` : ''}`,
    `- **Round:** ${s.round} of ${s.config.loop.maxRounds} · **phase:** ${phaseOf(s)}`,
    `- **Base:** \`${s.baseCommit.slice(0, 12)}\``,
    ...(s.size?.start && s.size.now ? [`- **Size vs base:** ${formatSize(s.size.start)} at start → ${formatSize(s.size.now)} after the last round`] : []),
    '',
    '## Next action',
    '',
    nextAction(s),
    '',
    '## Open findings',
    '',
    shown.length ? '| id | tag | status | where | class | title |\n|---|---|---|---|---|---|' : '_none_',
    ...shown.map(findingRow),
    ...(more ? ['', `+${more} more: \`ql pending\` (to verify), \`ql open\` (to fix).`] : []),
    '',
    `Closed: ${closed('fixed')} fixed, ${closed('wontfix')} won't fix, ${closed('rejected')} rejected by verification.`,
    '',
    '## Rounds',
    '',
    ...(s.rounds.length
      ? s.rounds.map(
          (/** @type {any} */ r) =>
            `- Round ${r.n}: ${r.ended ? (r.reverted ? 'REVERTED' : 'kept') : 'in progress'}` +
            (r.ended ? ` · score ${r.startScore} → ${r.endScore} · ${r.found} new confirmed` : '') +
            (r.reasons?.length ? ` · ${r.reasons.join('; ')}` : ''),
        )
      : ['_none yet_']),
    '',
  ]
  return lines.join('\n')
}

/**
 * The final report: counts first, then what needs the user, what changed
 * and what was found.
 *
 * @param {LoopState} s
 */
export function renderReport(s) {
  const c = counts(s)
  const all = /** @type {Finding[]} */ (Object.values(s.ledger.findings))
  const blocked = all.filter(f => f.status === 'stuck' || (f.status === 'confirmed' && f.severity === 'important' && inScope(s, f)))
  const fixed = all.filter(f => f.status === 'fixed')
  const pre = all.filter(f => f.origin === 'pre-existing' && f.status === 'confirmed')
  const wontfix = all.filter(f => f.status === 'wontfix')
  // Open nits never block DONE, but they are still open: name them.
  const nits = all.filter(f => f.status === 'confirmed' && f.severity === 'nit' && f.origin !== 'pre-existing')
  const failing = (s.lastRun?.results ?? []).filter((/** @type {any} */ r) => !r.ok)
  const out = [
    `**${c.fixed} fixed · ${c.important} important open · ${c.stuck} stuck · ${c.preExisting} pre-existing · ${c.rejected} rejected as false positives** — status: ${s.status} after ${s.round} round(s).`,
    '',
    '## Blocked on me',
    '',
  ]
  if (s.statusReasons?.length && s.status !== 'done') out.push(...s.statusReasons.map((/** @type {string} */ r) => `- ${r}`))
  out.push(...blocked.map(f => `- ${f.id} \`${f.file}:${f.line}\` ${f.title}${f.status === 'stuck' ? ' (stuck after max attempts)' : ''}`))
  out.push(...failing.map((/** @type {any} */ r) => `- check \`${r.name}\` fails (log: ${r.logFile})`))
  const grew = s.mode === 'review' ? growthWarning(s.size, s.config?.loop?.maxGrowth ?? null) : null
  if (grew) out.push(`- ${grew}`)
  if (out.at(-1) === '') out.push('Nothing.')
  out.push('', '## Changed', '')
  out.push(...(fixed.length ? fixed.map(f => `- ${f.id} \`${f.file}:${f.line}\` ${f.title} — ${f.resolution}`) : ['Nothing.']))
  const reverted = s.rounds.filter((/** @type {any} */ r) => r.reverted)
  if (reverted.length) out.push(`- ${reverted.length} round(s) reverted for regressions: ${reverted.map((/** @type {any} */ r) => r.n).join(', ')}`)
  if (s.size?.start && s.size.now) out.push(`- size vs base: ${formatSize(s.size.start)} at start → ${formatSize(s.size.now)} now`)
  out.push('', '## Found', '')
  if (!pre.length && !wontfix.length && !nits.length) out.push('Nothing beyond the above.')
  out.push(...nits.map(f => `- [Nit] ${f.id} \`${f.file}:${f.line}\` ${f.title} (open)`))
  out.push(...pre.map(f => `- [Pre-existing] ${f.id} \`${f.file}:${f.line}\` ${f.title}`))
  out.push(...wontfix.map(f => `- [Won't fix] ${f.id} \`${f.file}:${f.line}\` ${f.title} — ${f.resolution}`))
  return out.join('\n') + '\n'
}
