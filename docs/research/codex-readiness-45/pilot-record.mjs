// Hash-verified, pilot-only operational evidence. Never opens judge inputs,
// judge responses, bugs.json, adjudication or other cases' findings.
// Usage: node docs/research/codex-readiness-45/pilot-record.mjs PILOT_DIR NEW_OUTPUT_FILE
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [pilot, output] = process.argv.slice(2);
assert.ok(pilot && output && !existsSync(output));
const inventory = JSON.parse(readFileSync(new URL('../codex-hillclimb-44/artifact-inventory.json', import.meta.url)));
const sha256 = s => createHash('sha256').update(s).digest('hex');
function verified(path) {
  const bytes = readFileSync(join(pilot, path));
  assert.equal(sha256(bytes), inventory.files.find(f => f.path === path)?.sha256, path);
  return bytes.toString('utf8');
}
const baseline = 'review-codex-sol-astra/baseline';
const rows = verified(`${baseline}/results.jsonl`).trim().split('\n').map(JSON.parse);
const records = [];
for (const id of ['pr16-r1', 'pr24', 'pr35-r0', 'clean-pr33', 'conv-pr33']) {
  const row = rows.find(r => r.prompt_id === id);
  const tracePath = `${baseline}/traces/${id}_rep0.json`;
  const messages = JSON.parse(verified(tracePath));
  const tests = [];
  const repeated = [];
  for (const [index, message] of messages.entries()) {
    if (message.name !== 'command_execution') continue;
    const command = JSON.parse(message.content);
    if (!/npm test|node --test/.test(command.command)) continue;
    const shown = command.aggregated_output?.replaceAll('\\n', '\n') ?? '';
    for (const m of shown.matchAll(/^Run (\d+): exit (\d+)$/gm)) repeated.push({ trace_message_index: index, run: Number(m[1]), exit: Number(m[2]) });
    const counts = Object.fromEntries([...shown.matchAll(/^[#ℹ] (tests|pass|fail|skipped) (\d+)/gm)].map(m => [m[1], Number(m[2])]));
    if (!Object.hasOwn(counts, 'tests')) continue;
    tests.push({ trace_message_index: index, exit: command.exit_code, counts,
      failures: [...new Set([...shown.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)].map(m => m[1]).filter(s => s !== 'failing tests:'))] });
  }
  const final = messages.findLast(m => m.role === 'assistant');
  records.push({ id, results_line: inventory.scored.find(r => r.case === id).results_line,
    trace: tracePath, trace_sha256: sha256(readFileSync(join(pilot, tracePath))),
    host_tests_before_after: row.meta.tests, asked_human: row.asked_human, rounds: row.rounds,
    candidate_test_observations: tests, repeated_test_exits: repeated,
    final_message_index: messages.lastIndexOf(final), final: JSON.parse(final.content) });
}
writeFileSync(output, JSON.stringify({ pilot_harness_sha: inventory.pilot_harness_sha,
  protocol: 'codex-baseline-v1', records }, null, 2) + '\n');
