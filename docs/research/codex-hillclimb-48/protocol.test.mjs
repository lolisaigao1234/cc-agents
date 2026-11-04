import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBoundFiles, DIR } from './freeze.mjs';
import { nativeReport } from './cli.mjs';
import { clusterUncertainty, makePlan, compareRows, requireApproval, sha, deriveV2Split } from './protocol.mjs';

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

test('baseline readiness requires valid exact keys, while candidate gaps do not hide a valid baseline', () => {
  const { protocol, baseline, candidate } = fixture();
  const valid = compareRows(protocol, 'screen', baseline);
  assert.equal(valid.gate, 'INCONCLUSIVE');
  assert.equal(valid.baseline.complete, true);
  assert.equal(valid.baseline.noise_floor, 0);
  assert.equal(valid.baseline.primary_recall_mean, 0.25);
  candidate[0].rounds = 999;
  assert.equal(compareRows(protocol, 'screen', [...baseline, ...candidate]).baseline.complete, true);
  for (const bad of [
    baseline.map((r, i) => i === 0 ? { ...r, rounds: 999 } : r),
    [...baseline, baseline[0]],
    [...baseline, { ...baseline[0], case_id: 'unexpected' }],
  ]) {
    const report = compareRows(protocol, 'screen', bad);
    assert.equal(report.gate, 'INCONCLUSIVE');
    assert.equal(report.baseline.complete, false);
    assert.equal(report.baseline.noise_floor, null);
    assert.equal(report.baseline.primary_recall_mean, null);
    assert.equal(report.baseline.per_case[0].metrics.rounds.mean, null);
    assert.equal(report.baseline.received, bad.length); // retain invalid raw rows
  }
  assert.equal(compareRows(protocol, 'screen', baseline, [{ arm: 'baseline' }]).baseline.complete, false);
  assert.equal(compareRows(protocol, 'screen', baseline, [{ arm: 'v13' }]).baseline.complete, true);
});

test('exact human approval is stage-specific without an invented exposure clearance mechanism', () => {
  const current = { manifest_sha256: 'a'.repeat(64), protocol_sha256: 'b'.repeat(64) };
  const synthetic = { human_approval: true, approved_by: 'SYNTHETIC TEST ONLY', record: 'fixture:offline',
    approved_at: '2026-11-04T00:00:00Z', scope: 'baseline-screen-only', ...current };
  assert.throws(() => requireApproval(null, current, 'baseline-screen-only'), /HUMAN/);
  assert.equal(requireApproval(synthetic, current, 'baseline-screen-only'), true);
  assert.throws(() => requireApproval(synthetic, current, 'candidate-screen-only'), /HUMAN/);
  assert.throws(() => requireApproval({ ...synthetic, manifest_sha256: 'old' }, current, 'baseline-screen-only'), /HUMAN/);
  assert.equal(requireApproval({ ...synthetic, exposure_review: null }, current, 'baseline-screen-only'), true);
  assert.throws(() => requireApproval({ ...synthetic, record: '' }, current, 'baseline-screen-only'), /HUMAN/);
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
    assert.equal(report.baseline.primary_recall_mean, null);
    assert.equal(report.baseline.complete, false);
    assert.equal(report.baseline.noise_floor, null);
    assert.equal(report.gate, 'INCONCLUSIVE');
    assert.ok(report.blockers.some(b => b.includes('missing retained evidence')));
    assert.ok(report.blockers.some(b => b.includes('observed serving substitution')));
  } finally { rmSync(flow, { recursive: true, force: true }); }
});

test('offline plan schedules native rep prefixes without executing or approving anything', () => {
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
  const plan = makePlan(protocol);
  assert.deepEqual(plan.stages.map(s => s.keys.length), [33, 33, 30, 30]);
  assert.deepEqual(plan.stages[0].keys.slice(0, 3).map(k => k.rep), [0, 1, 2]);
  assert.equal(plan.stages[0].keys[2].argv[plan.stages[0].keys[2].argv.indexOf('--reps') + 1], '3');
  assert.equal(plan.authorized, false);
  assert.ok(plan.stages.every(s => s.keys.every(k => !k.argv.includes('--approve-harness') && !k.argv.includes('--dry-run'))));
  assert.equal(new Set(plan.stages.flatMap(s => s.keys.map(k => k.key))).size, 126);
  assert.throws(() => makePlan({ ...protocol, holdout: [...protocol.holdout, protocol.screen[0]] }), /disjoint/);
});

