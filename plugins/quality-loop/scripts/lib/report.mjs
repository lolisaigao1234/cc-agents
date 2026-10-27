// Renderings of the loop state: the one-line status, the next action, the
// LOOP.md progress file that survives context compaction, and the final
// report. Pure, so the mod can import it too.

/**
 * @typedef {import('./findings.mjs').Finding} Finding
 * @typedef {any} LoopState
 */

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
 * Configured lenses whose hunters have not been ingested this round. A
 * `--none` ingest under the lens `scope` (an empty scope) closes the review.
 *
 * @param {LoopState} s
 * @returns {string[]}
 */
export function missingLenses(s) {
  const r = currentRound(s)
  const done = new Set(r?.lensesDone ?? [])
  if (!r || done.has('scope')) return []
  const lenses = /** @type {string[]} */ (s.config?.review?.lenses ?? [])
  if (done.size >= lenses.length) return []
  return lenses.filter(l => !done.has(l))
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
      return s.status === 'paused'
        ? 'Paused for the user. Resume with `ql resume` once they have answered.'
        : `Loop finished (${s.status}). Write the final report with \`ql report\` and present it.`
    case 'begin':
      return 'Start the next round: `ql round begin`.'
    case 'investigate':
      return 'Debug round: reproduce with the repro command, investigate hypotheses in parallel, apply the smallest root-cause fix, then review the fix (`ql scope`, bug hunters, `ql ingest`). If the fix needs no review findings, run `ql ingest --none`.'
    case 'review': {
      const missing = missingLenses(s)
      const r = currentRound(s)
      if (r?.ingests && missing.length) {
        const total = s.config.review.lenses.length
        return `Review: ${total - missing.length} of ${total} lenses ingested; still to come: ${missing.join(', ')}. Ingest each as its hunter reports (\`ql ingest <file> --lens <lens>\`, or \`--none\` when it found nothing). Verifying candidates already in (\`ql pending\`) meanwhile is fine.`
      }
      return 'Review: run `ql scope` for the diff, give each lens to its own bug-hunter subagent in parallel, then `ql ingest <file> --lens <lens>` for each (use `ql ingest --none --lens scope` if the scope is empty).'
    }
    case 'verify':
      return 'Verify: `ql pending --json`, have independent finding-verifier subagents vote on each candidate (the configured number of voters each), then `ql vote <file>`.'
    case 'fix':
      return 'Fix: `ql open --json`, fix each bug class at its root (every instance), add a regression test, then `ql mark <id> fixed --reason "<evidence>"` or `ql mark <id> wontfix --reason "..."`. Then `ql round end`.'
    case 'end':
      return 'Validate: `ql round end` (runs the checks, compares against the round start, reverts on regression, decides).'
    case 'report':
      return 'Review complete: `ql export --out <file>` for the verified findings, `ql finish`, then present `ql report`.'
  }
}

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
  const shown = all.filter(f => f.status !== 'rejected')
  const lines = [
    '# Quality loop',
    '',
    `- **Goal (finish line):** ${s.goal}`,
    `- **Mode:** ${s.mode}${s.repro ? ` · repro: \`${s.repro}\`` : ''}`,
    `- **Status:** ${s.status}${s.statusReasons?.length ? ` (${s.statusReasons.join('; ')})` : ''}`,
    `- **Round:** ${s.round} of ${s.config.loop.maxRounds} · **phase:** ${phaseOf(s)}`,
    `- **Base:** \`${s.baseCommit.slice(0, 12)}\``,
    '',
    '## Next action',
    '',
    nextAction(s),
    '',
    '## Findings',
    '',
    shown.length ? '| id | tag | status | where | class | title |\n|---|---|---|---|---|---|' : '_none yet_',
    ...shown.map(findingRow),
    '',
    `Rejected by verification: ${all.length - shown.length}`,
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
  if (out.at(-1) === '') out.push('Nothing.')
  out.push('', '## Changed', '')
  out.push(...(fixed.length ? fixed.map(f => `- ${f.id} \`${f.file}:${f.line}\` ${f.title} — ${f.resolution}`) : ['Nothing.']))
  const reverted = s.rounds.filter((/** @type {any} */ r) => r.reverted)
  if (reverted.length) out.push(`- ${reverted.length} round(s) reverted for regressions: ${reverted.map((/** @type {any} */ r) => r.n).join(', ')}`)
  out.push('', '## Found', '')
  if (!pre.length && !wontfix.length) out.push('Nothing beyond the above.')
  out.push(...pre.map(f => `- [Pre-existing] ${f.id} \`${f.file}:${f.line}\` ${f.title}`))
  out.push(...wontfix.map(f => `- [Won't fix] ${f.id} \`${f.file}:${f.line}\` ${f.title} — ${f.resolution}`))
  return out.join('\n') + '\n'
}
