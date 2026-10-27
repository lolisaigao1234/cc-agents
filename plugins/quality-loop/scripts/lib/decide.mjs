// The end-of-round decision: keep or revert the round's changes, and whether
// the loop is done, should continue, or must stop for a human. Pure.

/**
 * @typedef {{ startScore: number, endScore: number, reverted: boolean, found: number }} RoundSummary
 * @typedef {{
 *   mode: 'review' | 'debug',
 *   round: number,
 *   limits: { maxRounds: number, stallRounds: number },
 *   regressions: {
 *     newlyFailingRequired: string[],
 *     testCountDrops: { name: string, before: number, after: number }[],
 *     blockingWeakening: string[],
 *   },
 *   allowWeakening: boolean,
 *   requiredFailingNow: string[],
 *   baselineRequiredFailing: string[],
 *   reproOk: boolean | null,
 *   open: { important: number, nit: number, pending: number, stuck: number },
 *   maxReopens: number,
 *   history: RoundSummary[],
 *   startScore: number,
 *   found?: number,
 * }} DecideInput
 * @typedef {'done' | 'continue' | 'capped' | 'stalled'} LoopStatus
 */

/**
 * Lower is better. A failing required check outweighs any number of
 * findings; an unverified candidate weighs half an important finding.
 *
 * @param {{ failingRequired: number, important: number, nit: number, pending: number }} s
 */
export function scoreOf(s) {
  return s.failingRequired * 100 + s.important * 10 + s.nit + s.pending * 5
}

/**
 * @param {DecideInput} i
 * @returns {{ revert: boolean, status: LoopStatus, reasons: string[], endScore: number }}
 */
export function decideRound(i) {
  /** @type {string[]} */
  const reasons = []
  const r = i.regressions
  for (const name of r.newlyFailingRequired) reasons.push(`regression: required check "${name}" now fails`)
  for (const d of r.testCountDrops) reasons.push(`regression: "${d.name}" passed ${d.before} tests before, ${d.after} now`)
  if (!i.allowWeakening) {
    for (const w of r.blockingWeakening) reasons.push(`regression: checks weakened (${w})`)
  }
  const revert = reasons.length > 0

  const newFailing = i.requiredFailingNow.filter(n => !i.baselineRequiredFailing.includes(n))
  const endScore = revert
    ? i.startScore
    : scoreOf({ failingRequired: newFailing.length, important: i.open.important, nit: i.open.nit, pending: i.open.pending })

  const isClean = !revert && newFailing.length === 0 && i.open.important === 0 && i.open.pending === 0
  const reproOk = i.mode !== 'debug' || i.reproOk === true

  if (isClean && reproOk && i.open.stuck === 0) {
    return { revert, status: 'done', reasons: [...reasons, 'all required checks pass and no important findings remain open'], endScore }
  }
  if (i.open.stuck > 0) {
    reasons.push(`${i.open.stuck} finding(s) still open after the maximum fix attempts: needs a human`)
    return { revert, status: 'stalled', reasons, endScore }
  }
  if (i.maxReopens >= 2) {
    reasons.push('oscillation: a fixed finding came back twice; the fixes are fighting each other')
    return { revert, status: 'stalled', reasons, endScore }
  }

  const history = [...i.history, { startScore: i.startScore, endScore, reverted: revert, found: i.found ?? 0 }]
  const k = i.limits.stallRounds
  const recent = history.slice(-k)
  if (recent.length === k && recent.every(h => h.reverted || h.endScore >= h.startScore)) {
    reasons.push(`no progress in the last ${k} rounds (reverted or no score improvement)`)
    return { revert, status: 'stalled', reasons, endScore }
  }
  const window = history.slice(-(k + 1))
  if (
    window.length === k + 1 &&
    window.every((h, j) => j === 0 || h.found >= (window[j - 1]?.found ?? 0)) &&
    (window.at(-1)?.found ?? 0) > 0
  ) {
    reasons.push(`diverging: each of the last ${k + 1} rounds confirmed at least as many new issues as the one before`)
    return { revert, status: 'stalled', reasons, endScore }
  }
  if (i.round >= i.limits.maxRounds) {
    reasons.push(`round cap (${i.limits.maxRounds}) reached: reconsider the approach rather than iterating further`)
    return { revert, status: 'capped', reasons, endScore }
  }
  if (!reproOk) reasons.push('repro still fails')
  if (newFailing.length) reasons.push(`required checks failing: ${newFailing.join(', ')}`)
  if (i.open.important) reasons.push(`${i.open.important} important finding(s) open`)
  if (i.open.pending) reasons.push(`${i.open.pending} finding(s) still awaiting verification`)
  return { revert, status: 'continue', reasons, endScore }
}
