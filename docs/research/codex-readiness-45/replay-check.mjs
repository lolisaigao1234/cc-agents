// Offline #45 audit. No model execution, GitHub calls, answer keys or approvals.
// Usage: node docs/research/codex-readiness-45/replay-check.mjs NEW_OUTPUT_DIR [--sandbox-only] [--historical-policy]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSlugs } from '../../../evals/review/lib/replay.mjs';
import { codexBwrap, codexConfig, prepareCodex, resolveCodex } from '../../../evals/review/lib/codex.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && !existsSync(output), 'provide a NEW output directory');
mkdirSync(output, { recursive: true });
const hash = b => createHash('sha256').update(b).digest('hex');
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...options });
  assert.ifError(r.error);
  return r;
};
const checked = (cmd, args, options) => {
  const r = run(cmd, args, options);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
};
const summary = r => ({ exit: r.status, signal: r.signal,
  counts: Object.fromEntries([...r.stdout.matchAll(/^[#ℹ] (tests|pass|fail|skipped) (\d+)/gm)].map(m => [m[1], Number(m[2])])),
  failures: [...new Set([...r.stdout.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)].map(m => m[1]).filter(s => s !== 'failing tests:'))],
});
// Explicit pilot-only revision allowlist; do not load cases.json or bugs.json.
const cases = [
  ['pr16-r1', 'bug', '8b2a99f'], ['pr24', 'bug', '0ad0f2d'],
  ['pr35-r0', 'bug', '52c688f'], ['clean-pr33', 'clean', '8eddafd'],
  ['conv-pr33', 'convergence', '195172b'],
];
const bin = resolveCodex();
const records = [];
for (const [id, kind, head] of cases) {
  const work = join(output, id), dir = join(work, 'replay');
  mkdirSync(dir, { recursive: true });
  const tar = run('git', ['archive', '--format=tar', head, '--', '.', ':(exclude)archive'], { cwd: root, encoding: null });
  assert.equal(tar.status, 0);
  checked('tar', ['-x', '-C', dir], { input: tar.stdout });
  // Same text rewrite and opt-in as buildReplay; baseline has no repo overlay.
  const rewrite = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) rewrite(p);
      else if (e.isFile()) {
        const bytes = readFileSync(p);
        if (!bytes.includes(0)) writeFileSync(p, renameSlugs(bytes.toString('utf8'),
          { owner: 'lolisaigao1234', repo: 'cc-agents' }, `trace-eval-rocky/audit-${id}`));
      }
    }
  };
  rewrite(dir);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (!existsSync(join(dir, '.claude/trace.json'))) writeFileSync(join(dir, '.claude/trace.json'), '{}\n');
  const git = args => checked('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', 'commit', '-qm', 'Unmodified replay snapshot']);
  git(['remote', 'add', 'origin', `https://github.com/trace-eval-rocky/audit-${id}.git`]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(['checkout', '-qb', '1-audit']);
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const before = Object.fromEntries(files.map(p => [p, hash(readFileSync(join(dir, p)))]));
  checked('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  const home = join(work, 'home'), tmp = join(work, 'temp'), authHome = join(work, 'dummy-auth');
  for (const p of [home, tmp, authHome]) mkdirSync(p);
  const trace = join(work, 'plugins/trace');
  cpSync(join(root, 'plugins/trace'), trace, { recursive: true });
  const toolDir = join(work, 'tools');
  mkdirSync(toolDir);
  // Only a minimal open replay issue is needed by old guard smoke tests.
  // Test-owned gh stubs still precede this one. No real network fallback.
  writeFileSync(join(toolDir, 'gh'), `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='alias') process.exit(0);
if(args.some(a=>a.endsWith('/issues/1'))) { console.log(JSON.stringify({state:'open',title:'Replay audit',body:'',comments:0})); process.exit(0); }
process.stderr.write('offline audit: unsupported gh request'); process.exit(1);
`, { mode: 0o755 });
  writeFileSync(join(authHome, 'auth.json'), '{"fixture":"no credentials"}', { mode: 0o600 });
  const runtime = prepareCodex({ dir, home, tmp, auth: { home: authHome, auth: join(authHome, 'auth.json') },
    pluginDirs: [trace], denied: [root, '/home/ubuntu', trace] });
  let config = codexConfig({ ...runtime, model: 'gpt-6.1-sol', role: 'agent' });
  // Offline counterfactual only: recreate the pre-#45 policy bytes. This
  // switch never invokes exec, runs models or changes an approval record.
  if (process.argv.includes('--historical-policy')) config = config.split('\n')
    .filter(line => line !== `${JSON.stringify(join(tmp, '.git'))} = "write"`).join('\n');
  writeFileSync(join(home, '.codex/config.toml'), config);
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: tmp, PATH: `${toolDir}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8' };
  // Host measurement matches the runner's outside-sandbox testsPass seam,
  // with an empty fixture HOME instead of reading the operator's home.
  // No hooks wrap npm itself: tests invoke their original product hooks.
  for (const mode of process.argv.includes('--sandbox-only') ? ['sandbox'] : ['host', 'sandbox']) {
    if (mode === 'host') mkdirSync(join(home, '.claude'));
    else rmSync(join(home, '.claude'), { recursive: true, force: true });
    // Expose only the offline gh shim alongside the attempt temp mount.
    const launchRuntime = { ...runtime, pluginDirs: [trace, toolDir] };
    const r = mode === 'host'
      ? run('npm', ['test', '--silent'], { cwd: dir, env })
      : run('bwrap', codexBwrap({ ...launchRuntime, bin, env, args: ['sandbox', '--', 'npm', 'test', '--silent'] }), { cwd: dir, env });
    writeFileSync(join(work, `${mode}.log`), r.stdout + r.stderr);
    const record = { id, kind, head: checked('git', ['rev-parse', head], { cwd: root }).trim(), mode,
      ...summary(r), log: relative(output, join(work, `${mode}.log`)), log_sha256: hash(r.stdout + r.stderr) };
    records.push(record);
    console.log(JSON.stringify(record));
  }
  for (const [p, sha] of Object.entries(before)) assert.equal(hash(readFileSync(join(dir, p))), sha, `snapshot changed: ${id}/${p}`);
  writeFileSync(join(work, 'snapshot-files.json'), JSON.stringify(before, null, 2) + '\n');
  writeFileSync(join(output, 'checks.json'), JSON.stringify({ protocol: 'offline-readiness-45-v1',
    policy: process.argv.includes('--historical-policy') ? 'historical-pilot' : 'checkout',
    node: process.version, codex: '0.166.0', records }, null, 2) + '\n');
}
