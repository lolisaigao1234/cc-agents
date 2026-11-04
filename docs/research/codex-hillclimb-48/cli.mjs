#!/usr/bin/env node
// Read-only offline commands. There is deliberately no run/approve subcommand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertModel } from '../../../evals/review/lib/config.mjs';
import { compareRows, makePlan, requireApproval, sha } from './protocol.mjs';
import { DIR, ROOT, json, treeInventory, verifyExperiment } from './freeze.mjs';

function lines(path) {
  if (!existsSync(path)) return [];
  const st = lstatSync(path);
  assert.ok(st.isFile() && st.nlink === 1 && realpathSync(path) === path, 'unsafe result file');
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw || raw.endsWith('\n'), 'torn native JSONL file');
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw new Error('invalid native JSONL row'); }
  });
}

export function nativeReport(flow, protocol, manifest, split) {
  const rows = [], failures = [], issues = [], sources = [], evidence = [];
  if (existsSync(flow)) {
    assert.equal(realpathSync(flow), resolve(flow), 'flow symlink');
    assert.equal(lstatSync(flow).mode & 0o077, 0, 'restricted flow permissions required');
  }
  for (const arm of ['baseline', 'v13']) {
    const dir = join(flow, arm), native = lines(join(dir, 'results.jsonl'));
    const issue = (message, row) => issues.push({ arm, message, ...(row ? { case_id: row.prompt_id, rep: row.rep } : {}) });
    failures.push(...lines(join(dir, 'errors.jsonl')).map(f => ({ ...f, arm })));
    for (const file of ['results.jsonl','errors.jsonl']) if (existsSync(join(dir, file)))
      sources.push({ path: `${arm}/${file}`, sha256: sha(readFileSync(join(dir, file))) });
    for (const r of native) {
      assert.ok(protocol[split].some(c => c.id === r.prompt_id) && Number.isInteger(r.rep) && [0,1,2].includes(r.rep), 'unexpected native key');
      if (!isDeepStrictEqual(r.meta?.execution_config, manifest.expected_execution[arm])) issue('incomparable native execution identity', r);
      if (!isDeepStrictEqual(r.meta?.codex?.variant, manifest.expected_execution[arm].variant)) issue('native variant mismatch', r);
      const calls = r.meta?.codex?.calls ?? [], judge = r.meta?.judge_provenance?.calls ?? [];
      for (const call of [...calls, ...judge]) {
        try { assertModel(call.requested_model, call.served_model ? [call.served_model] : [], 'configured_only'); }
        catch { issue(`observed serving substitution: ${r.prompt_id}/${r.rep}`, r); }
        if (call.observed_service_tier != null && !['fast', 'priority'].includes(call.observed_service_tier))
          issue(`observed tier substitution: ${r.prompt_id}/${r.rep}`, r);
      }
      if (!calls.length || !judge.length || calls.some(c => c.requested_model !== 'gpt-6.1-sol' || c.effort !== 'high' || c.service_tier !== 'fast') ||
        judge.some(c => c.requested_model !== 'gpt-6-astra' || c.effort !== 'high' || c.service_tier !== 'fast' || c.audit?.some(e => e.event === 'PreToolUse')))
        issue(`protocol provenance: ${r.prompt_id}/${r.rep}`, r);
      if (r.meta?.retries || r.meta?.judge_retries || r.meta?.failed_attempts?.length) failures.push({ arm, kind: 'native_retry' });
      const grade = r.grade ?? {};
      rows.push({ arm, case_id: r.prompt_id, rep: r.rep, status: r.status,
        recall: grade.recall ?? null, fixed: grade.fixed ?? null, reintroduced: grade.reintroduced ?? null,
        harmful: grade.harmful, noise: grade.noise, rounds: grade.reviews,
        precision: grade.precision ?? null, reviews_to_pass: r.reviews_to_pass ?? null, hook_denials: r.hook_denials ?? null,
        asked_human: r.asked_human, tests_before: r.meta?.tests?.before, tests_after: r.meta?.tests?.after,
        latency_s: r.latency_s, in_tokens: r.in_tokens ?? null, out_tokens: r.out_tokens ?? null });
      evidence.push({ arm, case_id: r.prompt_id, rep: r.rep,
        trace: `${arm}/traces/${r.prompt_id}_rep${r.rep}.json`,
        judge_input: `${arm}/judge-inputs/${r.prompt_id}_rep${r.rep}.json`,
        agent_events: `${arm}/codex-events/${r.prompt_id}_rep${r.rep}.jsonl`,
        judge_events: `${arm}/codex-events/${r.prompt_id}_rep${r.rep}_judge.jsonl`,
        attempts: `${arm}/attempts/${r.prompt_id}_rep${r.rep}` });
      // Native success may precede a failed post-row write. Check these too.
      for (const path of [`traces/${r.prompt_id}_rep${r.rep}.json`, `judge-inputs/${r.prompt_id}_rep${r.rep}.json`,
        `codex-events/${r.prompt_id}_rep${r.rep}.jsonl`, `codex-events/${r.prompt_id}_rep${r.rep}_judge.jsonl`,
        ...(arm === 'baseline' ? [`ref/${r.prompt_id}`] : [])])
        if (!existsSync(join(dir, path))) issue(`missing retained evidence: ${path}`, r);
      const keyDir = join(dir, 'attempts', `${r.prompt_id}_rep${r.rep}`);
      if (!existsSync(keyDir)) issue(`missing key attempts: ${r.prompt_id}/${r.rep}`, r);
      else {
        const names = readdirSync(keyDir);
        if (!names.some(n => n.startsWith('agent-')) || !names.some(n => n.startsWith('judge-')))
          issue(`missing agent/judge attempts: ${r.prompt_id}/${r.rep}`, r);
      }
    }
    const attempts = join(dir, 'attempts');
    if (native.length && !existsSync(attempts)) issue('missing attempts');
    if (existsSync(attempts)) for (const key of readdirSync(attempts)) {
      const match = /^(.*)_rep([0-2])$/.exec(key);
      assert.ok(match && protocol[split].some(c => c.id === match[1]), 'unexpected retained attempt key');
      assert.equal(realpathSync(join(attempts, key)), join(attempts, key), 'attempt symlink');
      if (!match || !native.some(r => r.prompt_id === match[1] && r.rep === Number(match[2]))) issue(`unscored attempted key: ${key}`);
      for (const name of readdirSync(join(attempts, key))) {
        assert.match(name, /^(agent|judge)-[a-zA-Z0-9]+$/);
        const attempt = join(attempts, key, name);
        assert.equal(realpathSync(attempt), attempt, 'attempt directory symlink');
        if (existsSync(join(attempt, 'failure.json'))) failures.push({ arm, kind: 'retained_failure' });
        if (!existsSync(join(attempt, 'index.json'))) { issue(`unsealed attempt: ${key}/${name}`); continue; }
        const actual = treeInventory(attempt).filter(f => f.path !== 'index.json').map(({path,sha256}) => ({path,sha256}));
        if (!isDeepStrictEqual(actual, json(join(attempt, 'index.json')).files)) issue(`changed retained attempt membership/bytes: ${key}/${name}`);
      }
    }
  }
  const result = compareRows(protocol, split, rows, failures, issues);
  return { ...result, sources, normalized_rows: rows, evidence, failure_evidence_records: failures.length,
    failure_count_note: 'Sidecars/retry markers/retained failures can refer to the same attempt; these counts are not independent or summed usage.',
    observed_served_identity: 'Consult retained per-call provenance; configured settings alone are not observed identity.',
    api_equivalent_spend_usd: null, raw_review: 'PENDING independent attempt, human-stop, test and provenance review' };
}

