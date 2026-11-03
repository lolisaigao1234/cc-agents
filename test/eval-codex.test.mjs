import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_JUDGE, executionConfig, assertModel } from '../evals/review/lib/config.mjs';
import { codexDigest, codexUsage } from '../evals/review/lib/codex-digest.mjs';
import { codexBwrap, codexConfig, codexExec, prepareCodex, resolveCodex, validateSchema } from '../evals/review/lib/codex.mjs';
import { handleHook, patchPaths, readInputs } from '../evals/review/lib/codex-hooks.mjs';
import { runCodexAgent } from '../evals/review/lib/codex-agent.mjs';
import { haltOutput } from '../plugins/trace/scripts/lib/halt.mjs';

const state = { effort: 'high', service_tier: 'fast', judge: CODEX_JUDGE, model_verification: 'configured_only' };
const args = { agent: 'codex', model: 'gpt-6.1-sol', variant: 'baseline', concurrency: 1 };

test('Sol High Fast and Astra Fast are frozen; Claude is not required for this pairing', () => {
  const c = executionConfig({ ...state, claude: { status: 'exhausted' } }, args);
  assert.equal(c.judge.model, 'gpt-6-astra');
  assert.equal(c.serviceTier, 'fast');
  assert.throws(() => executionConfig({ ...state, service_tier: 'default' }, args), /Fast/);
  assert.throws(() => executionConfig(state, { ...args, variant: 'v3' }), /unsupported Codex variant/);
  assert.throws(() => executionConfig(state, { ...args, concurrency: 2 }), /concurrency 1/);
  assert.throws(() => executionConfig({ ...state, claude: { status: 'exhausted' } }, { ...args, agent: 'claude' }), /Claude usage exhausted/);
  assert.equal(executionConfig({}, { agent: 'claude' }).judge.model, 'claude-fable-5-1');
});

test('runner configuration accepts only baseline and Codex evidence-before-fix v1', async () => {
  assert.equal(executionConfig(state, { ...args, variant: 'v13' }).variant?.workflow, 'codex-evidence-before-fix-v1');
  for (const variant of ['v5', 'v12', 'v14', '../baseline'])
    assert.throws(() => executionConfig(state, { ...args, variant }), /unsupported Codex variant/);
  for (const requirements of [{ workflow: 'Claude Workflow' }, { slash_commands: ['/code-review'] }])
    assert.throws(() => executionConfig({ ...state, requirements }, args), /unsupported.*Workflow|unsupported.*slash/i);
  assert.throws(() => executionConfig(state, { ...args, agent: 'claude', variant: 'v13' }), /Codex-only/);
});

test('configured identity never passes as response evidence; substitutions always fail', () => {
  assert.equal(assertModel('gpt-6.1-sol', [], 'configured_only'), null);
  assert.throws(() => assertModel('gpt-6.1-sol', []), /no response-backed/);
  assert.throws(() => assertModel('gpt-6.1-sol', ['gpt-6-astra'], 'configured_only'), /served model/);
  assert.equal(assertModel('gpt-6.1-sol', ['gpt-6.1-sol-2026-11-01']), 'gpt-6.1-sol-2026-11-01');
});

test('Codex accounting counts cached input and reasoning exactly once', () => {
  assert.deepEqual(codexUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 10 }),
    { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 0, reasoning_output_tokens: 10, coverage: 'cache_write_breakdown_missing' });
  assert.equal(codexUsage({ input_tokens: 10, cached_input_tokens: 11, output_tokens: 2 }), null);
  const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 };
  const d = codexDigest([
    { type: 'thread.started', model: 'configured-only' },
    { type: 'turn.started' },
    { type: 'item.updated', item: { id: '1', type: 'command_execution', command: 'cat /secret' } },
    { type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'git diff' } },
    { type: 'item.completed', item: { id: '2', type: 'agent_message', text: 'finding' } },
    { type: 'item.completed', item: { id: '3', type: 'reasoning', text: 'not judge material' } },
    { type: 'turn.completed', turn_id: 't1', usage },
    { type: 'turn.completed', turn_id: 't1', usage },
    { type: 'unknown.future', usage: { input_tokens: 999 } },
  ], /secret/);
  assert.equal(d.complete, true);
  assert.equal(d.counts.tool_calls, 1);
  assert.equal(d.usage?.input_tokens, 60);
  assert.deepEqual(d.servedMain, []);
  assert.equal(d.leaks.length, 1);
  assert.deepEqual(d.material, ['finding']);
  assert.equal(codexDigest([{ type: 'turn.completed', usage }, { type: 'turn.started' }]).complete, false);
  assert.equal(codexDigest([{ type: 'unparsed' }, { type: 'turn.completed', usage }]).complete, false);
  assert.equal(codexDigest([{ type: 'turn.failed' }]).complete, false);
  assert.equal(codexDigest([{ type: 'turn.completed' }]).usage, null);
});

test('generated policy enforces proxy domains, protects auth/hooks and allows git writes', () => {
  const config = codexConfig({ dir: '/tmp/replay', home: '/tmp/home', tmp: '/tmp/temp', control: '/tmp/control', denied: ['/answer-key'], model: 'gpt-6.1-sol' });
  assert.match(config, /service_tier = "fast"/);
  assert.match(config, /fast_mode = true/);
  assert.match(config, /network_proxy = true/);
  assert.match(config, /"\/tmp\/home\/\.codex" = "deny"/);
  assert.match(config, /"\/tmp\/replay\/\.git" = "write"/);
  assert.match(config, /"\/answer-key" = "deny"/);
  assert.doesNotMatch(config, /sandbox_mode|danger-full-access/);
  const judge = codexConfig({ dir: '/tmp/judge', home: '/tmp/home', tmp: '/tmp/temp', control: '/tmp/control', role: 'judge', model: 'gpt-6-astra' });
  assert.match(judge, /enabled = false/);
  assert.doesNotMatch(judge, /github\.com/);
  const launch = codexBwrap({ bin: '/opt/codex', dir: '/tmp/replay', home: '/tmp/home', tmp: '/tmp/temp', control: '/tmp/control', args: ['exec'], env: { HOME: '/tmp/home' } });
  assert.equal(launch.includes('--unshare-pid'), true);
  assert.equal(launch.includes('--clearenv'), true);
  assert.equal(launch.some((x, i) => x === '--ro-bind' && launch[i + 1] === '/'), false);
});

