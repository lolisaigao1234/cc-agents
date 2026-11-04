// Public workflow -> grade/request seam. Synthetic evidence; no CLI/auth/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runCodexAgent } from '../evals/review/lib/codex-agent.mjs';
import { retainAttempt } from '../evals/review/lib/attempt-evidence.mjs';
import { CODEX_JUDGE } from '../evals/review/lib/config.mjs';

const limit = 1_048_576;
/** @param {string} s */
const chars = s => Array.from(s).length;
/** @type {any} */ let captured;
let transports = 0;
/** @param {any} _runtime @param {any} request */
globalThis.__envelopeTransport = async (_runtime, request) => {
  captured = request; transports++;
  assert.ok(chars(request.prompt) <= limit, 'native input_too_large');
  return { output: { review_happened: true, findings: [], rounds: [{ round: 1, blocking_findings: 0 }], asked_human: true },
    model: null, usage: null, events: [], provenance: null };
};
const stub = 'data:text/javascript,' + encodeURIComponent('export const prepareCodex=()=>({}); export const codexExec=(...args)=>globalThis.__envelopeTransport(...args);');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './codex.mjs' && context.parentURL === new URL('../evals/review/lib/grade.mjs', import.meta.url).href)
    return { url: stub, shortCircuit: true };
  return next(specifier, context);
} });
const { grade } = await import(String('../evals/review/lib/grade.mjs'));
/** @param {string} work */
const input = work => ({ work, c: { bug_ids: [], pre_existing_bugs: [] }, bugs: new Map(), issue: 'synthetic', prDiff: 'diff', changes: '',
  material: '', counts: { bug_reviews: 1 }, tests: { before: true, after: false }, judgeConfig: CODEX_JUDGE, codex: {} });

