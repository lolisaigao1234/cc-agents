#!/usr/bin/env node
// Calibration orchestration. V4 versions the tool-free instruction/context correction.
import assert from 'node:assert/strict';
import { sha, stable } from './utils.mjs';
export { sha } from './utils.mjs';
import { verifySnapshot, verifyEnvironment } from './snapshot.mjs';
import { retainCalls as retainSessionCalls } from '../lib/attempt-evidence.mjs';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{unit:string, presentation:string, repeat:number}} Job */
/** @typedef {{id:string, presentations:string[], expected:Record<string,any>, control_of?:string, inputs?:Record<string,string>}} Unit */
/** @typedef {{version?:string, units:Unit[], unresolved?:any[], exclusions?:string[]}} Bundle */
/** @typedef {{grade:Record<string,number>, detail:{findings:any[], fixed:any[]|null, regressions:any[]|null, rounds:any[], asked_human:boolean, review_happened:boolean}}} GradeResult */

/** @param {string} path @returns {any} */
const json = path => JSON.parse(readFileSync(path, 'utf8'));
/** @param {string} path @param {any} value */
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
/** @param {any[]} xs */
const sorted = xs => [...xs].sort((a, b) => stable(a).localeCompare(stable(b)));
/** @param {any[]|null} xs */
const labels = xs => xs == null ? null : sorted(xs.map(({ bug_id, category, status }) => ({ ...(category ? { category } : {}), bug_id, ...(status ? { status } : {}) })));

/** @param {Bundle} bundle @returns {Job[]} */
export function schedule(bundle) {
  return bundle.units.flatMap(u => u.presentations.flatMap(presentation => [0, 1, 2].map(repeat => ({ unit: u.id, presentation, repeat }))));
}

/** @param {GradeResult} g @returns {Record<string,any>} */
function signature(g) {
  return { findings: sorted(g.detail.findings.map(f => ({ category: f.category, bug_id: f.bug_id, first_round: f.first_round, repeats: f.repeats }))),
    fixed: labels(g.detail.fixed), regressions: labels(g.detail.regressions), rounds: sorted(g.detail.rounds),
    asked_human: g.detail.asked_human, review_happened: g.detail.review_happened, metrics: g.grade };
}
/** @param {Record<string,any>} expected @param {GradeResult} result */
function expectedMismatch(expected, result) {
  /** @type {Record<string,any>} */
  const actual = { findings: labels(result.detail.findings), fixed: labels(result.detail.fixed), regressions: labels(result.detail.regressions), metrics: result.grade };
  return Object.entries(expected).some(([field, want]) => field === 'metrics'
    ? Object.entries(want).some(([metric, value]) => actual.metrics[metric] !== value)
    : stable(actual[field]) !== stable(want));
}

