// Offline controlled probes against a replay-check.mjs fixture; no model/API calls.
// Usage: node docs/research/codex-readiness-45/probes.mjs FIXTURE_DIR NEW_OUTPUT_DIR PILOT_BASELINE_DIR
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexBwrap, codexConfig, resolveCodex } from '../../../evals/review/lib/codex.mjs';
import { handleHook } from '../../../evals/review/lib/codex-hooks.mjs';

const [work, output, pilot] = process.argv.slice(2).map(p => resolve(p));
assert.ok(work && output && pilot && !existsSync(output));
mkdirSync(output, { recursive: true });
const sha256 = s => createHash('sha256').update(s).digest('hex');
const runtime = { dir: join(work, 'replay'), home: join(work, 'home'), tmp: join(work, 'temp'),
  control: join(work, 'home/eval-control'), pluginDirs: [join(work, 'plugins/trace'), join(work, 'tools')],
  denied: [process.cwd(), '/home/ubuntu', join(work, 'plugins/trace')] };
const bin = resolveCodex();
const env = { HOME: runtime.home, CODEX_HOME: join(runtime.home, '.codex'), TMPDIR: runtime.tmp,
  PATH: `${join(work, 'tools')}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' };
writeFileSync(join(runtime.home, '.codex/config.toml'), codexConfig({ ...runtime, model: 'gpt-6.1-sol' }));
const records = [];
function probe(name, script) {
  const r = spawnSync('bwrap', codexBwrap({ ...runtime, bin, env, args: ['sandbox', '--', '/bin/sh', '-c', script] }),
    { cwd: runtime.dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(r.error);
  const log = r.stdout + r.stderr;
  writeFileSync(join(output, `${name}.log`), log);
  records.push({ name, exit: r.status, log_sha256: sha256(log), script });
}
probe('node-and-path', `node -p 'JSON.stringify({node:process.version,exec:process.execPath,tmp:require("os").tmpdir(),home:require("os").homedir()})'; command -v rg || :; command -v GH || :; GH --version`);
probe('protected-records', `test ! -r "$TMPDIR/trace-reads/.key" && test ! -w "$TMPDIR/trace-reads" && node --test --test-name-pattern='own full reads|tells each agent|refuses tools.*read records' test/trace.test.mjs`);
// Test-owned hooks can use a fresh writable store, while the real store stays denied.
mkdirSync(join(runtime.tmp, 'test-owned'), { recursive: true });
probe('test-owned-records', `test ! -r "$TMPDIR/trace-reads/.key" && TMPDIR="$TMPDIR/test-owned" node --test --test-name-pattern='own full reads|tells each agent|refuses tools.*read records' test/trace.test.mjs`);
rmSync(join(runtime.home, '.claude'), { recursive: true, force: true });
probe('claude-home-absent', `node --test --test-name-pattern='guard allows everything else' test/guard.test.mjs`);
mkdirSync(join(runtime.home, '.claude'));
probe('claude-home-directory', `node --test --test-name-pattern='guard allows everything else' test/guard.test.mjs`);
rmSync(join(runtime.home, '.claude'), { recursive: true });
probe('uppercase-gh', `node --test --test-name-pattern='shell runs what the gates read' test/trace.test.mjs`);

// Repeat both exact historical protected-path Node requests through the actual
// trusted adapter and product hook. Never execute the denied command itself.
const events = readFileSync(join(pilot, 'codex-events/pr16-r1_rep0.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [index, event] of events.entries()) {
  const item = event.item;
  if (item?.type !== 'hook_evidence' || !item.input?.command?.startsWith('node --input-type=module') ||
      !String(item.decision?.hookSpecificOutput?.permissionDecisionReason).includes('settings or plugins')) continue;
  const decision = handleHook('PreToolUse', { cwd: runtime.tmp, session_id: `audit-node-${index}`, tool_name: 'Bash', tool_input: item.input },
    { dir: runtime.dir, trace: runtime.pluginDirs[0], role: 'review', denied: runtime.denied, slug: 'trace-eval-rocky/audit-pr16-r1' }, (name, input) => {
      const r = spawnSync(process.execPath, [join(runtime.pluginDirs[0], 'scripts/hook.mjs'), name],
        { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, CLAUDE_PLUGIN_ROOT: runtime.pluginDirs[0] } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout ? JSON.parse(r.stdout) : null;
    });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
  records.push({ name: 'historical-node-guard', event_index: index, command_sha256: sha256(item.input.command), decision });
}
assert.equal(records.filter(r => r.name === 'historical-node-guard').length, 2);
writeFileSync(join(output, 'probes.json'), JSON.stringify(records, null, 2) + '\n');
console.log(JSON.stringify(records.map(({ script, ...r }) => r), null, 2));
