// Frozen per-flow execution identity. Legacy flows retain their original judge.
export const LEGACY_JUDGE = { agent: 'claude', model: 'claude-fable-5-1', effort: 'high', service_tier: null };
export const CODEX_JUDGE = { agent: 'codex', model: 'gpt-6-astra', effort: 'high', service_tier: 'fast' };
export const CODEX_MODEL = 'gpt-6.1-sol';
export const CODEX_VERSION = '0.166.0';

/** @param {any} state @param {any} args */
export function executionConfig(state, args) {
  const judge = { ...LEGACY_JUDGE, ...state.judge };
  if (!['claude', 'codex'].includes(judge.agent) || !judge.model || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(judge.effort))
    throw new Error('invalid frozen judge configuration');
  if (judge.agent === 'codex' && (judge.model !== CODEX_JUDGE.model || judge.service_tier !== 'fast'))
    throw new Error('the Codex judge must be gpt-6-astra in Fast mode');
  const codex = args.agent === 'codex';
  if (codex && (args.model !== CODEX_MODEL || state.effort !== 'high' || state.service_tier !== 'fast'))
    throw new Error('the Codex competitor must be gpt-6.1-sol, high effort, Fast mode');
  if (codex && args.variant !== 'baseline')
    throw new Error('Codex currently supports baseline only; Claude Workflow variants need a separate adapter');
  if ((codex || judge.agent === 'codex') && args.concurrency !== 1)
    throw new Error('Codex subscription auth requires --concurrency 1 (including the judge)');
  if ((codex || judge.agent === 'codex') && !['required', 'configured_only'].includes(state.model_verification))
    throw new Error('freeze model_verification as required or configured_only before using Codex');
  if (state.claude?.status === 'exhausted' && (args.agent === 'claude' || judge.agent === 'claude')) {
    const reset = Date.parse(state.claude.resume_after ?? '');
    if (!Number.isFinite(reset) || Date.now() < reset)
      throw new Error(`Claude usage exhausted; resume after ${state.claude.resume_after ?? 'the confirmed usage reset'}`);
  }
  return { judge, effort: state.effort, serviceTier: state.service_tier, modelVerification: state.model_verification ?? 'required',
    codexVersion: state.codex_version ?? CODEX_VERSION };
}

/** @param {string} requested @param {string[] | null | undefined} served @param {string} [verification] */
export function assertModel(requested, served, verification = 'required') {
  if (!served?.length) {
    if (verification === 'required') throw Object.assign(new Error(`no response-backed model evidence for ${requested}`), { failure_class: 'model_evidence_missing' });
    return null;
  }
  const mismatch = served.find(m => m !== requested && !new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-@](?:\\d{8}|\\d{4}-\\d{2}-\\d{2})$`).test(m));
  if (mismatch) throw Object.assign(new Error(`served model ${mismatch} != requested ${requested}`), { failure_class: 'serving_substitution' });
  return served[0];
}