/** @param {Bundle} bundle @param {any[]} rows */
export function compare(bundle, rows) {
  const jobs = schedule(bundle), key = (/** @type {Job} */ j) => `${j.unit}/${j.presentation}/${j.repeat}`;
  const wanted = new Set(jobs.map(key)), seen = new Map(), blockers = [];
  for (const row of rows) {
    const k = key(row);
    if (!wanted.has(k) || seen.has(k)) blockers.push({ kind: 'unexpected_or_duplicate', key: k });
    seen.set(k, row);
  }
  for (const job of jobs) {
    const row = seen.get(key(job));
    if (!row || row.status !== 'ok') { blockers.push({ kind: 'missing_or_failed', key: key(job) }); continue; }
    try {
      signature(row.result);
      if (expectedMismatch(bundle.units.find(u => u.id === job.unit)?.expected ?? {}, row.result)) blockers.push({ kind: 'expected_label', key: key(job) });
    } catch { blockers.push({ kind: 'invalid_result', key: key(job) }); }
  }
  const counts = { repeat: { pairs: 0, disagreements: 0 }, presentation: { pairs: 0, disagreements: 0 } };
  for (const u of bundle.units) {
    const successful = jobs.filter(j => j.unit === u.id).map(j => seen.get(key(j))).filter(r => r?.status === 'ok');
    for (let i = 0; i < successful.length; i++) for (let j = i + 1; j < successful.length; j++) {
      const a = successful[i], b = successful[j], kind = a.presentation === b.presentation ? 'repeat' : 'presentation';
      try {
        const left = signature(a.result), right = signature(b.result);
        counts[kind].pairs++;
        if (stable(left) !== stable(right)) {
          counts[kind].disagreements++;
          blockers.push({ kind: `${kind}_disagreement`, keys: [key(a), key(b)], fields: Object.keys(left).filter(f => stable(left[f]) !== stable(right[f])) });
        }
      } catch { /* Invalid results are already blockers. */ }
    }
  }
  // Controls must have independently preregistered changed labels, never post-hoc explanations.
  for (const u of bundle.units.filter(u => u.control_of)) {
    const parent = bundle.units.find(p => p.id === u.control_of);
    if (!parent || stable(parent.expected) === stable(u.expected)) blockers.push({ kind: 'ineffective_control', unit: u.id });
  }
  if (bundle.unresolved?.length) blockers.push({ kind: 'unresolved_preregistration', count: bundle.unresolved.length });
  const calls = rows.filter(r => r.status === 'ok').flatMap(r => r.result?.judge_provenance?.calls ?? []);
  const observedModels = [...new Set(calls.map(c => c.served_model).filter(Boolean))].sort();
  const observedTiers = [...new Set(calls.map(c => c.observed_service_tier).filter(Boolean))].sort();
  return { selection: blockers.length ? 'BLOCK' : 'PASS', scheduled: jobs.length, received: rows.length, comparisons: counts, blockers,
    exclusions: bundle.exclusions ?? [], adjudications: [], requested: { model: 'gpt-6-astra', effort: 'high', service_tier: 'fast' },
    observed_model: calls.length && calls.every(c => c.served_model) && observedModels.length === 1 ? observedModels[0] : null,
    observed_service_tier: calls.length && calls.every(c => c.observed_service_tier) && observedTiers.length === 1 ? observedTiers[0] : null,
    identity_evidence: { total_calls: calls.length, response_backed_model_calls: calls.filter(c => c.served_model).length, observed_models: observedModels, observed_service_tiers: observedTiers },
    api_equivalent_spend_usd: null };
}

/** @param {any} approval @param {Record<string,string>} current */
export function requireApproval(approval, current) {
  assert.ok(approval?.human_approval === true && typeof approval.approved_by === 'string' && approval.approved_by.trim() &&
    typeof approval.record === 'string' && approval.record.trim() && Number.isFinite(Date.parse(approval.approved_at)) &&
    Object.entries(current).every(([k, v]) => approval[k] === v),
  'STOP: HUMAN approval required for these exact calibration driver, protocol and preregistration bytes. Historical #44 flow approval is insufficient.');
}

