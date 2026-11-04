// Offline experiment analysis only. This module never imports a model adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha = data => createHash('sha256').update(data).digest('hex');

// Uses only the permitted metadata projection and immutable v1 membership.
// This repairs a pre-outcome partition; it cannot undo the v1 author's exposure.
export function deriveV2Split(metadata, v1) {
  const pool = [...v1.screen, ...v1.holdout];
  const selected = pool.map(c => {
    const m = metadata.find(m => m.id === c.id);
    assert.ok(m && !m.dropped && !(m.kind === 'clean' && m.exclude_from_harm), 'ineligible/missing metadata');
    const cluster = `pr${/^(?:.*-)?pr(\d+)/.exec(m.id)?.[1]}`;
    assert.match(cluster, /^pr\d+$/);
    assert.deepEqual(c, { ...m, cluster }, 'selected case differs from metadata');
    return c;
  });
  assert.equal(new Set(selected.map(c => c.id)).size, selected.length);
  const pilotClusters = new Set(v1.pilot_ids.map(id => {
    const c = v1.screen.find(c => c.id === id); assert.ok(c, 'pilot must remain in screen'); return c.cluster;
  }));
  const optional = v1.screen.filter(c => c.kind === 'bug' && !pilotClusters.has(c.cluster));
  assert.ok(optional.length, 'no optional primary cluster');
  const moved_cluster = optional.map(c => c.cluster).sort((a,b) => Number(a.slice(2)) - Number(b.slice(2)))[0];
  return { screen: v1.screen.filter(c => c.cluster !== moved_cluster),
    holdout: [...v1.screen.filter(c => c.cluster === moved_cluster), ...v1.holdout], moved_cluster };
}

export function requireApproval(approval, current, scope) {
  assert.ok(approval?.human_approval === true && approval.scope === scope &&
    typeof approval.approved_by === 'string' && approval.approved_by.trim() &&
    typeof approval.record === 'string' && approval.record.trim() && Number.isFinite(Date.parse(approval.approved_at)) &&
    Object.entries(current).every(([k, v]) => approval[k] === v), 'STOP: HUMAN approval required for exact experiment identities and stage scope');
  return true; // structural check only; cannot attest actual human authorship
}

export function makePlan(protocol) {
  assert.equal(protocol.repetitions, 3);
  assert.equal(new Set([...protocol.screen, ...protocol.holdout].map(c => c.id)).size,
    protocol.screen.length + protocol.holdout.length, 'case IDs must be unique/disjoint');
  const clusters = new Set(protocol.screen.map(c => c.cluster));
  assert.ok(protocol.holdout.every(c => !clusters.has(c.cluster)), 'PR clusters must be disjoint');
  assert.ok([...protocol.screen, ...protocol.holdout].every(c => !c.dropped && !(c.kind === 'clean' && c.exclude_from_harm)), 'ineligible selected case');
  return { authorized: false, execution: 'No processes launched; argv arrays are proposals, requiring exact stage approval and per-key preflight.',
    protocol_sha256: sha(JSON.stringify(protocol)),
    stages: protocol.stages.map(stage => ({ ...stage, keys: protocol[stage.split].flatMap(c => [0, 1, 2].map(rep => ({
      case_id: c.id, rep, key: `${sha(JSON.stringify(protocol))}/${stage.split}/${stage.arm}/${c.id}/${rep}`,
      argv: ['evals/review/run.mjs', '--flow', `${protocol.flow_root}/${stage.split}`, '--agent', 'codex',
        '--model', 'gpt-6.1-sol', '--variant', stage.arm, '--reps', String(rep + 1), '--concurrency', '1',
        '--timeout-s', String(protocol.limits.timeout_s), '--budget-usd', String(protocol.limits.budget_usd_argument), '--cases', c.id],
    }))) })) };
}

export function clusterUncertainty(differences) {
  assert.ok(differences.length > 0 && differences.length <= 20);
  assert.ok(differences.every(x => Number.isFinite(x) && Math.abs(x) <= 1));
  const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
  const subsetMeans = [-Infinity]; // empty subset always counts in sign-flip p
  for (let mask = 1; mask < 2 ** differences.length; mask++) {
    let sum = 0, n = 0;
    for (let i = 0; i < differences.length; i++) if (mask & (1 << i)) { sum += differences[i]; n++; }
    subsetMeans.push(sum / n);
  }
  subsetMeans.sort((a, b) => a - b);
  return { clusters: differences.length, mean,
    p_one_sided: subsetMeans.filter(x => x <= 0).length / subsetMeans.length,
    lower95: Math.max(-1, subsetMeans[Math.ceil(0.05 * subsetMeans.length) - 1]),
    assumption: 'Independent PR clusters; symmetric cluster differences about a common shift. Conditional, small-sample inference, not population proof.' };
}