// Read-only recomputation with the frozen driver: no auth/model import in report.
export function requireCalibrationPass(root, calibration) {
  assert.equal(calibration.version, 'astra-calibration-v5');
  assert.equal(calibration.required_selection, 'PASS');
  const result = spawnSync(process.execPath, [join(root, 'evals/review/calibration/calibrate.mjs'), 'report', '--version', 'v5',
    '--private', calibration.private_root, '--output', calibration.required_run], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, 'STOP: actual complete sealed calibration v5 PASS required before baseline; historical v4 PASS is insufficient');
  const report = JSON.parse(result.stdout);
  assert.ok(report.selection === 'PASS' && report.scheduled === 75 && report.received === 75 && report.blocker_count === 0 &&
    report.identity_evidence.total_calls === 138, 'STOP: incomplete calibration v5 evidence');
  return { selection: 'PASS', report_sha256: sha(readFileSync(join(calibration.required_run, 'report.json'))) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i=0; i<args.length; i+=2) {
    assert.ok(['--approval','--stage','--split'].includes(args[i]) && args[i+1], 'unknown or missing option');
    assert.ok(!Object.hasOwn(options, args[i]), 'duplicate option'); options[args[i]] = args[i+1];
  }
  assert.ok(['plan','gate','report'].includes(command), 'offline commands: plan | gate --stage ID [--approval PATH] | report --split screen|holdout');
  const { manifest, protocol, current } = verifyExperiment(ROOT);
  if (command === 'plan') {
    assert.equal(args.length, 0);
    const plan = makePlan(protocol);
    return { ...plan, ...current, calibration: manifest.calibration, variants: Object.fromEntries(Object.entries(manifest.expected_execution).map(([arm,c]) => [arm,c.variant])),
      environment_variables: manifest.variables, status: 'UNAPPROVED v3; parent review and exact stage-specific human approval including disclosed provenance limits required' };
  }
  if (command === 'gate') {
    const stage = protocol.stages.find(s => s.id === options['--stage']); assert.ok(stage, 'unknown stage');
    assert.ok(!options['--split']);
    requireApproval(options['--approval'] ? json(options['--approval']) : null, current, stage.approval_scope);
    const calibration = requireCalibrationPass(ROOT, manifest.calibration);
    return { structural_approval_match: true, execution_started: false, calibration, ...current,
      remaining: 'Independently authenticate human provenance, verify prerequisite stage report and bound independent provenance review; human flow harness approval and per-key inventory reconciliation remain mandatory. No state written.' };
  }
  const split = options['--split'];
  assert.ok(['screen','holdout'].includes(split) && args.length === 2, 'report needs exactly --split screen|holdout');
  return { ...current, split, ...nativeReport(join(protocol.flow_root, split), protocol, manifest, split) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
  .then(result => { console.log(JSON.stringify(result, null, 2)); if (result.gate && result.gate !== 'PASS') process.exitCode = 2; })
  .catch(error => { console.error(String(error.message)); process.exitCode = 2; });