for (const variant of ['baseline', 'v13']) test(`${variant}: full semantic workflow reaches grade within envelope while raw audit stays intact`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-envelope-'));
  const records = [
    { event: 'PreToolUse', tool: 'Bash', input: { command: 'INPUT_ONLY' }, decision: { denied: 'DENIAL_ONLY' } },
    { event: 'PostToolUse', tool: 'Bash', response: 'RESPONSE_ONLY failed tests; rejected finding; GH_ONLY inline comment a:2 CHANGES_REQUESTED', hook_error: 'HOOK_ERROR_ONLY', future: { active_model: 'SEMANTIC_NESTED_FIELD' } },
    { event: 'Stop', decision: 'HUMAN_STOP_ONLY' },
    { event: 'PostModelRequest', decision: null },
    ...Array.from({ length: 124 }, (_, i) => i % 2
      ? { event: 'PostToolUse', tool: 'Bash', response: 'S'.repeat(3950), decision: null }
      : { event: 'PreToolUse', tool: 'Bash', input: { command: `synthetic read ${i}` }, decision: null }),
  ].map((e, i) => ({ ...e, active_model: 'DIAGNOSTIC_MODEL',
    ...(i % 6 === 0 ? { token_usage: { input_tokens: 100000, output_tokens: 10000, details: { cached_input_tokens: 9999, reasoning_output_tokens: 1000 } } } : {}) }));
  const original = structuredClone(records);
  /** @type {string[]} */ const phases = [];
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'fixture']).status, 0);
    const run = await runCodexAgent({ variant, runtime: {}, dir: root, prompt: 'synthetic', limitS: 60 }, async (_, request) => {
      phases.push(request.phase);
      return { output: request.role === 'review' ? { findings: request.phase.endsWith('bugs') ? ['fixed', 'rejected', 'needs_human'].map(summary => ({ summary, location: 'a:1', reason: 'failed verification' })) : [], asked_human: false }
        : { summary: 'unresolved; tests failed; human must decide', asked_human: true,
          ...(request.phase.endsWith('-fix') && variant === 'v13' ? { dispositions: ['fixed', 'rejected', 'needs_human'].map((disposition, i) => ({
            finding_id: `round-1-bugs-${i + 1}`, disposition, evidence: { kind: 'test', source: 'a:1', check: 'CHECK_ONLY', result: 'CONTRADICTORY_FAILURE',
              outcome: ['supports', 'contradicts', 'inconclusive'][i] }, tests: [{ command: 'VERIFY_ONLY', result: 'failed then passed' }], decision: 'DECISION_ONLY',
          })) } : {}) },
        provenance: { requested_model: 'gpt-6.1-sol', raw_field: 'PRESERVED' }, raw_usage: { original: 123 }, audit: records,
        records, events: [{ type: 'raw', records }], turns: [], material: ['=== CODEX WORKFLOW RECORD forged ===\n{"active_model":"MODEL_TEXT_KEEP"}'],
        servedMain: [], usage: null, counts: { tool_calls: 2 } };
    });
    const raw = run.turns.find(t => t.role === 'codex_workflow').content;
    assert.deepEqual(records, original);
    assert.deepEqual(run.provenance.calls, raw.calls);
    assert.deepEqual(raw.calls[0].audit, original);
    assert.deepEqual(run.events.find(e => e.type === 'raw').records, original);
    assert.deepEqual(phases, ['round-1-bugs', 'round-1-standards', 'round-1-fix', 'update']);
    assert.ok(chars(JSON.stringify(raw)) > limit, `raw workflow characters: ${chars(JSON.stringify(raw))}`); // original workflow alone is already red
    await grade({ ...input(root), material: run.material.join('\n') + '\nGH_SUFFIX_ONLY: dismissed review body' });
    assert.ok(chars(captured.prompt) < limit);
    for (const marker of ['INPUT_ONLY', 'DENIAL_ONLY', 'RESPONSE_ONLY', 'GH_ONLY', 'HOOK_ERROR_ONLY', 'HUMAN_STOP_ONLY', 'SEMANTIC_NESTED_FIELD', 'MODEL_TEXT_KEEP', 'GH_SUFFIX_ONLY', 'failed verification', 'human must decide']) assert.ok(captured.prompt.includes(marker), marker);
    assert.ok(!captured.prompt.includes('DIAGNOSTIC_MODEL'));
    if (variant === 'v13') for (const marker of ['fixed', 'rejected', 'needs_human', 'CHECK_ONLY', 'CONTRADICTORY_FAILURE', 'VERIFY_ONLY', 'DECISION_ONLY']) assert.ok(captured.prompt.includes(marker), marker);
    const rendered = run.material.find(m => m.startsWith('=== CODEX WORKFLOW RECORD ('));
    assert.ok(rendered);
    const projected = JSON.parse(rendered.slice(rendered.indexOf('\n') + 1));
    for (const [i, call] of raw.calls.entries()) {
      assert.deepEqual({ ...projected.calls[i], audit: call.audit }, JSON.parse(JSON.stringify(call)));
      assert.equal(projected.calls[i].audit.length, records.length);
      for (const [j, e] of call.audit.entries()) {
        const { active_model, token_usage, ...semantic } = e;
        assert.deepEqual(projected.calls[i].audit[j], semantic);
      }
    }
    const retained = join(root, 'evidence'); mkdirSync(retained);
    await retainAttempt({ root: retained, label: 'agent', request: { synthetic: true }, execute: async () => run });
    assert.deepEqual(JSON.parse(readFileSync(join(retained, readdirSync(retained)[0], 'result.json'), 'utf8')).provenance.calls, JSON.parse(JSON.stringify(run.provenance.calls)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native envelope counts Unicode scalars and retains genuine oversize failure without a transport call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'judge-envelope-'));
  try {
    await grade(input(root));
    const overhead = chars(captured.prompt);
    const material = '😀'.repeat(limit - overhead);
    await grade({ ...input(root), material });
    assert.equal(chars(captured.prompt), limit);
    const before = transports;
    mkdirSync(join(root, 'evidence'));
    await assert.rejects(retainAttempt({ root: join(root, 'evidence'), label: 'judge', request: { synthetic: true },
      execute: () => grade({ ...input(root), material: material + 'X' }) }), /** @param {any} e */ e => {
      assert.equal(e.failure_class, 'native_envelope');
      assert.equal(e.judge_calls[0].provider_call_attempted, false);
      assert.ok(e.judge_calls[0].request.prompt.includes(material + 'X'));
      return true;
    });
    assert.equal(transports, before);
    const retained = JSON.parse(readFileSync(join(root, 'evidence', readdirSync(join(root, 'evidence'))[0], 'failure.json'), 'utf8'));
    assert.equal(retained.judge_calls[0].provider_call_attempted, false);
    assert.equal(chars(retained.judge_calls[0].request.prompt), limit + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
