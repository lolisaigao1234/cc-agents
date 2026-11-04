import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBoundFiles, DIR } from './freeze.mjs';
import { nativeReport } from './cli.mjs';
import { clusterUncertainty, makePlan, compareRows, requireApproval } from './protocol.mjs';

test('exact cluster sign flips and confidence inversion match a worked subset example', () => {
  // Six independent PR differences, in eighths. Of 64 sign assignments only
  // all-positive reaches the observed mean. The fourth ordered subset mean
  // (including the always-counted empty subset) is 2/8: 95% lower endpoint.
  const result = clusterUncertainty([1/8, 2/8, 3/8, 4/8, 5/8, 6/8]);
  assert.equal(result.mean, 7/16);
  assert.equal(result.p_one_sided, 1/64);
  assert.equal(result.lower95, 1/4);
  assert.equal(clusterUncertainty([1/4, 1/2]).lower95, -1);
  assert.equal(clusterUncertainty([1/4, 1/2]).p_one_sided, 1/4);
  assert.equal(clusterUncertainty([1/4, 1/4, 1/4, 1/4]).p_one_sided, 1/16);
  assert.equal(clusterUncertainty([1/4, 1/4, 1/4, 1/4]).lower95, -1);
});

const fixture = () => {
  const cases = Array.from({ length: 6 }, (_, i) => ({ id: `bug${i}`, kind: 'bug', cluster: `pr${i}` }));
  cases.push({ id: 'clean', kind: 'clean', cluster: 'pr6' }, { id: 'conv', kind: 'convergence', cluster: 'pr0' });
  const protocol = { screen: cases, repetitions: 3, analysis: { minimum_recall_gain: 0.05 } };
  const rows = arm => cases.flatMap(c => [0,1,2].map(rep => ({ arm, case_id: c.id, rep, status: 'ok',
    recall: c.kind === 'bug' ? (arm === 'baseline' ? 0.25 : 0.5) : null,
    fixed: c.kind === 'bug' ? 0.25 : null, reintroduced: null, harmful: 0, noise: 0, rounds: 1,
    asked_human: 0, tests_before: true, tests_after: true, latency_s: 10, in_tokens: null, out_tokens: null })));
  return { protocol, baseline: rows('baseline'), candidate: rows('v13') };
};

test('paired report uses PR clusters, retains unknown usage, and passes a quarter-point worked gain', () => {
  const { protocol, baseline, candidate } = fixture();
  const r = compareRows(protocol, 'screen', [...baseline, ...candidate]);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.recall.noise_floor, 0);
  assert.equal(r.recall.mean, 0.25);
  assert.equal(r.recall.lower95, 0.25);
  assert.equal(r.recall.clusters, 6); // 18 repeated bug rows are not 18 clusters
  assert.equal(r.arms.baseline.in_tokens.mean, null);
  assert.equal(r.candidate.per_case[0].metrics.recall.mean, 0.5);
  assert.equal(r.adoption, 'INCONCLUSIVE'); // numerical pass alone cannot promote
});

test('baseline repeat ranges are a noise floor, not independent comparison pairs', () => {
  const { protocol, baseline, candidate } = fixture();
  for (const r of baseline) if (r.recall != null) r.recall = [0, 0.25, 0.5][r.rep];
  const r = compareRows(protocol, 'screen', [...baseline, ...candidate]);
  assert.equal(r.recall.noise_floor, 0.5);
  assert.equal(r.recall.threshold, 0.5);
  assert.equal(r.gate, 'REJECT'); // 0.25 gain does not clear 0.5 measured noise
  assert.equal(compareRows(protocol, 'screen', baseline).baseline.noise_floor, 0.5);
});

test('failed attempts, gaps and observed clean harm cannot become a numerical winner', () => {
  const { protocol, baseline, candidate } = fixture();
  assert.equal(compareRows(protocol, 'screen', [...baseline, ...candidate], [{ failure_class: 'grader' }]).gate, 'INCONCLUSIVE');
  candidate.find(r => r.case_id === 'clean' && r.rep === 0).harmful = 1;
  assert.equal(compareRows(protocol, 'screen', [...baseline, ...candidate]).gate, 'REJECT');
  assert.equal(compareRows(protocol, 'screen', [...baseline, ...candidate.slice(1)]).gate, 'INCONCLUSIVE');
  assert.equal(compareRows(protocol, 'screen', [...baseline, ...candidate, candidate[0]]).gate, 'INCONCLUSIVE');
});

