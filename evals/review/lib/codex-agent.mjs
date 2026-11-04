// Explicit baseline workflow: independent bug and standards/spec passes, fixes,
// incremental re-review, then Update. These are fresh Codex sessions; no Claude
// Workflow or /code-review command is implicitly emulated by a skill name.
import { spawnSync } from 'node:child_process';
import { codexExec, prepareCodex, validateSchema } from './codex.mjs';
import { codexDigest, sumUsage } from './codex-digest.mjs';
import { codexVariant, rejectClaudeRequirements } from './codex-variants.mjs';

const Review = { type: 'object', additionalProperties: false, required: ['findings', 'asked_human'], properties: {
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['summary', 'location', 'reason'], properties: {
    summary: { type: 'string' }, location: { type: 'string' }, reason: { type: 'string' },
  } } }, asked_human: { type: 'boolean' },
} };
const Final = { type: 'object', additionalProperties: false, required: ['summary', 'asked_human'], properties: {
  summary: { type: 'string' }, asked_human: { type: 'boolean' },
} };
const str = { type: 'string' };
/** @param {Record<string, any>} properties */
const obj = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const EvidenceFix = obj({ summary: str, asked_human: { type: 'boolean' }, dispositions: { type: 'array', items: obj({
  finding_id: str, disposition: { type: 'string', enum: ['fixed', 'rejected', 'needs_human'] },
  evidence: obj({ kind: { type: 'string', enum: ['failure_path', 'test', 'requirement'] }, source: str, check: str, result: str,
    outcome: { type: 'string', enum: ['supports', 'contradicts', 'inconclusive'] } }),
  tests: { type: 'array', items: obj({ command: str, result: str }) }, decision: str,
}) } });

// Completeness checks protect the experimental record, not semantic correctness.
// The unchanged judge still assesses every original finding, including rejects.
/** @param {any} output @param {any[]} findings */
function checkDispositions(output, findings) {
  const ids = output.dispositions.map(/** @param {any} d */ d => d.finding_id);
  if (ids.length !== findings.length || new Set(ids).size !== ids.length || findings.some(f => !ids.includes(f.id)))
    throw new Error('evidence-before-fix requires exactly one disposition per finding');
  for (const d of output.dispositions) {
    const expected = /** @type {Record<string, string>} */ ({ fixed: 'supports', rejected: 'contradicts', needs_human: 'inconclusive' })[d.disposition];
    if (d.evidence.outcome !== expected || ![d.evidence.source, d.evidence.check, d.evidence.result].every(/** @param {string} s */ s => s.trim()) ||
        (d.disposition === 'fixed' && (!d.tests.length || d.tests.some(/** @param {any} t */ t => !t.command.trim() || !t.result.trim()))) ||
        (d.disposition === 'needs_human' && (!d.decision.trim() || !output.asked_human)))
      throw new Error('evidence-before-fix requires checkable evidence, fix tests and unresolved human decisions');
  }
}

const instructions = `This is an eval adapter for the trace's Review and Update steps.
Read the repository instructions, GLOSSARY.md, every active ADR, and the linked issue and comments yourself in each fresh session. Read required files in full with one literal cat -- <path> command per file; partial output earns no read credit. Re-read after compaction. Respect all trace hook denials.
Do not call Claude, Copilot, Workflow, or slash commands. The harness supplies separate bug and standards/spec review sessions and controls rounds. Do not spawn agents or run another model CLI. Keep all work in this replay. The issue's acceptance criteria govern the change. Do not merge or close anything. No human can answer; when a decision is required, report asked_human and stop.`;

// Grader rendering only. Keep the authoritative workflow, events and provenance
// intact: these two hook diagnostics are neither review evidence nor served proof.
/** @param {any} workflow */
export function workflowForGrader(workflow) {
  return { ...workflow, calls: workflow.calls.map(/** @param {any} call */ call => ({ ...call,
    ...(Array.isArray(call.audit) ? { audit: call.audit.map(/** @param {any} event */ ({ active_model, token_usage, ...evidence }) => evidence) } : {}),
  })) };
}

