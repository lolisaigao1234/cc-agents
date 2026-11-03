// Current integrated membership verification, independent of historical approvals.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { sha, stable } from './utils.mjs';

/** @param {string} root @param {string} path */
function bytes(root, path) {
  assert.ok(path && !isAbsolute(path) && !path.split('/').includes('..'), 'invalid inventory path');
  const absolute = resolve(root, path);
  assert.ok(realpathSync(absolute).startsWith(realpathSync(root) + '/'), 'inventory symlink escapes root');
  const st = lstatSync(absolute);
  assert.ok(st.isFile() && st.nlink === 1, 'inventory requires regular single-link files');
  return readFileSync(absolute);
}
/** @param {string} root @param {string[]} paths */
function visible(root, paths) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}
/** @param {string} root */
export function protectedInventory(root) {
  const historical = JSON.parse(readFileSync(join(root, 'docs/research/codex-hillclimb-44/harness-files.json'), 'utf8'));
  const paths = new Set(['evals/review/run.mjs', ...visible(root, historical.harness_paths)]);
  for (const dir of ['', 'evals/review/']) for (const name of ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'])
    if (existsSync(join(root, dir + name))) paths.add(dir + name);
  const hash = createHash('sha256');
  const files = [...paths].sort().map(path => {
    const data = bytes(root, path); hash.update(path).update('\0').update(data).update('\0');
    return { path, sha256: sha(data) };
  });
  return { sha256: hash.digest('hex'), files };
}
/** Includes new dependencies and tests by membership, rather than copying an old file list.
 * @param {string} root */
export function runtimeInventory(root) {
  const paths = new Set([...protectedInventory(root).files.map(f => f.path),
    ...visible(root, ['evals/review', 'plugins/trace', 'test/eval-*.test.mjs', 'test/guard.test.mjs',
      'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore',
      'docs/research/codex-hillclimb-44/verify.mjs', 'docs/research/codex-hillclimb-44/harness-files.json',
      'docs/research/codex-hillclimb-44/artifact-inventory.json', 'docs/research/codex-hillclimb-44/prerequisites.json'])]);
  return [...paths].sort().map(path => ({ path, sha256: sha(bytes(root, path)) }));
}
/** @param {string} root @param {string} [prefix] @returns {{path:string,bytes:number,sha256:string}[]} */
export function privateInventory(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const path = join(prefix, e.name);
    if (e.isDirectory()) return privateInventory(root, path);
    const data = bytes(root, path);
    return [{ path, bytes: data.length, sha256: sha(data) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
/** @param {string} root @param {string} privateRoot @param {any} manifest */
export function verifySnapshot(root, privateRoot, manifest) {
  const files = runtimeInventory(root);
  assert.deepEqual(files, manifest.runtime.files, 'changed runtime membership or bytes');
  assert.equal(sha(stable(files)), manifest.runtime.sha256, 'runtime manifest identity');
  assert.deepEqual(protectedInventory(root), manifest.protected_harness, 'changed combined protected harness');
  assert.deepEqual(privateInventory(privateRoot), manifest.private_files, 'changed private membership or bytes');
}
/** Verify prerequisites before importing the model adapter or touching auth.
 * @param {any} environment */
export function verifyEnvironment(environment) {
  assert.equal(process.platform, environment.platform);
  assert.equal(process.arch, environment.arch);
  assert.equal(process.version, environment.node_version);
  assert.equal(sha(readFileSync(realpathSync(process.execPath))), environment.node_sha256, 'changed Node binary');
  for (const f of [...environment.system_tools, ...environment.codex_runtime_files])
    assert.equal(sha(readFileSync(realpathSync(f.path))), f.sha256, `changed runtime prerequisite ${f.path}`);
}
