// Which cases a run takes from data/cases.json. A case with a `dropped` reason
// stays in the data, so earlier arms' rows still name a known case, but no arm
// runs it again. Analysis of earlier rows should leave it out too.

/**
 * @param {any[]} all every case in cases.json
 * @param {{sweep?: boolean, kinds?: string[], ids?: string[]}} o
 * @returns {{cases: any[], skipped: {id: string, why: string}[]}}
 */
export function selectCases(all, { sweep = false, kinds, ids } = {}) {
  // A whole-tree sweep is a different task; only the sweep arm runs it.
  let cases = all.filter(c => c.mode !== 'sweep' || sweep);
  if (kinds) cases = cases.filter(c => kinds.includes(c.kind));
  if (ids) {
    const unknown = ids.filter(id => !cases.some(c => c.id === id));
    if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(', ')}`);
    cases = cases.filter(c => ids.includes(c.id));
  }
  const skipped = cases.filter(c => c.dropped).map(c => ({ id: String(c.id), why: String(c.dropped) }));
  return { cases: cases.filter(c => !c.dropped), skipped };
}
