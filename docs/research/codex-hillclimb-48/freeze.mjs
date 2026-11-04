// Offline freezer for the new experiment, not the calibrated runtime.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from './protocol.mjs';
import { executionConfig } from '../../../evals/review/lib/config.mjs';
import { verifySnapshot, verifyEnvironment } from '../../../evals/review/calibration/snapshot.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DIR = 'docs/research/codex-hillclimb-48';
export const PRIVATE_V4 = '/home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4';
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
const derived = new Set(['experiment-manifest.json', 'approval.md', 'plan.json', 'handoff.md']);

export function inputNames(root) {
  return readdirSync(join(root, DIR)).filter(name => !derived.has(name) && name !== 'checks').sort();
}

// Hash only known non-secret dependency trees. Preserve symlink identities too.
export function treeInventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert.notEqual(entry.name, 'archive', 'human-only archive cannot be inventoried');
    const path = join(prefix, entry.name), full = join(root, path), st = lstatSync(full);
    if (st.isDirectory()) return treeInventory(root, path);
    const real = realpathSync(full);
    assert.ok(real.startsWith(realpathSync(root) + '/'), 'dependency symlink escapes inventory root');
    assert.ok(st.isSymbolicLink() || (st.isFile() && st.nlink === 1), 'nonregular dependency');
    return [{ path, sha256: sha(readFileSync(full)), ...(st.isSymbolicLink() ? { target: relative(root, real) } : {}) }];
  });
}

export function verifyBoundFiles(root, files) {
  assert.deepEqual(inputNames(root), files.map(f => f.path.slice(DIR.length + 1)).sort(), 'changed experiment input membership');
  for (const f of files) {
    assert.ok(f.path.startsWith(DIR + '/') && !f.path.split('/').includes('..'));
    const path = join(root, f.path), st = lstatSync(path);
    assert.ok(st.isFile() && st.nlink === 1 && realpathSync(path) === path, 'experiment input must be a regular single-link file');
    assert.equal(sha(readFileSync(path)), f.sha256, `changed experiment input ${f.path}`);
  }
}

export function verifyExperiment(root = ROOT) {
  const m = json(join(root, DIR, 'experiment-manifest.json'));
  verifyBoundFiles(root, m.inputs);
  const v4path = join(root, 'docs/research/codex-hillclimb-46/preregistration-v4.json');
  assert.equal(sha(readFileSync(v4path)), m.calibration.preregistration_sha256, 'changed v4 preregistration');
  const v4 = json(v4path);
  verifySnapshot(root, PRIVATE_V4, v4); verifyEnvironment(v4.environment);
  assert.equal(sha(readFileSync(join(root, 'evals/review/calibration/protocol-v4.json'))), m.calibration.protocol_sha256);
  const env = json(join(root, DIR, 'environment-files.json'));
  for (const t of env.trees) assert.deepEqual(treeInventory(t.scope === 'repository' ? join(root, t.root) : t.root), t.files, `changed environment tree ${t.root}`);
  for (const f of env.files) assert.equal(sha(readFileSync(realpathSync(f.path))), f.sha256, `changed external tool ${f.path}`);
  const versions = readdirSync(env.matt_cache).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
  assert.equal(versions.at(-1), env.matt_version, 'runner would select a different Matt plugin');
  assert.equal(process.env.TMPDIR ?? '/tmp', m.variables.TMPDIR, 'changed TMPDIR');
  for (const key of ['CODEX_BIN', 'CODEX_EVAL_HOME']) if (process.env[key]) assert.equal(process.env[key], m.variables[key], `changed ${key}`);
  return { manifest: m, protocol: json(join(root, DIR, 'protocol.json')),
    current: { manifest_sha256: sha(readFileSync(join(root, DIR, 'experiment-manifest.json'))),
      protocol_sha256: sha(readFileSync(join(root, DIR, 'protocol.json'))) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--write-new-preparation', 'explicit preparation-only freezer flag required');
  assert.ok(!existsSync(join(ROOT, DIR, 'experiment-manifest.json')), 'never overwrite a frozen experiment');
  const protocol = json(join(ROOT, DIR, 'protocol.json'));
  const v4 = json(join(ROOT, 'docs/research/codex-hillclimb-46/preregistration-v4.json'));
  verifySnapshot(ROOT, PRIVATE_V4, v4); verifyEnvironment(v4.environment);
  const mattCache = '/home/ubuntu/.claude/plugins/cache/mattpocock/mattpocock-skills';
  assert.equal(readdirSync(mattCache).sort((a,b) => a.localeCompare(b, undefined, { numeric: true })).at(-1), '1.3.2');
  const env = { matt_cache: mattCache, matt_version: '1.3.2',
    trees: [{ root: join(mattCache, '1.3.2'), scope: 'external' }, { root: 'node_modules', scope: 'repository' },
      { root: '/usr/local/lib/node_modules/npm', scope: 'external' }]
      .map(t => ({ ...t, files: treeInventory(t.scope === 'repository' ? join(ROOT, t.root) : t.root) })),
    files: ['/usr/bin/gh','/usr/bin/git','/usr/bin/bwrap','/usr/bin/socat','/usr/bin/flock','/usr/bin/sh','/usr/bin/env','/usr/bin/tar','/usr/local/bin/npm']
      .map(path => ({ path, sha256: sha(readFileSync(realpathSync(path))) })),
    platform: process.platform, arch: process.arch, node: process.version,
    limits: 'Kernel/shared libraries/services/quota/served snapshots remain external; credentials excluded.' };
  writeFileSync(join(ROOT, DIR, 'environment-files.json'), JSON.stringify(env, null, 2) + '\n', { flag: 'wx' });
  const state = json(join(ROOT, DIR, 'flow-state.template.json'));
  const manifest = { version: protocol.version, status: 'UNAPPROVED_PREPARATION', parent_commit: protocol.parent_commit,
    inputs: inputNames(ROOT).map(name => ({ path: `${DIR}/${name}`, sha256: sha(readFileSync(join(ROOT, DIR, name))) })),
    variables: protocol.environment_variables,
    expected_execution: Object.fromEntries(['baseline','v13'].map(variant => [variant, executionConfig(state,
      { agent: 'codex', model: 'gpt-6.1-sol', variant, concurrency: 1 })])),
    calibration: { protected_harness_sha256: v4.protected_harness.sha256, runtime_sha256: v4.runtime.sha256,
      protocol_sha256: sha(readFileSync(join(ROOT, 'evals/review/calibration/protocol-v4.json'))),
      preregistration_sha256: sha(readFileSync(join(ROOT, 'docs/research/codex-hillclimb-46/preregistration-v4.json'))) },
    source_objects: [...protocol.screen, ...protocol.holdout].map(c => ({ id: c.id,
      base: execFileSync('git', ['rev-parse', `${c.base}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', `${c.head}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim() })),
    permission: 'None. Human response and independent exposure review required before any authentication/model/replay operation.' };
  writeFileSync(join(ROOT, DIR, 'experiment-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(verifyExperiment().current, null, 2));
}