/** @param {any} o @param {(runtime: any, request: any) => Promise<any>} [execute] */
export async function runCodexAgent(o, execute = codexExec) {
  const variant = codexVariant(o.variant);
  rejectClaudeRequirements(o.requirements);
  if (o.variantIdentity && JSON.stringify(o.variantIdentity) !== JSON.stringify(variant.identity))
    throw new Error('Codex variant identity changed since runner preflight');
  const treatment = variant.identity.id === 'v13';
  const runtime = o.runtime ?? prepareCodex({ ...o, denied: o.denyReadTool });
  /** @type {any[]} */ const calls = [];
  /** @type {string[]} */ const material = [];
  /** @type {any[]} */ const turns = [];
  /** @type {any[]} */ const events = [];
  const deadline = Date.now() + o.limitS * 1000;
  /** @type {Array<{phase: string, output: any}>} */ const evidence = [];
  let fixBase = '';
  let reviews = 0, standards = 0, previous = '', stop = false, final = '';
  /** @param {string} phase @param {string} prompt @param {any} schema @param {string} role */
  async function call(phase, prompt, schema, role) {
    const request = { ...o, phase, prompt: `${instructions}\n\n${o.prompt}\n\n${prompt}`, schema, role, developerInstructions: instructions,
      limitS: Math.max(0.001, (deadline - Date.now()) / 1000) };
    const boundary = phase.endsWith('-fix') ? fixBase : null;
    events.push({ type: 'codex.workflow.call.started', phase, role, variant: variant.identity, pre_fix_sha: boundary,
      requested_model: o.model, prompt: request.prompt, schema });
    let r;
    try {
      r = await execute(runtime, request);
    } catch (caught) {
      const e = /** @type {any} */ (caught);
      e.usage = sumUsage([...calls.map(c => c.usage), e.usage]);
      e.events = [...events, ...(e.events ?? []), { type: 'codex.workflow.call.failed', phase, role, variant: variant.identity, error: e.message, artifacts: e.artifacts, raw_usage: e.raw_usage, audit: e.audit }];
      throw e;
    }
    const recorded = { phase, role, variant: variant.identity, pre_fix_sha: boundary, output: r.output,
      ...r.provenance, artifacts: r.artifacts, raw_usage: r.raw_usage, audit: r.audit };
    calls.push({ ...r, recorded }); events.push(...r.events, { type: 'codex.workflow.call.completed', ...recorded });
    evidence.push({ phase, output: r.output, ...(boundary ? { pre_fix_sha: boundary } : {}) });
    try { validateSchema(r.output, schema); }
    catch (e) { throw Object.assign(/** @type {Error} */ (e), { failure_class: 'harness', usage: sumUsage(calls.map(c => c.usage)), events }); }
    turns.push(...r.turns); material.push(...r.material, `=== CODEX ${phase} OUTPUT ===\n${JSON.stringify(r.output)}`);
    // Leak scans include trusted hook tool inputs/results, where exec JSONL may
    // omit feedback. Never classify the configured answer-key policy as a leak.
    events.push(...r.records.filter(/** @param {any} x */ x => x.tool).map(/** @param {any} x @param {number} i */ (x, i) => ({ type: 'item.completed', item: {
      id: `${phase}-hook-${i}`, type: 'hook_evidence', input: x.input, response: x.response, decision: x.decision } })));
    const scan = codexDigest(events, o.leak, o.seen);
    if (scan.leaks.length) throw Object.assign(new Error(`agent reached for the answer key: ${scan.leaks[0]}`), {
      failure_class: 'answer_key_leak', usage: sumUsage(calls.map(c => c.usage)), events,
    });
    return r;
  }
  for (let round = 1; round <= 3; round++) {
    const scope = round === 1 ? 'Review the entire PR diff against its branch base.' : `Re-review git diff ${fixBase} HEAD plus any uncommitted changes (git diff HEAD); this boundary was captured before the preceding fix phase. Check regressions and unresolved findings. Previous findings:\n${previous}`;
    material.push(`=== REVIEW ROUND ${round} (Codex bug and standards/spec reviews) ===`);
    const bugs = await call(`round-${round}-bugs`, `${scope}\nPerform the bug review. Report concrete defects requiring a fix, with failure paths and locations. Return an empty findings list when clean. Do not edit code or post comments.`, Review, 'review');
    reviews++;
    const spec = await call(`round-${round}-standards`, `${scope}\nIndependently review repository standards (GLOSSARY.md, active ADRs, instructions) and issue acceptance criteria. Report violations that require a fix. Do not edit code or post comments.`, Review, 'review');
    standards++;
    const findings = [['bugs', bugs], ['standards', spec]].flatMap(([reviewer, result]) =>
      result.output.findings.map(/** @param {any} finding @param {number} i */ (finding, i) => ({ id: `round-${round}-${reviewer}-${i + 1}`, ...finding })));
    previous = JSON.stringify(treatment ? findings : { bugs: bugs.output.findings, standards_spec: spec.output.findings });
    if (bugs.output.asked_human || spec.output.asked_human) { stop = true; break; }
    if (!bugs.output.findings.length && !spec.output.findings.length) break;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: o.dir, encoding: 'utf8' });
    if (head.status !== 0) throw Object.assign(new Error('cannot capture the review round HEAD'), { failure_class: 'harness', usage: sumUsage(calls.map(c => c.usage)), events });
    fixBase = head.stdout.trim();
    const fixed = await call(`round-${round}-fix`, `Resolve or explicitly reject each finding with evidence; make needed fixes, run relevant tests, and commit with the linked issue number.\n${previous}\nReturn your disposition and test results.${treatment ? `\n${variant.fixInstructions}` : ''}`, treatment ? EvidenceFix : Final, 'agent');
    if (treatment) {
      try { checkDispositions(fixed.output, findings); }
      catch (e) { throw Object.assign(/** @type {Error} */ (e), { failure_class: 'harness', usage: sumUsage(calls.map(c => c.usage)), events }); }
    }
    if (fixed.output.asked_human) { stop = true; break; }
    if (round === 3) { stop = true; material.push('Three review rounds reached. Ask the human before any fourth round.'); }
  }
  const update = await call('update', `Perform the trace Update step: update the PR body and linked issue with findings, dispositions, tests and remaining decisions. Push commits only to this replay PR. ${stop ? 'Report that human input is required; do not claim the PR is ready.' : 'Report whether the PR is ready for human review.'} No additional review round.\nEvidence from the preceding review and fix sessions (findings, dispositions, verification and decisions):\n${JSON.stringify(evidence)}`, Final, 'agent');
  if (treatment && stop && !update.output.asked_human)
    throw Object.assign(new Error('Update must preserve the unresolved human decision'), { failure_class: 'harness', usage: sumUsage(calls.map(c => c.usage)), events });
  final = update.output.summary;
  const workflow = { variant: variant.identity, calls: calls.map(c => c.recorded), asked_human: stop || update.output.asked_human };
  turns.push({ role: 'codex_workflow', content: workflow });
  material.push(`=== CODEX WORKFLOW RECORD (all findings and dispositions, including rejected/unresolved) ===\n${JSON.stringify(workflowForGrader(workflow))}`);
  const d = codexDigest(events, o.leak, o.seen);
  const servedMain = [...new Set(calls.flatMap(c => c.servedMain))];
  return { ...d, events, turns, material: [...material, final], servedMain, usage: sumUsage(calls.map(c => c.usage)),
    counts: { ...d.counts, bug_reviews: reviews, std_reviews: standards,
      tool_calls: calls.reduce((n, c) => n + c.counts.tool_calls, 0),
      hook_denials: calls.flatMap(c => c.records).filter(x => x.decision?.hookSpecificOutput?.permissionDecision === 'deny').length },
    output: final, model: calls.find(c => c.model)?.model ?? null,
    provenance: { ...calls[0]?.provenance, workflow: variant.identity.workflow, variant: variant.identity, review_rounds: reviews,
      model_verification: calls.every(c => c.model) ? 'response' : 'configured_only',
      calls: calls.map(c => c.recorded) } };
}
