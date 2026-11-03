import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  assert.throws(() => executionConfig(state, { ...args, variant: 'v3' }), /baseline only/);
  assert.throws(() => executionConfig(state, { ...args, concurrency: 2 }), /concurrency 1/);
  assert.throws(() => executionConfig({ ...state, claude: { status: 'exhausted' } }, { ...args, agent: 'claude' }), /Claude usage exhausted/);
  assert.equal(executionConfig({}, { agent: 'claude' }).judge.model, 'claude-fable-5-1');
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

test('workflow counts real review rounds and stops at three before Update', async () => {
  /** @type {string[]} */ const phases = [];
  const f = workflowRepo();
  try {
  const run = await runCodexAgent({ ...args, dir: f.dir, runtime: {}, prompt: 'Review and Update', limitS: 60 }, async (_, request) => {
    phases.push(request.phase);
    const review = request.phase.endsWith('bugs') || request.phase.endsWith('standards');
    return { output: review ? { findings: [{ summary: 'bug', location: 'a:1', reason: 'fails' }], asked_human: false } : { summary: 'done', asked_human: false },
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
      issue: 'fix path', prDiff: 'a', changes: 'fixed a', material: 'finding', counts: { bug_reviews: 2 }, tests: { before: true, after: true },
      judgeConfig: CODEX_JUDGE, codex: { auth: f.auth, bin: f.bin }, modelVerification: 'configured_only' });
    assert.equal(g.grade.recall, 1);
    assert.equal(g.grade.fixed, 1);
    assert.equal(g.grade.reviews, 2);
    assert.equal(g.grade.broke_tests, 0);
    assert.equal(g.judge_usage.output_tokens, 40);
    assert.equal(g.judge_model, null);
    assert.equal(g.judge_config.model, 'gpt-6-astra');
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

async function workflowProbe() {
  const f = workflowRepo();
  const start = f.git(['rev-parse', 'HEAD']);
  /** @type {Map<string, any>} */ const requests = new Map();
  try {
    await runCodexAgent({ ...args, dir: f.dir, runtime: {}, prompt: 'Review and Update', limitS: 60 }, async (_, request) => {
      requests.set(request.phase, request);
      const firstBug = request.phase === 'round-1-bugs';
      if (request.phase === 'round-1-fix') { f.commit(); f.commit(); }
      return { output: request.role === 'review' ? { findings: firstBug ? [{ summary: 'finding-marker', location: 'a:1', reason: 'fails' }] : [], asked_human: false }
        : { summary: 'disposition-marker; tests-marker: pass', asked_human: false },
        events: [], records: [], turns: [], material: [], servedMain: [], model: null,
        usage: codexUsage({ input_tokens: 10, output_tokens: 5 }), counts: { tool_calls: 1 },
        provenance: { requested_model: 'gpt-6.1-sol', effort: 'high', service_tier: 'fast' } };
    });
    return { start, requests };
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
}

test('fresh Update receives findings, dispositions and verification evidence', async () => {
  const { requests } = await workflowProbe();
  const update = requests.get('update').prompt;
  for (const marker of ['finding-marker', 'disposition-marker', 'tests-marker']) assert.equal(update.includes(marker), true, `${marker} missing from Update`);
});

test('both incremental reviewers receive the SHA before the preceding multi-commit fix', async () => {
  const { start, requests } = await workflowProbe();
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

test('full plugin layout starts both read-only reviewers and fixers without exposing protected files', t => {
  if (!process.env.CODEX_SANDBOX_TEST) { t.skip('set CODEX_SANDBOX_TEST=1 for the full plugin-layout check'); return; }
  const f = fakeRuntime();
  try {
    const trace = join(f.root, 'plugins/trace'), matt = join(f.root, 'plugins/matt');
    mkdirSync(trace, { recursive: true }); mkdirSync(matt, { recursive: true });
    mkdirSync(join(f.root, 'other-case'), { recursive: true });
    writeFileSync(join(trace, 'answer-key'), 'hidden');
    writeFileSync(join(f.root, 'other-case/answer-key'), 'hidden');
    writeFileSync(join(f.runtime.control, 'sentinel'), 'hidden');
    Object.assign(f.runtime, { pluginDirs: [trace, matt], denied: [trace, '/home/ubuntu'] });
    const bin = resolveCodex();
    for (const role of ['review', 'agent']) {
      writeFileSync(join(f.runtime.home, '.codex/config.toml'), codexConfig({ ...f.runtime, model: 'gpt-6.1-sol', role }));
      const checks = `test ! -r '${trace}/answer-key' && test ! -r '${f.runtime.home}/.codex/auth.json' && test ! -r '${f.runtime.control}/sentinel' && test ! -r '/proc/1/root${f.runtime.home}/.codex/auth.json' && test ! -e '${f.root}/other-case/answer-key'`;
      const writes = role === 'review' ? '! touch forbidden 2>/dev/null' : 'touch allowed';
      const argv = codexBwrap({ ...f.runtime, bin, args: ['sandbox', '--', '/bin/sh', '-c', `${checks} && ${writes}`],
        env: { HOME: f.runtime.home, CODEX_HOME: join(f.runtime.home, '.codex'), TMPDIR: f.runtime.tmp, PATH: '/usr/local/bin:/usr/bin:/bin' } });
      const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, `${role}: ${r.stderr || r.error?.message}`);
    }
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