// Synthetic retained native data, never a claim of a real competitor/judge run.
function retainedNativeFixture() {
  const { protocol, baseline } = fixture();
  const flow = mkdtempSync(join(tmpdir(), 'issue48-retained-'));
  const manifest = JSON.parse(readFileSync(new URL('./experiment-manifest.json', import.meta.url)));
  const write = (path, value) => {
    mkdirSync(join(flow, 'baseline', path, '..'), { recursive: true });
    writeFileSync(join(flow, 'baseline', path), JSON.stringify(value) + '\n');
  };
  const native = baseline.map(r => ({ prompt_id: r.case_id, rep: r.rep, status: 'ok', asked_human: 0, latency_s: 10,
    reviews_to_pass: 1, hook_denials: 0,
    grade: { recall: r.recall, fixed: r.fixed, harmful: 0, noise: 0, reviews: 1, precision: r.recall == null ? null : 1 },
    meta: { execution_config: manifest.expected_execution.baseline, tests: { before: true, after: true },
      codex: { variant: manifest.expected_execution.baseline.variant,
        calls: [{ requested_model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast', served_model: null }] },
      judge_provenance: { calls: [{ requested_model: 'gpt-6-astra', effort: 'high', service_tier: 'fast', served_model: null, audit: [] }] } } }));
  for (const r of native) {
    for (const path of [`traces/${r.prompt_id}_rep${r.rep}.json`, `judge-inputs/${r.prompt_id}_rep${r.rep}.json`,
      `codex-events/${r.prompt_id}_rep${r.rep}.jsonl`, `codex-events/${r.prompt_id}_rep${r.rep}_judge.jsonl`, `ref/${r.prompt_id}`])
      write(path, { synthetic: true });
    for (const role of ['agent', 'judge']) {
      const path = `attempts/${r.prompt_id}_rep${r.rep}/${role}-synthetic`;
      write(`${path}/request.json`, { synthetic: true, role });
      write(`${path}/outcome.json`, { synthetic: true, status: 'ok' });
      write(`${path}/index.json`, { files: ['outcome.json', 'request.json'].map(name => ({ path: name,
        sha256: sha(readFileSync(join(flow, 'baseline', path, name))) })) });
    }
  }
  const save = () => writeFileSync(join(flow, 'baseline', 'results.jsonl'), native.map(r => JSON.stringify(r)).join('\n') + '\n');
  save();
  return { flow, protocol, manifest, native, save };
}

test('native baseline provenance and evidence determine readiness before any candidate exists', () => {
  const f = retainedNativeFixture();
  try {
    const report = () => nativeReport(f.flow, f.protocol, f.manifest, 'screen');
    const good = report();
    assert.equal(good.gate, 'INCONCLUSIVE');
    assert.equal(good.baseline.complete, true);
    assert.equal(good.baseline.noise_floor, 0);
    // A failed candidate attempt cannot erase a valid #48 baseline.
    mkdirSync(join(f.flow, 'v13'));
    writeFileSync(join(f.flow, 'v13', 'errors.jsonl'), '{"synthetic":true,"status":"error"}\n');
    assert.equal(report().baseline.complete, true);
    f.native[0].meta.execution_config = { variant: 'incomparable' };
    f.save();
    assert.equal(report().baseline.primary_recall_mean, null);
    f.native[0].meta.execution_config = f.manifest.expected_execution.baseline;
    f.native[0].meta.codex.calls[0].served_model = 'wrong-model';
    f.save();
    const substitution = report();
    assert.equal(substitution.baseline.complete, false);
    assert.equal(substitution.baseline.primary_recall_mean, null);
    assert.equal(substitution.baseline.noise_floor, null);
    assert.equal(substitution.baseline.variability.macro_recalls, null);
    assert.ok(substitution.blockers.some(b => b.includes('observed serving substitution')));
    f.native[0].meta.codex.calls[0].served_model = null;
    f.save();
    rmSync(join(f.flow, 'baseline', 'traces/bug0_rep0.json'));
    const missing = report();
    assert.equal(missing.baseline.complete, false);
    assert.equal(missing.baseline.noise_floor, null);
    assert.equal(missing.baseline.received, 24);
    assert.ok(missing.blockers.some(b => b.includes('missing retained evidence')));
    writeFileSync(join(f.flow, 'baseline', 'traces/bug0_rep0.json'), '{"synthetic":true}\n');
    rmSync(join(f.flow, 'baseline', 'attempts/bug0_rep0/agent-synthetic/request.json'));
    const changed = report();
    assert.equal(changed.baseline.complete, false);
    assert.equal(changed.baseline.noise_floor, null);
    assert.ok(changed.blockers.some(b => b.includes('changed retained attempt membership/bytes')));
  } finally { rmSync(f.flow, { recursive: true, force: true }); }
});


test('baseline-only variability reports raw triples and PR-weighted replicate spread, not confidence coverage', () => {
  const { protocol, baseline } = fixture();
  // Two cases share PR0; PR1 has one. Case weighting would give the wrong
  // macro triple. Worked PR0=(.25,.5,.75), PR1=(1,.5,0), macro=(.625,.5,.375).
  protocol.screen = protocol.screen.slice(0, 3);
  protocol.screen[1].cluster = 'pr0';
  protocol.screen[2].cluster = 'pr1';
  const values = [[0, .5, 1], [.5, .5, .5], [1, .5, 0]];
  const rows = baseline.filter(r => ['bug0','bug1','bug2'].includes(r.case_id)).map(r => ({ ...r,
    recall: values[Number(r.case_id.slice(3))][r.rep] }));
  const report = compareRows(protocol, 'screen', rows);
  assert.equal(report.gate, 'INCONCLUSIVE');
  assert.equal(report.baseline.complete, true);
  assert.equal(report.baseline.noise_floor, .75); // mean of PR ranges .5 and 1
  assert.equal(report.baseline.primary_recall_mean, .5);
  const u = report.baseline.variability;
  assert.match(u.interpretation, /descriptive/i);
  assert.match(u.interpretation, /not.*confidence/i);
  assert.equal(u.primary_cases_scheduled, 3);
  assert.equal(u.primary_rows_scheduled, 9);
  assert.equal(u.primary_rows_valid, 9);
  assert.deepEqual(u.per_case[0], { id: 'bug0', cluster: 'pr0', recalls: [0,.5,1], min: 0, max: 1, range: 1 });
  assert.deepEqual(u.per_case[1].recalls, [.5,.5,.5]);
  assert.deepEqual(u.per_pr, [{ cluster: 'pr0', recalls: [.25,.5,.75] }, { cluster: 'pr1', recalls: [1,.5,0] }]);
  assert.deepEqual(u.macro_recalls, [.625,.5,.375]);
  assert.equal(u.macro_min, .375);
  assert.equal(u.macro_max, .625);
  assert.equal(u.macro_range, .25);
  const incomplete = compareRows(protocol, 'screen', rows.slice(1)).baseline.variability;
  assert.equal(incomplete.primary_rows_scheduled, 9);
  assert.equal(incomplete.primary_rows_valid, 8);
  assert.equal(incomplete.macro_recalls, null);
  assert.equal(incomplete.per_case[0].recalls, null);
  rows[0].rounds = 999;
  assert.equal(compareRows(protocol, 'screen', rows).baseline.variability.macro_range, null);
});

test('native report exposes descriptive coverage and evidence locators without answer text', () => {
  const f = retainedNativeFixture();
  try {
    const r = nativeReport(f.flow, f.protocol, f.manifest, 'screen');
    assert.deepEqual(r.baseline.per_case[0].metrics.precision, { known: 3, scheduled: 3, mean: 1 });
    assert.deepEqual(r.baseline.per_case[0].metrics.reviews_to_pass, { known: 3, scheduled: 3, mean: 1 });
    assert.deepEqual(r.baseline.per_case[0].metrics.hook_denials, { known: 3, scheduled: 3, mean: 0 });
    assert.deepEqual(r.baseline.per_case[0].tests_after, { known: 3, scheduled: 3, passed: 3, failed: 0 });
    assert.equal(r.normalized_rows[0].recall, .25);
    assert.equal(r.evidence[0].trace, 'baseline/traces/bug0_rep0.json');
    assert.equal(r.evidence[0].attempts, 'baseline/attempts/bug0_rep0');
    assert.equal(JSON.stringify(r).includes('SYNTHETIC TEST ONLY'), false);
  } finally { rmSync(f.flow, { recursive: true, force: true }); }
});


test('v2 plan deterministically moves the smallest optional whole primary PR cluster and retains all pilots', () => {
  const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
  assert.equal(protocol.version, 'codex-hillclimb-48-v2');
  const metadata = JSON.parse(readFileSync(new URL('./cases.metadata.json', import.meta.url)));
  const prior = { screen: [...protocol.screen, ...protocol.holdout.filter(c => c.cluster === 'pr14')],
    holdout: protocol.holdout.filter(c => c.cluster !== 'pr14'), pilot_ids: protocol.pilot_ids };
  const split = deriveV2Split(metadata, prior);
  assert.deepEqual(split.screen, protocol.screen);
  assert.deepEqual(split.holdout, protocol.holdout);
  assert.equal(split.moved_cluster, 'pr14');
  assert.deepEqual(protocol.screen.filter(c => c.kind === 'bug').map(c => c.cluster), ['pr16','pr17','pr18','pr24','pr35']);
  assert.deepEqual(protocol.holdout.filter(c => c.kind === 'bug').map(c => c.cluster), ['pr14','pr20','pr21','pr26','pr38']);
  assert.ok(protocol.pilot_ids.every(id => protocol.screen.some(c => c.id === id)));
  assert.equal(clusterUncertainty([.1,.2,.3,.4,.5]).lower95, .1);
  // This synthetic optional cluster has a second case: the whole PR must move.
  const meta = [...metadata, { ...metadata[0], id: 'conv-pr14', kind: 'convergence' }];
  const synthetic = deriveV2Split(meta, { ...prior, screen: [...prior.screen, { ...prior.screen.find(c => c.cluster === 'pr14'), id: 'conv-pr14', kind: 'convergence' }] });
  assert.ok(synthetic.holdout.some(c => c.id === 'conv-pr14'));
  assert.ok(!synthetic.screen.some(c => c.cluster === 'pr14'));
});
