// Explicit baseline workflow: independent bug and standards/spec passes, fixes,
// incremental re-review, then Update. These are fresh Codex sessions; no Claude
// Workflow or /code-review command is implicitly emulated by a skill name.
import { spawnSync } from 'node:child_process';
import { codexExec, prepareCodex } from './codex.mjs';
import { codexDigest, sumUsage } from './codex-digest.mjs';

const Review = { type: 'object', additionalProperties: false, required: ['findings', 'asked_human'], properties: {
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['summary', 'location', 'reason'], properties: {
    summary: { type: 'string' }, location: { type: 'string' }, reason: { type: 'string' },
  } } }, asked_human: { type: 'boolean' },
} };
const Final = { type: 'object', additionalProperties: false, required: ['summary', 'asked_human'], properties: {
  summary: { type: 'string' }, asked_human: { type: 'boolean' },
} };
const instructions = `This is an eval adapter for the trace's Review and Update steps.
Read the repository instructions, GLOSSARY.md, every active ADR, and the linked issue and comments yourself in each fresh session. Read required files in full with one literal cat -- <path> command per file; partial output earns no read credit. Re-read after compaction. Respect all trace hook denials.
Do not call Claude, Copilot, Workflow, or slash commands. The harness supplies separate bug and standards/spec review sessions and controls rounds. Do not spawn agents or run another model CLI. Keep all work in this replay. The issue's acceptance criteria govern the change. Do not merge or close anything. No human can answer; when a decision is required, report asked_human and stop.`;

/** @param {any} o @param {(runtime: any, request: any) => Promise<any>} [execute] */
export async function runCodexAgent(o, execute = codexExec) {
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
    let r;
    try {
      r = await execute(runtime, { ...o, phase, prompt: `${instructions}\n\n${o.prompt}\n\n${prompt}`, schema, role, developerInstructions: instructions,
        limitS: Math.max(0.001, (deadline - Date.now()) / 1000) });
    } catch (caught) {
      const e = /** @type {any} */ (caught);
      e.usage = sumUsage([...calls.map(c => c.usage), e.usage]);
      e.events = [...events, ...(e.events ?? [])];
      throw e;
    }
    calls.push(r); events.push(...r.events);
    evidence.push({ phase, output: r.output });
    turns.push(...r.turns); material.push(...r.material);
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
    previous = JSON.stringify({ bugs: bugs.output.findings, standards_spec: spec.output.findings });
    if (bugs.output.asked_human || spec.output.asked_human) { stop = true; break; }
    if (!bugs.output.findings.length && !spec.output.findings.length) break;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: o.dir, encoding: 'utf8' });
    if (head.status !== 0) throw Object.assign(new Error('cannot capture the review round HEAD'), { failure_class: 'harness' });
    fixBase = head.stdout.trim();
    const fixed = await call(`round-${round}-fix`, `Resolve or explicitly reject each finding with evidence; make needed fixes, run relevant tests, and commit with the linked issue number.\n${previous}\nReturn your disposition and test results.`, Final, 'agent');
    if (fixed.output.asked_human) { stop = true; break; }
    if (round === 3) { stop = true; material.push('Three review rounds reached. Ask the human before any fourth round.'); }
  }
  const update = await call('update', `Perform the trace Update step: update the PR body and linked issue with findings, dispositions, tests and remaining decisions. Push commits only to this replay PR. ${stop ? 'Report that human input is required; do not claim the PR is ready.' : 'Report whether the PR is ready for human review.'} No additional review round.\nEvidence from the preceding review and fix sessions (findings, dispositions, verification and decisions):\n${JSON.stringify(evidence)}`, Final, 'agent');
  final = update.output.summary;
  const d = codexDigest(events, o.leak, o.seen);
  const servedMain = [...new Set(calls.flatMap(c => c.servedMain))];
  return { ...d, events, turns, material: [...material, final], servedMain, usage: sumUsage(calls.map(c => c.usage)),
    counts: { ...d.counts, bug_reviews: reviews, std_reviews: standards,
      tool_calls: calls.reduce((n, c) => n + c.counts.tool_calls, 0),
      hook_denials: calls.flatMap(c => c.records).filter(x => x.decision?.hookSpecificOutput?.permissionDecision === 'deny').length },
    output: final, model: calls.find(c => c.model)?.model ?? null,
    provenance: { ...calls[0]?.provenance, workflow: 'codex-baseline-v1', review_rounds: reviews,
      model_verification: calls.every(c => c.model) ? 'response' : 'configured_only',
      calls: calls.map(c => ({ ...c.provenance, artifacts: c.artifacts, raw_usage: c.raw_usage, audit: c.audit })) } };
}