/** @param {any} result */
export function validateResponse(result) {
  /** @param {any} value */
  const scan = value => {
    if (!value || typeof value !== 'object') return;
    assert.ok(value.type !== 'refusal' && !/refus/i.test(value.stop_reason ?? '') && !(typeof value.refusal === 'string' && value.refusal), 'judge refusal: rejected');
    for (const v of Object.values(value)) if (v && typeof v === 'object') scan(v);
  };
  scan(result.raw_events);
  const calls = result.judge_provenance?.calls;
  assert.ok(calls?.length && calls.every((/** @type {any} */ c) => c.requested_model === 'gpt-6-astra' && c.effort === 'high' && c.service_tier === 'fast'), 'invalid judge protocol evidence');
  for (const c of calls) assert.ok(!c.audit?.some((/** @type {any} */ e) => e.event === 'PreToolUse'), 'judge tool attempt: rejected');
  for (const e of result.raw_events ?? []) assert.ok(!['command_execution', 'mcp_tool_call', 'web_search', 'tool_call', 'file_change'].includes(e.item?.type), 'judge tool attempt: rejected');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC = join(ROOT, 'docs/research/codex-hillclimb-46/preregistration-v4.json');
const PROTOCOL = join(ROOT, 'evals/review/calibration/protocol-v4.json');
/** @param {string} root @param {string} path */
function safePath(root, path) {
  assert.ok(!isAbsolute(path) && path && !path.split('/').includes('..'), 'invalid relative artifact path');
  const absolute = resolve(root, path), real = realpathSync(absolute);
  assert.ok(real.startsWith(realpathSync(root) + '/'), 'artifact symlink escapes its root');
  return absolute;
}
/** @param {string} root @param {{path:string,sha256:string}[]} files */
function inventory(root, files) {
  return files.map(f => { const path = safePath(root, f.path); assert.equal(sha(readFileSync(path)), f.sha256, `changed bytes: ${f.path}`); return f; });
}
/** @param {string} privateRoot */
function load(privateRoot) {
  privateRoot = realpathSync(privateRoot);
  assert.ok(!privateRoot.startsWith(ROOT + '/') && privateRoot !== ROOT, 'answer keys must stay outside public git');
  assert.notEqual(spawnSync('git', ['-C', privateRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout?.trim(), 'true', 'answer keys cannot live in any git worktree');
  assert.equal(statSync(privateRoot).mode & 0o077, 0, 'restricted artifacts need mode 700');
  const prereg = json(PUBLIC), protocol = json(PROTOCOL);
  assert.equal(prereg.version, 'astra-calibration-v4');
  verifySnapshot(ROOT, privateRoot, prereg);
  verifyEnvironment(prereg.environment);
  assert.equal(sha(readFileSync(PROTOCOL)), prereg.protocol_sha256, 'changed protocol');
  assert.equal(protocol.version, prereg.version);
  const bundle = /** @type {Bundle} */ (json(join(privateRoot, 'bundle.json')));
  assert.equal(bundle.version, prereg.version);
  assert.deepEqual(bundle.units.map(u => ({ id: u.id, presentations: u.presentations, control_of: u.control_of ?? null })), prereg.units);
  assert.equal(schedule(bundle).length, prereg.scheduled_grades);
  // #44's verifier remains unchanged and deliberately stops on integration.
  // V4 verifies its own full membership above, never an old approval.
  return { prereg, protocol, bundle, privateRoot, current: { runtime_sha256: prereg.runtime.sha256, protocol_sha256: sha(readFileSync(PROTOCOL)), preregistration_sha256: sha(readFileSync(PUBLIC)) } };
}
/** @param {string} root @param {string} [prefix] @returns {string[]} */
function filesUnder(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(root, join(prefix, e.name)) : [join(prefix, e.name)]);
}
/** @param {string} root */
function seal(root) {
  const files = filesUnder(root).sort().map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
  write(join(root, 'index.json'), { files });
}
// Only allowlisted request/response evidence is retained; never copy runtime auth.
/** @param {string} work @param {string} attempt */
function retainCalls(work, attempt) {
  retainSessionCalls(join(work, 'judge-home'), join(attempt, 'calls'));
}
/** @param {ReturnType<typeof load>} state @param {string} output @param {string} [approvalPath] */
async function run(state, output, approvalPath) {
  const { prereg, bundle, privateRoot, current } = state;
  // Gate BEFORE importing runtime/auth code or acquiring subscription auth.
  requireApproval(approvalPath ? json(approvalPath) : null, current);
  assert.ok(approvalPath);
  const { lockCodexAuth, resolveCodex } = await import('../lib/codex.mjs');
  const { grade } = await import(String('../lib/grade.mjs'));
  const { CODEX_JUDGE } = await import('../lib/config.mjs');
  const bin = resolveCodex();
  assert.equal(realpathSync(bin), prereg.environment.codex_runtime_files.find((/** @type {any} */ f) => f.name === 'codex').path,
    'selected Codex must match the approved binary');
  assert.ok(output && isAbsolute(output) && !existsSync(output), 'run needs a fresh absolute restricted output directory outside git');
  const parent = realpathSync(dirname(output));
  assert.ok(parent !== ROOT && !parent.startsWith(ROOT + '/'), 'output parent resolves inside public git');
  assert.notEqual(spawnSync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout?.trim(), 'true', 'output cannot live in any git worktree');
  const fd = openSync('/tmp/cc-agents-43/model-run.lock', 'a', 0o600);
  // flock(2) locks the inherited open-file description; parent fd keeps it held.
  const locked = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  if (locked.status !== 0) { closeSync(fd); throw new Error('exclusive model-run.lock unavailable; no calls made'); }
  let auth;
  try {
    auth = lockCodexAuth();
    mkdirSync(output, { mode: 0o700 });
    copyFileSync(approvalPath, join(output, 'approval.json'));
    copyFileSync(PUBLIC, join(output, 'preregistration.json'));
    copyFileSync(PROTOCOL, join(output, 'protocol.json'));
    write(join(output, 'run.json'), { ...current, approval_sha256: sha(readFileSync(approvalPath)), schedule: schedule(bundle), started_at: new Date().toISOString(), concurrency: 1 });
    const rows = [];
    for (const job of schedule(bundle)) {
      const u = bundle.units.find(u => u.id === job.unit);
      assert.ok(u?.inputs);
      const input = json(safePath(privateRoot, u.inputs[job.presentation]));
      const attempt = join(output, `${job.unit}-${job.presentation}-${job.repeat}`), work = join(attempt, 'runtime');
      mkdirSync(attempt, { mode: 0o700 });
      write(join(attempt, 'request.json'), { ...job, input, judge: CODEX_JUDGE, model_verification: 'configured_only', ...current });
      let row;
      try {
        const result = await grade({ ...input, bugs: new Map(input.bugs.map((/** @type {any} */ b) => [b.id, b])), work, judgeConfig: CODEX_JUDGE, codex: { auth, bin }, modelVerification: 'configured_only' });
        validateResponse(result);
        row = { ...job, status: 'ok', result };
      } catch (error) {
        const e = /** @type {any} */ (error);
        row = { ...job, status: 'failure', failure_class: e.failure_class ?? 'grader', message: String(e.message), events: e.events ?? null,
          judge_usage: e.judge_usage ?? null, judge_requested_model: e.judge_requested_model ?? null, judge_calls: e.judge_calls ?? null };
      } finally {
        try {
          retainCalls(work, attempt);
          rmSync(work, { force: true, recursive: true });
        } catch (retentionError) {
          // Preserve incomplete raw evidence for recovery without retaining auth.
          rmSync(join(work, 'judge-home/.codex/auth.json'), { force: true });
          throw retentionError;
        }
      }
      write(join(attempt, 'outcome.json'), row); seal(attempt); rows.push(row);
      // Every preregistered repeat is a new retained attempt, never a replacement.
      console.log(`${rows.length}/${schedule(bundle).length}: ${job.unit}/${job.presentation}/${job.repeat} ${row.status}`);
    }
    const report = compare(bundle, rows);
    write(join(output, 'report.json'), report); seal(output);
    if (report.selection === 'BLOCK') process.exitCode = 2;
  } finally { auth?.release(); closeSync(fd); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  assert.ok(['plan', 'run', 'report'].includes(command), 'usage: calibrate.mjs plan|run|report --private DIR [--output DIR] [--approval FILE] [--version v4]');
  assert.equal(args.length % 2, 0);
  /** @type {Record<string,string>} */
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--private', '--output', '--approval', '--version'].includes(args[i]) && !Object.hasOwn(options, args[i]), 'unknown/duplicate option');
    options[args[i]] = args[i] === '--version' ? args[i + 1] : resolve(args[i + 1]);
  }
  assert.ok(!options['--version'] || options['--version'] === 'v4', 'Historical calibration reproductions require their original frozen commit; this CLI selects v4 only.');
  const state = load(options['--private']);
  if (command === 'plan') console.log(JSON.stringify({ ...state.current, protected_harness_sha256: state.prereg.protected_harness.sha256, expected_judge_requests: state.prereg.expected_judge_requests, scheduled_grades: schedule(state.bundle).length,
    status: 'BLOCK: exact new driver/protocol/preregistration requires HUMAN approval; no live calibration results', concurrency: 1 }, null, 2));
  if (command === 'run') await run(state, options['--output'], options['--approval']);
  if (command === 'report') {
    const output = options['--output'];
    const index = json(join(output, 'index.json')); inventory(output, index.files);
    const recorded = json(join(output, 'run.json'));
    assert.ok(Object.entries(state.current).every(([k, v]) => recorded[k] === v), 'cannot pool different protocols/preregistrations');
    const rows = schedule(state.bundle).map(j => json(join(output, `${j.unit}-${j.presentation}-${j.repeat}/outcome.json`)));
    // Reports with labels/raw material stay in the restricted run directory.
    const report = compare(state.bundle, rows);
    assert.equal(stable(report), stable(json(join(output, 'report.json'))), 'report differs from retained outcomes');
    console.log(JSON.stringify({ selection: report.selection, scheduled: report.scheduled, received: report.received, comparisons: report.comparisons, blocker_count: report.blockers.length, requested: report.requested, observed_model: report.observed_model, observed_service_tier: report.observed_service_tier, identity_evidence: report.identity_evidence }, null, 2));
    if (report.selection === 'BLOCK') process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 2; });
