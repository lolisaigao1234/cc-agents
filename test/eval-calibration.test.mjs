import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, schedule } from '../evals/review/calibration/calibrate.mjs';

/** @type {Record<string,any>} */
const expected = { findings: [{ category: 'in_diff_bug', bug_id: 'b' }], fixed: [{ bug_id: 'b', status: 'fixed' }], regressions: [], metrics: { recall: 1, fixed: 1 } };
const unit = { id: 'u1', presentations: ['original', 'layout', 'wording'], expected };
const bundle = { units: [unit] };
/** @returns {import('../evals/review/calibration/calibrate.mjs').GradeResult} */
const grade = () => ({ grade: { recall: 1, fixed: 1 }, detail: { findings: [{ category: 'in_diff_bug', bug_id: 'b', first_round: 1, repeats: 0, summary: 'bug', reason: 'evidence', location: 'a' }], fixed: [{ bug_id: 'b', status: 'fixed', reason: 'fixed' }], regressions: [], rounds: [{ round: 1, blocking_findings: 1 }], asked_human: false, review_happened: true } });
const rows = () => schedule(bundle).map(job => ({ ...job, status: 'ok', result: grade() }));

test('missing repeats and rejected calls block selection, without substituting grades', () => {
  assert.equal(schedule(bundle).length, 9);
  assert.equal(compare(bundle, rows().slice(1)).selection, 'BLOCK');
  const rejected = /** @type {any[]} */ (rows()); rejected[0] = { ...rejected[0], status: 'failure', failure_class: 'grader' };
  assert.equal(compare(bundle, rejected).selection, 'BLOCK');
});

test('reports presentation pairs separately from repeat pairs and ignores explanatory prose', () => {
  const rs = rows();
  rs[1].result.detail.findings[0].summary = 'equivalent wording';
  const report = compare(bundle, rs);
  assert.equal(report.selection, 'PASS');
  assert.deepEqual(report.comparisons, { repeat: { pairs: 9, disagreements: 0 }, presentation: { pairs: 27, disagreements: 0 } });
  rs[0].result.detail.findings[0].bug_id = 'wrong-target';
  const changed = compare(bundle, rs);
  assert.equal(changed.selection, 'BLOCK');
  assert.equal(changed.comparisons.repeat.disagreements, 2);
  assert.equal(changed.comparisons.presentation.disagreements, 6);
});

test('unanimous harmful or final-head errors still block against the answer key', () => {
  for (const field of ['harmful', 'fixed', 'reintroduced']) {
    const rs = rows();
    const b = structuredClone(bundle);
    b.units[0].expected.metrics[field] = 0;
    for (const r of rs) r.result.grade[field] = 1;
    assert.equal(compare(b, rs).selection, 'BLOCK');
  }
  const rs = rows(); assert.ok(rs[0].result.detail.fixed); rs[0].result.detail.fixed[0].status = 'not_fixed';
  assert.equal(compare(bundle, rs).selection, 'BLOCK');
  assert.equal(compare(bundle, [...rows(), rows()[0]]).selection, 'BLOCK');
});

test('historical runtime approval cannot approve a new driver or altered input bytes', async () => {
  const { requireApproval } = await import('../evals/review/calibration/calibrate.mjs');
  const current = { runtime_sha256: 'new-driver', preregistration_sha256: 'new-set', protocol_sha256: 'new-protocol' };
  assert.throws(() => requireApproval(null, current), /HUMAN approval/);
  assert.throws(() => requireApproval({ human_approval: true, approved_by: 'human', record: 'review', approved_at: '2026-11-03T00:00:00Z', runtime_sha256: 'old', preregistration_sha256: 'new-set', protocol_sha256: 'new-protocol' }, current), /HUMAN approval/);
  assert.doesNotThrow(() => requireApproval({ human_approval: true, approved_by: 'maintainer', record: 'human review record', approved_at: '2026-11-03T00:00:00Z', ...current }, current));
});

test('tool attempts, refusal events and missing protocol evidence cannot become a grade', async () => {
  const { validateResponse } = await import('../evals/review/calibration/calibrate.mjs');
  const valid = { raw_events: [], judge_provenance: { calls: [{ requested_model: 'gpt-6-astra', effort: 'high', service_tier: 'fast', audit: [] }] } };
  assert.doesNotThrow(() => validateResponse(valid));
  for (const raw_events of [[{ type: 'refusal' }], [{ response: { output: [{ content: [{ type: 'refusal', refusal: 'cannot grade' }] }] } }], [{ stop_reason: 'refusal' }], [{ item: { type: 'command_execution' } }]]) {
    assert.throws(() => validateResponse({ ...valid, raw_events }), /rejected/);
  }
  assert.throws(() => validateResponse({ raw_events: [] }), /protocol evidence/);
});