test('patches check every source/destination path and judge hooks reject all tools', () => {
  const input = { session_id: 's', cwd: '/repo', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a\n*** Move to: ../outside\n*** End Patch' } };
  assert.deepEqual(patchPaths(input.tool_input.command, '/repo'), ['/repo/a', '/outside']);
  const policy = { dir: '/repo', role: 'agent', trace: '/plugin', denied: [], slug: 'org/replay' };
  /** @type {string[]} */ const checked = [];
  const out = handleHook('PreToolUse', input, policy, (_, x) => { checked.push(x.tool_input.file_path); return null; });
  assert.deepEqual(checked, ['/repo/a']);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /replay repository/);
  const judge = handleHook('PreToolUse', { ...input, tool_name: 'Bash' }, { ...policy, role: 'judge' }, () => assert.fail('judge invoked plugin'));
  assert.equal(judge.hookSpecificOutput.permissionDecision, 'deny');
  const blocked = handleHook('PreToolUse', { ...input, tool_name: 'Bash', tool_input: { command: 'gh api repos/other/key/contents' } }, policy, () => null);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
});

test('full read evidence is verified; partial or truncated output receives no credit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-read-'));
  try {
    const file = join(dir, 'GLOSSARY.md'); writeFileSync(file, 'first\nsecond\n');
    const input = { tool_name: 'Bash', tool_input: { command: 'cat -- GLOSSARY.md' }, cwd: dir, tool_response: { stdout: 'first\nsecond\n' } };
    assert.equal(readInputs(input).length, 1);
    assert.equal(readInputs({ ...input, tool_response: { stdout: 'first\n' } }).length, 0);
    assert.equal(readInputs({ ...input, tool_response: { stdout: 'truncated\nfirst\nsecond\n' } }).length, 0);
    assert.equal(readInputs({ ...input, tool_input: { command: 'head GLOSSARY.md' } }).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('structured judge output rejects wrong shapes and unexpected properties', () => {
  const schema = { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } };
  validateSchema({ ok: true }, schema);
  assert.throws(() => validateSchema({ ok: 'yes' }, schema));
  assert.throws(() => validateSchema({ ok: true, ignored: 1 }, schema));
  assert.throws(() => validateSchema({}, schema));
});

for (const variant of ['baseline', 'v13']) test(`${variant}: workflow counts real review rounds and stops at three before Update`, async () => {
  /** @type {string[]} */ const phases = [];
  const f = workflowRepo();
  try {
  const run = await runCodexAgent({ ...args, variant, dir: f.dir, runtime: {}, prompt: 'Review and Update', limitS: 60 }, async (_, request) => {
    phases.push(request.phase);
    const review = request.phase.endsWith('bugs') || request.phase.endsWith('standards');
    return { output: review ? { findings: [{ summary: 'bug', location: 'a:1', reason: 'fails' }], asked_human: false } : request.phase.endsWith('-fix') && variant === 'v13' ? { summary: 'fixed', asked_human: false, dispositions: ['bugs', 'standards'].map(reviewer => ({ finding_id: `${request.phase.replace('-fix', '')}-${reviewer}-1`, disposition: 'fixed', evidence: { kind: 'test', source: 'a:1', check: 'test zero', result: 'fails before edit', outcome: 'supports' }, tests: [{ command: 'test zero', result: 'pass' }], decision: '' })) } : { summary: 'done', asked_human: request.phase === 'update' },
      events: [], records: [], turns: [], material: [], servedMain: [], model: null, usage: codexUsage({ input_tokens: 10, output_tokens: 5 }), counts: { tool_calls: 1 },
      provenance: { requested_model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast' } };
  });
  assert.equal(run.counts.bug_reviews, 3);
  assert.equal(run.counts.std_reviews, 3);
  assert.equal(phases.length, 10);
  assert.equal(phases.at(-1), 'update');
  assert.equal(run.usage?.output_tokens, 50);
  assert.equal(run.provenance.model_verification, 'configured_only');
  assert.match(run.material.join('\n'), /before any fourth round/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// This is an actual no-model mount-boundary test, not an argv-only assertion.
// Environments denying user namespaces report a skip; the paid pilot stays gated.
test('outer bwrap hides an answer-key sentinel outside the replay', t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 3000 });
  if (probe.error || probe.status !== 0) { t.skip(`bubblewrap unavailable: ${probe.stderr?.trim()}`); return; }
  const root = mkdtempSync(join(tmpdir(), 'codex-mount-'));
  try {
    for (const p of ['replay', 'home', 'temp', 'control']) mkdirSync(join(root, p));
    const sentinel = join(root, 'answer-key'); writeFileSync(sentinel, 'hidden');
    const argv = codexBwrap({ bin: '/bin/sh', dir: join(root, 'replay'), home: join(root, 'home'), tmp: join(root, 'temp'), control: join(root, 'control'),
      args: ['-c', `test ! -e '${sentinel}' && touch allowed`], env: { PATH: '/usr/bin:/bin' } });
    const r = spawnSync('bwrap', argv, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(root, 'replay/allowed'), 'utf8'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'codex-contract-'));
  for (const d of ['auth', 'replay', 'home', 'temp']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'auth/auth.json'), '{"fixture":"no credentials"}', { mode: 0o600 });
  const bin = join(root, 'fake-codex');
  writeFileSync(bin, `#!/usr/local/bin/node
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const argv=process.argv.slice(2), get=k=>argv[argv.indexOf(k)+1];
const prompt=readFileSync(0,'utf8');
const hooks=JSON.parse(readFileSync(process.env.CODEX_HOME+'/hooks.json','utf8')).hooks;
for(const event of ['SessionStart','PostModelRequest']) execSync(hooks[event][0].hooks[0].command,{input:JSON.stringify({session_id:'fixture',model:get('--model'),token_usage:{input_tokens:999999}})});
if(prompt.includes('TRY_TOOL')) execSync(hooks.PreToolUse[0].hooks[0].command,{input:JSON.stringify({session_id:'fixture',tool_name:'Bash',tool_input:{command:'touch should-never-run'}})});
if(prompt.includes('SANDBOX_EVENT_FAIL')) console.log(JSON.stringify({type:'item.completed',item:{id:'sandbox',type:'command_execution',command:'pwd',exit_code:1,aggregated_output:"bwrap: Cannot create sandbox mount: Read-only file system"}}));
if(prompt.includes('SANDBOX_HOOK_FAIL')) execSync(hooks.PostToolUse[0].hooks[0].command,{input:JSON.stringify({session_id:'fixture',tool_name:'Bash',tool_input:{command:'pwd'},tool_response:'bwrap: initialization failed'})});
const schema=JSON.parse(readFileSync(get('--output-schema'),'utf8'));
writeFileSync(get('--output-last-message')+'.request.json',JSON.stringify({prompt,schema,developerInstructions:JSON.parse(argv.find(a=>a.startsWith('developer_instructions='))?.slice('developer_instructions='.length)||'null')}));
const value=schema.properties.findings ? {review_happened:true,findings:[{first_round:1,repeats:0,summary:'broken path',location:'a:1',category:'in_diff_bug',bug_id:'b1',reason:'same failure'}],rounds:[{round:1,blocking_findings:1},{round:2,blocking_findings:0}],asked_human:false}
 : schema.properties.bugs ? {bugs:[{bug_id:'b1',status:'fixed',reason:'fixed path'}],regressions:[]} : {ok:true};
const final=prompt.includes('BAD_SCHEMA') ? {ok:'bad'} : value;
writeFileSync(get('--output-last-message'),JSON.stringify(final));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:JSON.stringify(final)}}));
console.log(JSON.stringify(prompt.includes('PARTIAL') ? {type:'turn.failed',error:'fixture failure'} : {type:'turn.completed',turn_id:'fixture',...(prompt.includes('MISMATCH')?{model:'wrong-model'}:{}),usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}));
`, { mode: 0o700 });
  const auth = { home: join(root, 'auth'), auth: join(root, 'auth/auth.json') };
  return { root, bin, auth, runtime: prepareCodex({ dir: join(root, 'replay'), home: join(root, 'home'), tmp: join(root, 'temp'), auth }) };
}

test('fake CLI contract: judge JSON, audit, raw usage, no inherited auth, and partial/error rejection', async t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 3000 });
  if (probe.error || probe.status !== 0) { t.skip('bubblewrap unavailable'); return; }
  const f = fakeRuntime();
  try {
    const request = { model: 'gpt-6-astra', bin: f.bin, role: 'judge', modelVerification: 'configured_only', limitS: 5, prompt: 'grade',
      schema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } } };
    const r = await codexExec(f.runtime, request);
    assert.deepEqual(r.output, { ok: true });
    assert.equal(r.model, null);
    assert.equal(r.usage?.input_tokens, 60);
    assert.equal(r.usage?.output_tokens, 20); // 999999 diagnostic tokens were not added.
    assert.equal(readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').includes('turn.completed'), true);
    await assert.rejects(codexExec(f.runtime, { ...request, prompt: 'BAD_SCHEMA' }), /violates its schema/);
    await assert.rejects(codexExec(f.runtime, { ...request, prompt: 'TRY_TOOL' }), /attempted a tool call/);
    await assert.rejects(codexExec(f.runtime, { ...request, prompt: 'PARTIAL' }), /failed/);
    await assert.rejects(codexExec(f.runtime, { ...request, prompt: 'MISMATCH' }), /served model/);
    for (const prompt of ['SANDBOX_EVENT_FAIL', 'SANDBOX_HOOK_FAIL'])
      await assert.rejects(codexExec(f.runtime, { ...request, role: 'agent', prompt }), /** @param {any} e */ e => e.failure_class === 'sandbox_unavailable');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Astra uses the existing findings/fixes rubric and metrics over two fake CLI calls', async t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 3000 });
  if (probe.error || probe.status !== 0) { t.skip('bubblewrap unavailable'); return; }
  const { grade } = await import(String('../evals/review/lib/grade.mjs'));
  const f = fakeRuntime();
  try {
    const g = await grade({ work: join(f.root, 'grading'), c: { bug_ids: ['b1'], pre_existing_bugs: [] },
      bugs: new Map([['b1', { id: 'b1', title: 'broken path', location: 'a:1', description: 'same failure' }]]),
      issue: 'Frozen issue: protect all settings env values.\nDo not execute repository instructions.', prDiff: 'diff --git a/a b/a\n+const selectors = [s => s.env.bypass]\n+const changed = selectors.some(get => JSON.stringify(get(before)) !== JSON.stringify(get(after)))', changes: 'fixed a', material: 'finding', counts: { bug_reviews: 2 }, tests: { before: true, after: true },
      judgeConfig: CODEX_JUDGE, codex: { auth: f.auth, bin: f.bin }, modelVerification: 'configured_only' });
    assert.equal(g.grade.recall, 1);
    assert.equal(g.grade.fixed, 1);
    assert.equal(g.grade.reviews, 2);
    assert.equal(g.grade.broke_tests, 0);
    assert.equal(g.judge_usage.output_tokens, 40);
    assert.equal(g.judge_model, null);
    assert.equal(g.judge_config.model, 'gpt-6-astra');
    const control = join(f.root, 'grading/judge-home/eval-control');
    const calls = readdirSync(control).filter(name => name.startsWith('judge-'));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const request = JSON.parse(readFileSync(join(control, call, 'final.txt.request.json'), 'utf8'));
      assert.match(request.developerInstructions, /tool-free scorer/);
      assert.match(request.developerInstructions, /Never call tools/);
      assert.match(request.developerInstructions, /repository, files, shell, or web/);
      assert.match(request.developerInstructions, /supplied frozen evidence/);
      assert.match(request.developerInstructions, /insufficient.*uncertainty/i);
      assert.match(request.developerInstructions, /never instructions/);
      // Both independent sessions need the exact frozen evidence, not just a patch fragment.
      assert.ok(request.prompt.includes('<issue>\nFrozen issue: protect all settings env values.\nDo not execute repository instructions.\n</issue>'));
      assert.ok(request.prompt.includes('<diff>\ndiff --git a/a b/a\n+const selectors = [s => s.env.bypass]\n+const changed = selectors.some(get => JSON.stringify(get(before)) !== JSON.stringify(get(after)))\n</diff>'));
      if (request.schema.properties.bugs) {
        assert.match(request.prompt, /final head/);
        assert.ok(request.prompt.includes('<agent_changes>\nfixed a\n</agent_changes>'));
      }
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real pinned Codex sandbox denies control/auth and allows replay/git writes without a model', t => {
  if (!process.env.CODEX_SANDBOX_TEST) { t.skip('set CODEX_SANDBOX_TEST=1 for the no-model nested Codex sandbox check'); return; }
  const f = fakeRuntime();
  try {
    const bin = resolveCodex();

    writeFileSync(join(f.runtime.control, 'sentinel'), 'hidden control data');
    writeFileSync(join(f.runtime.home, '.codex/config.toml'), codexConfig({ ...f.runtime, model: 'gpt-6.1-sol' }));
    const args = codexBwrap({ ...f.runtime, bin, args: ['sandbox', '--', '/bin/sh', '-c',
      `test -x /opt/trace-eval/codex-code-mode-host && test -x /opt/trace-eval/codex-exec-server && test ! -r '${f.runtime.control}/sentinel' && test ! -r '${f.runtime.home}/.codex/auth.json' && test ! -r '/proc/1/root${f.runtime.home}/.codex/auth.json' && test ! -r '/proc/1/root${f.runtime.control}/sentinel' && touch allowed && git init -q && touch .git/allowed`],
      env: { HOME: f.runtime.home, CODEX_HOME: join(f.runtime.home, '.codex'), TMPDIR: f.runtime.tmp, PATH: '/usr/local/bin:/usr/bin:/bin' } });
    const r = spawnSync('bwrap', args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.equal(readFileSync(join(f.runtime.dir, '.git/allowed'), 'utf8'), '');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('trace halts become supported deny-only Codex PreToolUse responses', () => {
  for (const tool of ['Bash', 'apply_patch']) {
    const input = { session_id: 's', cwd: '/repo', tool_name: tool, tool_input: { command: tool === 'Bash' ? 'git status' : '*** Begin Patch\n*** Update File: a\n*** End Patch' } };
    const out = handleHook('PreToolUse', input, { dir: '/repo', role: 'agent', trace: '/plugin', slug: 'org/replay', denied: [] }, () => haltOutput('pre-tool-use', 'trace halted: GitHub did not answer'));
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /GitHub did not answer/);
  }
});

function workflowRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-workflow-'));
  /** @param {string[]} argv */
  const git = argv => {
    const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const commit = () => git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  commit();
  return { dir, git, commit };
}

async function workflowProbe(variant = 'baseline') {
  const f = workflowRepo();
  const start = f.git(['rev-parse', 'HEAD']);
  /** @type {Map<string, any>} */ const requests = new Map();
  try {
    await runCodexAgent({ ...args, variant, dir: f.dir, runtime: {}, prompt: 'Review and Update', limitS: 60 }, async (_, request) => {
      requests.set(request.phase, request);
      const firstBug = request.phase === 'round-1-bugs';
      if (request.phase === 'round-1-fix') { f.commit(); f.commit(); }
      return { output: request.role === 'review' ? { findings: firstBug ? [{ summary: 'finding-marker', location: 'a:1', reason: 'fails' }] : [], asked_human: false }
        : { summary: 'disposition-marker; tests-marker: pass', asked_human: false, ...(variant === 'v13' && request.phase.endsWith('-fix') ? { dispositions: [{ finding_id: 'round-1-bugs-1', disposition: 'fixed', evidence: { kind: 'test', source: 'a:1', check: 'test marker', result: 'fails before edit', outcome: 'supports' }, tests: [{ command: 'test marker', result: 'pass' }], decision: '' }] } : {}) },
        events: [], records: [], turns: [], material: [], servedMain: [], model: null,
        usage: codexUsage({ input_tokens: 10, output_tokens: 5 }), counts: { tool_calls: 1 },
        provenance: { requested_model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast' } };
    });
    return { start, requests };
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
}

for (const variant of ['baseline', 'v13']) test(`${variant}: fresh Update receives findings, dispositions and verification evidence`, async () => {
  const { requests } = await workflowProbe(variant);
  const update = requests.get('update').prompt;
  for (const marker of ['finding-marker', 'disposition-marker', 'tests-marker']) assert.equal(update.includes(marker), true, `${marker} missing from Update`);
});

for (const variant of ['baseline', 'v13']) test(`${variant}: both incremental reviewers receive the SHA before the preceding multi-commit fix`, async () => {
  const { start, requests } = await workflowProbe(variant);
  for (const phase of ['round-2-bugs', 'round-2-standards']) assert.equal(requests.get(phase).prompt.includes(`git diff ${start}`), true, `explicit fix boundary missing from ${phase}`);
});

test('outer CLI sandbox retains its host resolver without exposing the host run directory', t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('bubblewrap unavailable'); return; }
  const f = fakeRuntime();
  try {
    const r = spawnSync('bwrap', codexBwrap({ ...f.runtime, bin: '/bin/sh', args: ['-c', 'test -r /etc/resolv.conf'], env: { PATH: '/usr/bin:/bin' } }), { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, 'the CLI must be able to read the host resolver through its symlink');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const variant of ['baseline', 'v13']) test(`${variant}: full workflow roles keep nested sandbox isolation without models`, async t => {
  if (!process.env.CODEX_SANDBOX_TEST) { t.skip('set CODEX_SANDBOX_TEST=1 for the full plugin-layout check'); return; }
  const f = fakeRuntime();
  try {
    const trace = join(f.root, 'plugins/trace'), matt = join(f.root, 'plugins/matt');
    mkdirSync(trace, { recursive: true }); mkdirSync(matt, { recursive: true });
    mkdirSync(join(f.root, 'other-case'), { recursive: true });
    writeFileSync(join(trace, 'answer-key'), 'hidden');
    writeFileSync(join(f.root, 'other-case/answer-key'), 'hidden');
    writeFileSync(join(f.runtime.control, 'sentinel'), 'hidden');
    writeFileSync(join(f.runtime.tmp, 'trace-reads/sentinel'), 'hidden');
    Object.assign(f.runtime, { pluginDirs: [trace, matt], denied: [trace, '/home/ubuntu'] });
    /** @param {string[]} argv */
    const git = argv => {
      const r = spawnSync('git', argv, { cwd: f.runtime.dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git(['init', '-q']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    const bin = resolveCodex();
    const run = await runCodexAgent({ ...args, variant, dir: f.runtime.dir, runtime: f.runtime, limitS: 60 }, async (_, request) => {
      const role = request.role;
      writeFileSync(join(f.runtime.home, '.codex/config.toml'), codexConfig({ ...f.runtime, model: 'gpt-6.1-sol', role }));
      const checks = `test ! -r '${trace}/answer-key' && test ! -r '${f.runtime.home}/.codex/auth.json' && test ! -r '${f.runtime.control}/sentinel' && test ! -r '/proc/1/root${f.runtime.home}/.codex/auth.json' && test ! -e '${f.root}/other-case/answer-key' && test ! -r '${f.runtime.tmp}/trace-reads/sentinel' && ! touch '${f.runtime.tmp}/trace-reads/tamper' 2>/dev/null`;
      const writes = role === 'review' ? '! touch forbidden 2>/dev/null' : 'touch allowed';
      const argv = codexBwrap({ ...f.runtime, bin, args: ['sandbox', '--', '/bin/sh', '-c', `${checks} && ${writes}`],
        env: { HOME: f.runtime.home, CODEX_HOME: join(f.runtime.home, '.codex'), TMPDIR: f.runtime.tmp, PATH: '/usr/local/bin:/usr/bin:/bin' } });
      const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, `${request.phase}: ${r.stderr || r.error?.message}`);
      return workflowResponse(role === 'review' ? { findings: request.phase === 'round-1-bugs' ? [{ summary: 'synthetic finding', location: 'a:1', reason: 'synthetic failure path' }] : [], asked_human: false }
        : { summary: 'synthetic disposition; sandbox writes passed', asked_human: false,
          ...(variant === 'v13' && request.phase.endsWith('-fix') ? { dispositions: [{ finding_id: 'round-1-bugs-1', disposition: 'fixed',
            evidence: { kind: 'test', source: 'synthetic fixture', check: 'synthetic failure check', result: 'synthetic reproduction', outcome: 'supports' },
            tests: [{ command: 'sandbox filesystem probe', result: 'passed' }], decision: '' }] } : {}) }, request);
    });
    assert.equal(run.provenance.calls.length, 6); // both reviewers twice, fixer, Update
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('replay authorship is allowed while tool inputs and source-repo output still reveal leaks', () => {
  const leak = /lolisaigao1234|\/answer-key/;
  const seen = /lolisaigao1234\/cc-agents/;
  const legitimate = [
    { type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'gh issue view 1 -R trace-eval-rocky/replay --json comments,state,url', aggregated_output: JSON.stringify({ comments: [{ author: { login: 'lolisaigao1234' }, body: 'Review progress' }] }) } },
    { type: 'item.completed', item: { id: 'hook', type: 'hook_evidence', input: { command: 'gh issue view 1 --comments' }, response: 'author: lolisaigao1234', decision: null } },
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Progress comment author is lolisaigao1234.' } },
  ];
  assert.deepEqual(codexDigest(legitimate, leak, seen).leaks, []);
  const forbidden = [
    { type: 'command_execution', command: 'gh api repos/lolisaigao1234/cc-agents/contents', aggregated_output: '' },
    { type: 'file_change', changes: [{ path: '/answer-key/fix.mjs', kind: 'update' }] },
    { type: 'hook_evidence', input: { command: 'cat /answer-key/fix.mjs' }, response: '', decision: null },
    { type: 'mcp_tool_call', arguments: { path: '/answer-key/fix.mjs' }, result: null },
    { type: 'command_execution', command: 'fetch-source', aggregated_output: 'lolisaigao1234/cc-agents' },
    { type: 'hook_evidence', input: { command: 'fetch-source' }, response: 'lolisaigao1234/cc-agents', decision: null },
  ];
  for (const [i, item] of forbidden.entries()) assert.equal(codexDigest([{ type: 'item.completed', item: { id: String(i), ...item } }], leak, seen).leaks.length, 1);
});

test('scratch repositories remain visible to the archive guard inside the real command sandbox', t => {
  if (!process.env.CODEX_SANDBOX_TEST) { t.skip('set CODEX_SANDBOX_TEST=1 for the scratch repository check'); return; }
  const f = fakeRuntime();
  try {
    // Replay product code, distinct from the protected hook/plugin copy.
    cpSync(new URL('../plugins/trace/scripts/lib/', import.meta.url), join(f.runtime.dir, 'lib'), { recursive: true });
    const child = join(f.runtime.tmp, 'child');
    mkdirSync(join(child, 'archive'), { recursive: true });
    const git = spawnSync('git', ['init', '-q', child], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    writeFileSync(join(child, 'archive/old.md'), 'fixture');
    const probe = `import assert from 'node:assert/strict';
      import { archiveBlock } from './lib/archive.mjs';
      assert.match(String(archiveBlock('Bash', { command: 'rg -uu fixture ' + process.env.TMPDIR }, process.cwd())), /archive/);`;
    const bin = resolveCodex();
    writeFileSync(join(f.runtime.home, '.codex/config.toml'), codexConfig({ ...f.runtime, model: 'gpt-6.1-sol' }));
    const r = spawnSync('bwrap', codexBwrap({ ...f.runtime, bin, args: ['sandbox', '--', process.execPath, '--input-type=module', '-e', probe],
      env: { HOME: f.runtime.home, CODEX_HOME: join(f.runtime.home, '.codex'), TMPDIR: f.runtime.tmp, PATH: '/usr/local/bin:/usr/bin:/bin' } }),
      { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** @param {any} output @param {any} request */
function workflowResponse(output, request) {
  return { output, events: [{ type: 'item.completed', item: { id: request.phase, type: 'agent_message', text: JSON.stringify(output) } }],
    records: [], turns: [], material: [], servedMain: [], model: null,
    usage: codexUsage({ input_tokens: 10, output_tokens: 5 }), counts: { tool_calls: 1 },
    provenance: { requested_model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast' } };
}

// Synthetic requirements only. No historical cases, calibration answers or models.
for (const variant of ['baseline', 'v13']) test(`${variant}: verifies support, rejects a false claim and carries a human decision through Update`, async () => {
  const f = workflowRepo();
  const source = join(f.dir, 'value.cjs');
  writeFileSync(source, 'module.exports = n => n || 10;\n');
  const check = () => spawnSync(process.execPath, ['-e', "const assert = require('node:assert/strict'); const value = require('./value.cjs'); assert.equal(value(0), 0); assert.equal(value(-1), -1);"], { cwd: f.dir, encoding: 'utf8' });
  const findings = [
    { summary: 'zero is replaced', location: 'value.cjs:1', reason: 'requirement: preserve supplied numeric values including zero' },
    { summary: 'negative values are rejected', location: 'value.cjs:1', reason: 'claim: -1 throws' },
  ];
  const decisionFinding = { summary: 'choose an upper limit', location: 'issue', reason: 'no upper limit requirement exists; human must choose' };
  /** @param {string} finding_id @param {string} status @param {string} outcome @param {string} result @param {string} [decision] */
  const disposition = (finding_id, status, outcome, result, decision = '') => ({ finding_id, disposition: status,
    evidence: { kind: 'test', source: 'value.cjs:1 / supplied numeric values requirement', check: 'node assertion for 0 and -1', result, outcome },
    tests: status === 'fixed' ? [{ command: 'node assertions for 0 and -1', result: 'pass after fix' }] : [], decision });
  const start = f.git(['rev-parse', 'HEAD']);
  let beforeFailed = false;
  /** @type {Map<string, any>} */ const requests = new Map();
  try {
    const run = await runCodexAgent({ ...args, variant, runtime: {}, dir: f.dir, prompt: 'Preserve supplied numeric values. Upper limit undecided.', limitS: 60 }, async (_, request) => {
      requests.set(request.phase, request);
      let output;
      if (request.role === 'review') output = { findings: request.phase === 'round-1-bugs' ? findings : request.phase === 'round-2-standards' ? [decisionFinding] : [], asked_human: false };
      else if (request.phase === 'round-1-fix') {
        if (variant === 'v13') assert.match(request.prompt, /Before editing code for EACH/);
        else assert.doesNotMatch(request.prompt, /Before editing code for EACH/);
        beforeFailed = check().status !== 0; // observed before any edit
        assert.equal(beforeFailed, true);
        const negative = spawnSync(process.execPath, ['-e', "require('node:assert/strict').equal(require('./value.cjs')(-1), -1)"], { cwd: f.dir });
        assert.equal(negative.status, 0); // false claim contradicted before any edit
        writeFileSync(source, 'module.exports = n => n ?? 10;\n');
        assert.equal(check().status, 0);
        f.git(['add', 'value.cjs']); f.commit(); f.commit();
        output = { summary: 'zero fixed; negative claim rejected', asked_human: false, dispositions: [
          disposition('round-1-bugs-1', 'fixed', 'supports', 'zero assertion failed before edit'),
          disposition('round-1-bugs-2', 'rejected', 'contradicts', '-1 assertion passed before edit; no throw'),
        ] };
      } else if (request.phase === 'round-2-fix') output = { summary: 'human must choose upper limit', asked_human: true,
        dispositions: [disposition('round-2-standards-1', 'needs_human', 'inconclusive', 'no upper limit is specified', 'What upper limit should apply?')] };
      else output = { summary: 'not ready; upper limit requires a human decision', asked_human: true };
      if (variant === 'baseline' && output.dispositions) output = { summary: `${output.summary}\n${JSON.stringify(output.dispositions)}`, asked_human: output.asked_human };
      return workflowResponse(output, request);
    });
    assert.equal(run.counts.bug_reviews, 2); assert.equal(run.counts.std_reviews, 2);
    assert.equal(run.provenance.calls.length, 7); // no verification model/round added
    assert.equal(run.provenance.workflow, variant === 'v13' ? 'codex-evidence-before-fix-v1' : 'codex-baseline-v1');
    for (const phase of ['round-2-bugs', 'round-2-standards']) assert.match(requests.get(phase).prompt, new RegExp(`git diff ${start} HEAD`));
    const update = requests.get('update').prompt;
    for (const marker of ['zero is replaced', 'negative values are rejected', 'choose an upper limit', 'zero assertion failed before edit', '-1 assertion passed before edit', 'What upper limit should apply?', 'pass after fix']) {
      assert.equal(update.includes(marker), true, `${marker} missing from Update`);
      assert.equal(run.material.join('\n').includes(marker), true, `${marker} missing from judge material`);
      assert.equal(JSON.stringify(run.turns).includes(marker), true, `${marker} missing from saved trace`);
    }
    assert.equal(run.provenance.variant.id, variant);
    assert.equal(run.provenance.variant.content_sha256.length, 64);
    assert.deepEqual(run.provenance.calls.map(/** @param {any} c */ c => c.phase), [...requests.keys()]);
    assert.equal(run.provenance.calls[2].pre_fix_sha, start);
    if (process.env.CODEX_WORKFLOW_EVIDENCE_DIR) {
      const dir = join(process.env.CODEX_WORKFLOW_EVIDENCE_DIR, variant);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'raw-events.jsonl'), run.events.map(/** @param {any} e */ e => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(join(dir, 'trace.json'), JSON.stringify(run.turns, null, 2) + '\n');
      writeFileSync(join(dir, 'requests.json'), JSON.stringify([...requests.values()].map(({ phase, role, prompt, schema }) => ({ phase, role, prompt, schema })), null, 2) + '\n');
      writeFileSync(join(dir, 'judge-input.json'), JSON.stringify({ material: run.material.join('\n'), counts: run.counts, tests: { before: false, after: true } }, null, 2) + '\n');
      writeFileSync(join(dir, 'provenance.json'), JSON.stringify(run.provenance, null, 2) + '\n');
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('variant refuses missing or unsupported dispositions instead of silently shrinking grading', async () => {
  const f = workflowRepo();
  const supported = { finding_id: 'round-1-bugs-1', disposition: 'fixed', evidence: {
    kind: 'failure_path', source: 'a:1', check: 'call with zero', result: 'reproduced before edit', outcome: 'supports',
  }, tests: [{ command: 'node test', result: 'pass' }], decision: '' };
  try {
    for (const dispositions of [[], [supported, supported], [{ ...supported, finding_id: 'unknown' }],
      [{ ...supported, evidence: { ...supported.evidence, source: '' } }],
      [{ ...supported, evidence: { ...supported.evidence, outcome: 'contradicts' } }], [{ ...supported, tests: [] }],
      [{ ...supported, disposition: 'needs_human', evidence: { ...supported.evidence, outcome: 'inconclusive' }, decision: 'choose a policy' }]]) {
      await assert.rejects(runCodexAgent({ ...args, variant: 'v13', runtime: {}, dir: f.dir, limitS: 60 }, async (_, request) =>
        workflowResponse(request.role === 'review' ? { findings: request.phase.endsWith('bugs') ? [{ summary: 'zero fails', location: 'a:1', reason: 'zero replaced' }] : [], asked_human: false }
          : { summary: 'fix report', asked_human: false, dispositions }, request)), /** @param {any} e */ e => {
        assert.equal(e.failure_class, 'harness');
        assert.match(JSON.stringify(e.events), /zero fails/);
        assert.match(JSON.stringify(e.events), /round-1-fix/);
        return /evidence-before-fix/.test(e.message);
      });
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const variant of ['baseline', 'v13']) test(`${variant}: failed executor calls retain raw evidence and a fresh retry reruns both reviewers`, async () => {
  const f = workflowRepo();
  const options = { ...args, variant, runtime: {}, dir: f.dir, limitS: 60 };
  let retained = '';

  try {
    await assert.rejects(runCodexAgent(options, async (_, request) => {
      if (request.phase === 'round-1-standards') throw Object.assign(new Error('synthetic serving failure'), {
        failure_class: 'serving', usage: codexUsage({ input_tokens: 10, output_tokens: 5 }),
        events: [{ type: 'turn.failed', error: 'raw-failure-marker' }], audit: [{ decision: 'synthetic-denial' }],
      });
      return workflowResponse({ findings: [{ summary: 'retained finding', location: 'a:1', reason: 'checkable failure' }], asked_human: false }, request);
    }), /** @param {any} e */ e => {
      assert.equal(e.failure_class, 'serving');
      assert.equal(e.usage.output_tokens, 10);
      retained = JSON.stringify(e.events);
      for (const marker of ['retained finding', 'raw-failure-marker', 'synthetic-denial', variant, 'round-1-standards']) assert.equal(retained.includes(marker), true);
      return true;
    });
    /** @type {string[]} */ const phases = [];
    const retry = await runCodexAgent(options, async (_, request) => {
      phases.push(request.phase);
      return workflowResponse(request.role === 'review' ? { findings: [], asked_human: false } : { summary: 'clean', asked_human: false }, request);
    });
    assert.deepEqual(phases, ['round-1-bugs', 'round-1-standards', 'update']);
    assert.equal(retry.provenance.calls.length, 3);
    assert.equal(retained.includes('raw-failure-marker'), true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const variant of ['baseline', 'v13']) test(`${variant}: trusted hook denials and leak attempts survive workflow aggregation`, async () => {
  const f = workflowRepo();
  try {
    let leak = false;
    /** @param {any} _ @param {any} request */
    const execute = async (_, request) => ({ ...workflowResponse(request.role === 'review' ? { findings: [], asked_human: false } : { summary: 'clean', asked_human: false }, request),
      records: [{ tool: 'Bash', input: { command: leak ? 'cat /synthetic-answer-key' : 'git status' }, response: 'denied', decision: { hookSpecificOutput: { permissionDecision: 'deny' } } }] });
    const options = { ...args, variant, runtime: {}, dir: f.dir, limitS: 60, leak: /synthetic-answer-key/ };
    const run = await runCodexAgent(options, execute);
    assert.equal(run.counts.hook_denials, 3);
    leak = true;
    await assert.rejects(runCodexAgent(options, execute), /** @param {any} e */ e => e.failure_class === 'answer_key_leak' && JSON.stringify(e.events).includes('synthetic-answer-key'));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const variant of ['baseline', 'v13']) test(`${variant}: saved workflow material reaches the unchanged tool-free judge`, async t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('bubblewrap unavailable'); return; }
  const f = workflowRepo(), cli = fakeRuntime();
  try {
    const run = await runCodexAgent({ ...args, variant, runtime: {}, dir: f.dir, limitS: 60 }, async (_, request) =>
      workflowResponse(request.role === 'review' ? { findings: [], asked_human: false } : { summary: 'clean', asked_human: false }, request));
    const { grade } = await import(String('../evals/review/lib/grade.mjs'));
    const input = { work: join(cli.root, 'grade'), c: { bug_ids: [], pre_existing_bugs: [] }, bugs: new Map(), issue: 'synthetic issue',
      prDiff: 'synthetic diff', changes: '', material: run.material.join('\n'), counts: run.counts, tests: { before: true, after: true },
      judgeConfig: CODEX_JUDGE, codex: { auth: cli.auth, bin: cli.bin }, modelVerification: 'configured_only' };
    assert.equal((await grade(input)).grade.reviews, 1);
    await assert.rejects(grade({ ...input, work: join(cli.root, 'tool-judge'), material: input.material + '\nTRY_TOOL' }), /attempted a tool call/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(cli.root, { recursive: true, force: true }); }
});

test('variant preserves reviewer human gates and refuses Update clearing them', async () => {
  const f = workflowRepo();
  /** @type {string[]} */ const phases = [];
  try {
    await assert.rejects(runCodexAgent({ ...args, variant: 'v13', runtime: {}, dir: f.dir, limitS: 60 }, async (_, request) => {
      phases.push(request.phase);
      return workflowResponse(request.role === 'review' ? { findings: [{ summary: 'human must choose policy', location: 'issue', reason: 'missing requirement' }], asked_human: true }
        : { summary: 'ready', asked_human: false }, request);
    }), /** @param {any} e */ e => e.failure_class === 'harness' && /Update must preserve/.test(e.message) && JSON.stringify(e.events).includes('human must choose policy'));
    assert.deepEqual(phases, ['round-1-bugs', 'round-1-standards', 'update']);
    let calls = 0;
    await assert.rejects(runCodexAgent({ ...args, variant: 'v13', variantIdentity: { id: 'baseline' }, runtime: {}, dir: f.dir, limitS: 60 }, async () => { calls++; }), /identity changed/);
    assert.equal(calls, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a later judge failure retains the successful findings request and raw response', async () => {
  const { grade } = await import(String('../evals/review/lib/grade.mjs'));
  const { retainAttempt } = await import('../evals/review/lib/attempt-evidence.mjs');
  const f = fakeRuntime();
  const work = join(f.root, 'grading');
  const evidence = join(f.root, 'evidence'); mkdirSync(evidence);
  try {
    await assert.rejects(retainAttempt({ root: evidence, label: 'judge', request: { case: 'synthetic' }, homes: [join(work, 'judge-home')],
      cleanup: () => rmSync(work, { recursive: true, force: true }), execute: () => grade({ work, c: { bug_ids: ['b1'], pre_existing_bugs: [] },
      bugs: new Map([['b1', { id: 'b1', title: 'broken path', location: 'a:1', description: 'same failure' }]]),
      issue: 'fix path', prDiff: 'a', changes: 'TRY_TOOL', material: 'finding', counts: { bug_reviews: 2 }, tests: { before: true, after: true },
      judgeConfig: CODEX_JUDGE, codex: { auth: f.auth, bin: f.bin }, modelVerification: 'configured_only' }) }), /** @param {any} e */ e => {
      assert.match(e.message, /attempted a tool call/);
      assert.equal(e.judge_calls.length, 2);
      assert.equal(e.judge_calls[0].status, 'ok');
      assert.match(e.judge_calls[0].request.prompt, /Grade what its review found/);
      assert.match(e.judge_calls[0].request.developerInstructions, /You grade one case/);
      assert.equal(e.judge_calls[0].output.findings[0].bug_id, 'b1');
      assert.ok(e.judge_calls[0].events.some((/** @type {any} */ event) => event.type === 'turn.completed'));
      assert.equal(e.judge_calls[1].status, 'failure');
      assert.ok(e.judge_calls[1].audit.some((/** @type {any} */ event) => event.event === 'PreToolUse'));
      assert.equal(e.judge_usage.output_tokens, 40);
      assert.equal(e.grade, undefined);
      return true;
    });
    assert.equal(existsSync(work), false);
    const attempt = join(evidence, readdirSync(evidence)[0]);
    const calls = join(attempt, 'calls/0');
    assert.equal(readdirSync(calls).length, 2);
    for (const call of readdirSync(calls)) {
      assert.match(readFileSync(join(calls, call, 'events.jsonl'), 'utf8'), /turn.completed/);
      const request = JSON.parse(readFileSync(join(calls, call, 'request.json'), 'utf8'));
      assert.match(request.developerInstructions, /You grade one case/);
      assert.equal(request.ghToken, undefined);
    }
    const failed = JSON.parse(readFileSync(join(attempt, 'failure.json'), 'utf8'));
    assert.equal(failed.judge_calls[0].output.findings[0].bug_id, 'b1');
    assert.equal(existsSync(join(attempt, 'result.json')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