test('partial baseline reports show the scheduled repetition denominator and withhold the mean', () => {
  const { protocol, baseline } = fixture();
  const report = compareRows(protocol, 'screen', baseline.slice(1));
  assert.deepEqual(report.baseline.per_case[0].metrics.recall, { known: 2, scheduled: 3, mean: null });
  assert.equal(report.baseline.noise_floor, null);
});

test('exact human approval is stage-specific and cannot inherit calibration or omit exposure review', () => {
  const current = { manifest_sha256: 'a'.repeat(64), protocol_sha256: 'b'.repeat(64) };
  const synthetic = { human_approval: true, approved_by: 'SYNTHETIC TEST ONLY', record: 'fixture:offline',
    approved_at: '2026-11-04T00:00:00Z', scope: 'baseline-screen-only', ...current,
    exposure_review: { independent_reviewer: 'SYNTHETIC', record: 'fixture:exposure', holdout_acceptable: true } };
  assert.throws(() => requireApproval(null, current, 'baseline-screen-only'), /HUMAN/);
  assert.equal(requireApproval(synthetic, current, 'baseline-screen-only'), true);
  assert.throws(() => requireApproval(synthetic, current, 'candidate-screen-only'), /HUMAN/);
  assert.throws(() => requireApproval({ ...synthetic, manifest_sha256: 'old' }, current, 'baseline-screen-only'), /HUMAN/);
  assert.throws(() => requireApproval({ ...synthetic, exposure_review: null }, current, 'baseline-screen-only'), /exposure/);
});

test('experiment gate detects newly visible helpers as well as changed bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'issue48-freeze-'));
  try {
    mkdirSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, DIR, 'helper.mjs'), 'hello');
    const files = [{ path: `${DIR}/helper.mjs`, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }];
    verifyBoundFiles(root, files);
    writeFileSync(join(root, DIR, 'helper.mjs'), 'changed');
    assert.throws(() => verifyBoundFiles(root, files), /changed experiment input/);
    writeFileSync(join(root, DIR, 'new-helper.mjs'), 'hello');
    assert.throws(() => verifyBoundFiles(root, files), /membership/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native report reads runner rows and exposes substitution and missing retained evidence', () => {
  const { protocol, baseline, candidate } = fixture();
  const flow = mkdtempSync(join(tmpdir(), 'issue48-native-'));
  const manifest = { expected_execution: { baseline: { variant: { id: 'baseline' } }, v13: { variant: { id: 'v13' } } } };
  try {
    for (const [arm, rows] of [['baseline', baseline], ['v13', candidate]]) {
      mkdirSync(join(flow, arm));
      const native = rows.map(r => ({ prompt_id: r.case_id, rep: r.rep, status: 'ok', asked_human: 0, latency_s: 10,
        grade: { recall: r.recall, fixed: r.fixed, harmful: 0, noise: 0, reviews: 1 },
        meta: { execution_config: manifest.expected_execution[arm], tests: { before: true, after: true },
          codex: { variant: manifest.expected_execution[arm].variant,
            calls: [{ requested_model: 'gpt-6.1-sol', served_model: 'wrong-model', effort: 'high', service_tier: 'fast' }] },
          judge_provenance: { calls: [{ requested_model: 'gpt-6-astra', effort: 'high', service_tier: 'fast' }] } } }));
      writeFileSync(join(flow, arm, 'results.jsonl'), native.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    const report = nativeReport(flow, protocol, manifest, 'screen');
    assert.equal(report.baseline.primary_recall_mean, 0.25);
    assert.equal(report.gate, 'INCONCLUSIVE');
    assert.ok(report.blockers.some(b => b.startsWith('missing retained evidence')));
    assert.ok(report.blockers.some(b => b.startsWith('observed serving substitution')));
  } finally { rmSync(flow, { recursive: true, force: true }); }
});

test('offline plan schedules native rep prefixes without executing or approving anything', () => {
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
  const plan = makePlan(protocol);
  assert.deepEqual(plan.stages.map(s => s.keys.length), [36, 36, 27, 27]);
  assert.deepEqual(plan.stages[0].keys.slice(0, 3).map(k => k.rep), [0, 1, 2]);
  assert.equal(plan.stages[0].keys[2].argv[plan.stages[0].keys[2].argv.indexOf('--reps') + 1], '3');
  assert.equal(plan.authorized, false);
  assert.ok(plan.stages.every(s => s.keys.every(k => !k.argv.includes('--approve-harness') && !k.argv.includes('--dry-run'))));
  assert.equal(new Set(plan.stages.flatMap(s => s.keys.map(k => k.key))).size, 126);
  assert.throws(() => makePlan({ ...protocol, holdout: [...protocol.holdout, protocol.screen[0]] }), /disjoint/);
});
