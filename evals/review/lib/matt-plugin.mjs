// Explicit source pin for new flows. No auth, cache discovery or mutable-cache
// exemptions here. Read-only modes prevent accidents, not hostile same-uid races.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** @param {string|Buffer} bytes */
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** @param {string} path */
function plainAncestors(path) {
  assert.equal(resolve(path), path, 'path must be absolute and normalized');
  for (let p = path; ; p = dirname(p)) {
    assert.ok(!lstatSync(p).isSymbolicLink(), 'symlinked root or ancestor');
    if (p === dirname(p)) break;
  }
}
/** @param {string} path */
function member(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe member path');
  assert.ok(!path.split('/').includes('archive'), 'archive is not a plugin input');
}
/** Exact file kind, bytes, relative link spelling/target, permissions and membership.
 * @param {string} root @param {any} manifest */
export function verifyMattTree(root, manifest) {
  try {
    plainAncestors(root);
    assert.equal(manifest.version, 'cc-agents-matt-pin-v1');
    assert.equal(manifest.policy, 'sealed-relative-links-v1');
    assert.ok(Array.isArray(manifest.files) && manifest.files.length && Array.isArray(manifest.directories));
    const files = new Map(manifest.files.map(/** @param {any} f */ f => { member(f.path); return [f.path, f]; }));
    assert.equal(files.size, manifest.files.length, 'duplicate member');
    const dirs = new Map(manifest.directories.map(/** @param {any} d */ d => { if (d.path !== '') member(d.path); assert.equal(d.mode, 0o500); return [d.path, d]; }));
    assert.equal(dirs.size, manifest.directories.length, 'duplicate directory');
    /** @type {string[]} */ const seenFiles = [];
    /** @type {string[]} */ const seenDirs = [];
    /** @param {string} prefix */
    function walk(prefix) {
      const st = lstatSync(join(root, prefix));
      assert.ok(st.isDirectory() && dirs.has(prefix), 'unexpected directory/kind');
      assert.equal(st.mode & 0o7777, 0o500, 'unsafe directory mode'); seenDirs.push(prefix);
      for (const name of readdirSync(join(root, prefix)).sort()) {
        const path = prefix ? `${prefix}/${name}` : name, full = join(root, path), st = lstatSync(full);
        if (st.isDirectory()) { walk(path); continue; }
        const f = files.get(path); assert.ok(f, 'unexpected member'); seenFiles.push(path);
        assert.match(f.sha256, /^[a-f0-9]{64}$/);
        if (f.kind === 'file') {
          assert.ok(st.isFile() && st.nlink === 1, 'requires regular single-link file');
          assert.ok([0o400, 0o500].includes(f.mode), 'unsafe declared mode');
          assert.equal(st.mode & 0o7777, f.mode, 'changed executable/permission mode');
        } else {
          assert.equal(f.kind, 'symlink'); assert.ok(st.isSymbolicLink(), 'changed symlink kind');
          assert.equal(readlinkSync(full), f.target, 'changed relative link target');
          assert.ok(typeof f.target === 'string' && !isAbsolute(f.target), 'absolute link');
          const target = relative(root, resolve(dirname(full), f.target)); member(target);
          assert.equal(target, f.resolved_target); assert.equal(files.get(target)?.kind, 'file', 'link target must be a declared regular member');
          assert.equal(realpathSync(full), join(root, target), 'escaping or indirect link');
        }
        assert.equal(sha(readFileSync(full)), f.sha256, 'changed member bytes');
      }
    }
    walk('');
    assert.deepEqual(seenFiles.sort(), [...files.keys()].sort(), 'missing member');
    assert.deepEqual(seenDirs.sort(), [...dirs.keys()].sort(), 'missing directory');
  } catch (e) { throw new Error(`Matt pin: ${/** @type {Error} */ (e).message}`); }
}
/** The option must be bound in flow state as well as the execution environment.
 * Legacy flows without either declaration retain their original cache route.
 * @param {any} state @param {Record<string,string|undefined>} [env] */
export function selectMattPlugin(state, env = process.env) {
  if (!Object.hasOwn(state, 'matt_plugin') && !Object.hasOwn(env, 'CC_AGENTS_MATT_PLUGIN_DIR')) return null;
  try {
    const pin = state.matt_plugin;
    assert.ok(pin && typeof pin.directory === 'string' && pin.directory, 'bound directory required');
    assert.equal(env.CC_AGENTS_MATT_PLUGIN_DIR, pin.directory, 'environment and state must declare the same pin');
    assert.ok(pin.manifest_path && !pin.manifest_path.startsWith(pin.directory + '/'), 'control manifest must be outside plugin');
    plainAncestors(pin.manifest_path);
    const st = lstatSync(pin.manifest_path);
    assert.ok(st.isFile() && st.nlink === 1, 'manifest must be a regular single-link file');
    const bytes = readFileSync(pin.manifest_path);
    assert.equal(sha(bytes), pin.manifest_sha256, 'manifest hash mismatch');
    const manifest = JSON.parse(bytes.toString()); verifyMattTree(pin.directory, manifest);
    return { ...pin, manifest };
  } catch (e) { throw new Error(`Matt pin: ${/** @type {Error} */ (e).message}`); }
}
/** Verify source again immediately before copying, then independently verify the
 * run input. The private operator-controlled parent must have no concurrent writer.
 * @param {NonNullable<ReturnType<typeof selectMattPlugin>>} pin @param {string} destination */
export function copyMattPlugin(pin, destination) {
  verifyMattTree(pin.directory, pin.manifest);
  cpSync(pin.directory, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  verifyMattTree(destination, pin.manifest);
}