const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const metric = (xs, scheduled = xs.length) => ({ known: xs.filter(Number.isFinite).length, scheduled,
  mean: xs.length && xs.length === scheduled && xs.every(Number.isFinite) ? average(xs) : null });
const unit = x => Number.isFinite(x) && x >= 0 && x <= 1;

// Public, normalized numeric-row seam. No findings/answer text is needed here.
export function compareRows(protocol, split, rows, failedAttempts = [], callerIssues = []) {
  const cases = protocol[split], blockers = [], byArm = {}, validation = {};
  assert.ok(Array.isArray(cases) && cases.length);
  const key = row => `${row.case_id}/${row.rep}`;
  const wanted = new Set(cases.flatMap(c => [0,1,2].map(rep => `${c.id}/${rep}`)));
  for (const arm of ['baseline', 'v13']) {
    const map = new Map(), invalidKeys = new Set(), reasons = [];
    const block = (message, k) => { reasons.push(`${arm}: ${message}`); if (k) invalidKeys.add(k); };
    for (const r of rows.filter(r => r.arm === arm)) {
      if (!wanted.has(key(r)) || map.has(key(r))) block(`unexpected/duplicate ${key(r)}`, key(r));
      const c = cases.find(c => c.id === r.case_id);
      if (r.status !== 'ok' || !Number.isInteger(r.rep) || ![0,1,2].includes(r.rep) ||
        !Number.isInteger(r.rounds) || r.rounds < 1 || r.rounds > 3 ||
        !Number.isInteger(r.harmful) || r.harmful < 0 || !Number.isInteger(r.noise) || r.noise < 0 ||
        ![0,1].includes(r.asked_human) || ![true,false,null].includes(r.tests_before) || ![true,false,null].includes(r.tests_after) ||
        !(Number.isFinite(r.latency_s) && r.latency_s >= 0) ||
        (c?.kind === 'bug' && (!unit(r.recall) || !unit(r.fixed))) ||
        (r.recall != null && !unit(r.recall)) || (r.fixed != null && !unit(r.fixed)) || (r.reintroduced != null && !unit(r.reintroduced)))
        block(`invalid ${key(r)}`, key(r));
      map.set(key(r), r);
    }
    for (const k of wanted) if (!map.has(k)) block(`missing ${k}`, k);
    for (const issue of callerIssues.filter(i => i.arm === arm || i.arm == null))
      block(issue.message, issue.case_id != null ? key(issue) : null);
    const failures = failedAttempts.filter(f => f.arm === arm || f.arm == null);
    if (failures.length) block(`failed attempts retained: ${failures.length}`);
    validation[arm] = { complete: reasons.length === 0, blockers: reasons,
      valid: [...map.values()].filter(r => wanted.has(key(r)) && !invalidKeys.has(key(r))) };
    blockers.push(...reasons);
    byArm[arm] = map;
  }
  if (rows.some(r => !['baseline','v13'].includes(r.arm))) blockers.push('unexpected arm');
  const baseline = baselineSummary(protocol, split, rows.filter(r => r.arm === 'baseline'), validation.baseline);
  const candidate = { ...baselineSummary(protocol, split, rows.filter(r => r.arm === 'v13'), validation.v13), range_not_used_as_gate_threshold: true };
  if (blockers.length) return { gate: 'INCONCLUSIVE', adoption: 'INCONCLUSIVE', blockers, baseline, candidate };
  const arms = Object.fromEntries(Object.entries(byArm).map(([arm, map]) => {
    const rs = [...map.values()];
    return [arm, Object.fromEntries(['recall','fixed','reintroduced','harmful','noise','rounds','asked_human','latency_s','in_tokens','out_tokens','precision','reviews_to_pass','hook_denials']
      .map(m => [m, metric(rs.map(r => r[m]))]))];
  }));
  const primary = cases.filter(c => c.kind === (protocol.analysis.primary_kind ?? 'bug'));
  const clusters = [...new Set(primary.map(c => c.cluster))];
  assert.ok(clusters.length, 'no primary bug clusters');
  const recall = c => [0,1,2].map(rep => byArm.baseline.get(`${c.id}/${rep}`).recall);
  const withinCluster = (cluster, fn) => average(primary.filter(c => c.cluster === cluster).map(fn));
  const noise = average(clusters.map(g => withinCluster(g, c => Math.max(...recall(c)) - Math.min(...recall(c)))));
  const differences = clusters.map(g => withinCluster(g, c => average([0,1,2].map(rep =>
    byArm.v13.get(`${c.id}/${rep}`).recall - byArm.baseline.get(`${c.id}/${rep}`).recall))));
  const uncertainty = clusterUncertainty(differences), threshold = Math.max(protocol.analysis.minimum_recall_gain, noise);
  const violations = [];
  for (const c of cases) for (const rep of [0,1,2]) {
    const k = `${c.id}/${rep}`, b = byArm.baseline.get(k), v = byArm.v13.get(k);
    if (c.kind === 'clean' && v.harmful > b.harmful) violations.push(`clean harm: ${k}`);
    if (v.rounds > b.rounds) violations.push(`rounds: ${k}`);
    if ((b.fixed == null) !== (v.fixed == null) || (b.reintroduced == null) !== (v.reintroduced == null)) blockers.push(`metric coverage mismatch: ${k}`);
    if (b.fixed != null && v.fixed < b.fixed) violations.push(`final-head fixes: ${k}`);
    if (b.reintroduced != null && v.reintroduced > b.reintroduced) violations.push(`reintroduced: ${k}`);
    if (v.tests_before === true && v.tests_after === false && !(b.tests_before === true && b.tests_after === false)) violations.push(`host test break: ${k}`);
  }
  const gate = blockers.length ? 'INCONCLUSIVE' : violations.length || uncertainty.mean <= threshold ? 'REJECT'
    : uncertainty.lower95 <= threshold ? 'INCONCLUSIVE' : 'PASS';
  return { gate, adoption: 'INCONCLUSIVE', blockers, violations, arms, baseline, candidate,
    recall: { ...uncertainty, noise_floor: noise, threshold, cluster_differences: Object.fromEntries(clusters.map((g,i) => [g, differences[i]])) },
    pending: 'Both split gates, independent raw-evidence/attempt/identity/test and legitimate-human-stop review, exact human approvals including the disclosed provenance limits required. No automatic adoption.' };
}

