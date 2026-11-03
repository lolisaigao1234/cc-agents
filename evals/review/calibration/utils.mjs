import { createHash } from 'node:crypto';
/** @param {string|Buffer} bytes */
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Canonical manifest serialization shared by writer and verifier.
 * @param {any} value @returns {string} */
export const stable = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
