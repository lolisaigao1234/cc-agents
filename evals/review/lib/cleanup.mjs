// Removing a run's directories. A case can leave directories nobody may enter
// or write (a test that drops a directory's permissions and never restores
// them), and rmSync alone gives up on those with EACCES. Cleanup runs in a
// `finally`, so a throw there would replace the run's result: never throw.

import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Removes `p` and everything under it. Gives the owner back full access to each
 * directory first when a plain removal fails. Symlinks are removed, never
 * followed. Reports what it could not remove through `warn` instead of throwing.
 *
 * @param {string} p
 * @param {(message: string) => void} [warn]
 */
export function removeTree(p, warn = () => {}) {
  try { rmSync(p, { recursive: true, force: true }); return; } catch { /* unlock, then try again */ }
  try {
    unlock(p);
    rmSync(p, { recursive: true, force: true });
  } catch (e) {
    warn(`could not remove ${p}: ${/** @type {Error} */ (e)?.message ?? e}`);
  }
}

/** @param {string} dir */
function unlock(dir) {
  let st;
  try { st = lstatSync(dir); } catch { return; }
  if (!st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) unlock(join(dir, name));
}