function baselineSummary(protocol, split, rows, validation) {
  const cases = protocol[split], primary = cases.filter(c => c.kind === 'bug');
  const complete = validation.complete, valid = validation.valid;
  const bugComplete = complete && primary.length > 0;
  const groups = [...new Set(primary.map(c => c.cluster))];
  const values = c => rows.filter(r => r.case_id === c.id).map(r => r.recall);
  const macro = fn => average(groups.map(g => average(primary.filter(c => c.cluster === g).map(fn))));
  const recalls = c => [0,1,2].map(rep => rows.find(r => r.case_id === c.id && r.rep === rep)?.recall);
  const replicates = bugComplete ? [0,1,2].map(rep => macro(c => recalls(c)[rep])) : null;
  return { scheduled: cases.length * 3, received: rows.length, valid_keys: valid.length, complete, blockers: validation.blockers,
    noise_floor: bugComplete ? macro(c => Math.max(...values(c)) - Math.min(...values(c))) : null,
    primary_recall_mean: bugComplete ? macro(c => average(values(c))) : null,
    variability: {
      interpretation: 'Empirical descriptive three-repeat variability, not population confidence coverage or proof of PR independence; a zero observed range does not establish zero noise.',
      primary_cases_scheduled: primary.length, primary_prs_scheduled: groups.length,
      primary_rows_scheduled: primary.length * 3,
      primary_rows_valid: valid.filter(r => primary.some(c => c.id === r.case_id)).length,
      per_case: primary.map(c => ({ id: c.id, cluster: c.cluster,
        recalls: bugComplete ? recalls(c) : null,
        min: bugComplete ? Math.min(...recalls(c)) : null,
        max: bugComplete ? Math.max(...recalls(c)) : null,
        range: bugComplete ? Math.max(...recalls(c)) - Math.min(...recalls(c)) : null })),
      per_pr: groups.map(g => ({ cluster: g, recalls: bugComplete ? [0,1,2].map(rep =>
        average(primary.filter(c => c.cluster === g).map(c => recalls(c)[rep]))) : null })),
      macro_recalls: replicates,
      macro_min: bugComplete ? Math.min(...replicates) : null,
      macro_max: bugComplete ? Math.max(...replicates) : null,
      macro_range: bugComplete ? Math.max(...replicates) - Math.min(...replicates) : null,
    },
    per_case: cases.map(c => ({ id: c.id, kind: c.kind, cluster: c.cluster,
      ...Object.fromEntries(['tests_before','tests_after'].map(m => {
        const xs = valid.filter(r => r.case_id === c.id).map(r => r[m]);
        return [m, { known: xs.filter(x => typeof x === 'boolean').length, scheduled: 3,
          passed: xs.filter(x => x === true).length, failed: xs.filter(x => x === false).length }];
      })),
      metrics: Object.fromEntries(['recall','fixed','reintroduced','harmful','noise','rounds','asked_human','latency_s','in_tokens','out_tokens','precision','reviews_to_pass','hook_denials']
        .map(m => { const value = metric(valid.filter(r => r.case_id === c.id).map(r => r[m]), 3);
          return [m, { ...value, mean: complete ? value.mean : null }]; })) })) };
}
