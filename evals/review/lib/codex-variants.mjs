// Eval-only protocol identities. Numeric slot v13 remains visible to the existing
// hillclimb reports; workflow/version/content hash identify the actual treatment.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../variants/', import.meta.url);

/** @param {any} requirements */
export function rejectClaudeRequirements(requirements) {
  if (requirements != null && (typeof requirements !== 'object' || Array.isArray(requirements) || Object.keys(requirements).length))
    throw new Error('unsupported Claude Workflow/slash-command requirements for the Codex adapter');
}

/** @param {string} [id] */
export function codexVariant(id = 'baseline') {
  if (!['baseline', 'v13'].includes(id))
    throw new Error(`unsupported Codex variant '${id}'; supported: baseline, v13 (Claude Workflow/slash variants require a separate adapter)`);
  for (const overlay of ['plugin', 'repo', 'repo-append'])
    if (existsSync(new URL(`${id}/${overlay}`, root))) throw new Error('unsupported Codex variant overlay (Claude Workflow/slash requirements are not emulated)');
  const file = new URL(`${id}/variant.json`, root);
  const bytes = existsSync(file) ? readFileSync(file) : Buffer.from(JSON.stringify({ id: 'baseline', workflow: 'codex-baseline-v1', version: 1 }));
  const manifest = JSON.parse(bytes.toString());
  rejectClaudeRequirements(manifest.requirements);
  const workflow = id === 'baseline' ? 'codex-baseline-v1' : 'codex-evidence-before-fix-v1';
  if (manifest.id !== id || manifest.version !== 1 || manifest.workflow !== workflow ||
      Object.keys(manifest).some(k => !['id', 'name', 'version', 'workflow', 'fix_instructions', 'requirements'].includes(k)) ||
      (id === 'v13' && !manifest.fix_instructions?.trim()) || (id === 'baseline' && manifest.fix_instructions))
    throw new Error('unsupported Codex variant manifest or Workflow/slash requirement');
  return { identity: { id, workflow, version: 1, content_sha256: createHash('sha256').update(bytes).digest('hex') },
    fixInstructions: manifest.fix_instructions ?? '' };
}
