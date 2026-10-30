#!/usr/bin/env node
// Pushes known answers through the grader before any agent run is paid for:
// an oracle review (the ground truth, written as findings) must score recall
// near 1; a null review, "I don't know", and findings about another case's bugs
// must all score 0.
//
//   node evals/review/selftest.mjs [bug-case-id]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOAuth } from './lib/cli.mjs';
import { grade } from './lib/grade.mjs';
import { costOf } from './lib/prices.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const cases = JSON.parse(readFileSync(join(HERE, 'data/cases.json'), 'utf8'));
const bugs = new Map(JSON.parse(readFileSync(join(HERE, 'data/bugs.json'), 'utf8')).map(b => [b.id, b]));
const c = cases.find(x => x.id === (process.argv[2] ?? 'pr16-r1'));
if (!c?.bug_ids.length) throw new Error('pick a bug case with known bugs');
// Wrong target: bugs from a case that starts after this one ends, so they cannot exist in this snapshot yet.
const later = x => spawnSync('git', ['merge-base', '--is-ancestor', c.head, x.base], { cwd: ROOT }).status === 0 && x.base !== c.head;
const other = cases.find(x => x.kind === 'bug' && x.bug_ids.length && later(x));

const prDiff = spawnSync('git', ['diff', c.base, c.head, '--', '.', ':(exclude)archive'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.slice(0, 300_000);
const issue = c.issue ? readFileSync(join(HERE, 'data/issues', `${c.issue}.md`), 'utf8') : c.title;
const asFindings = ids => ids.map((id, i) => `${i + 1}. ${bugs.get(id).location}: ${bugs.get(id).description}`).join('\n');
const round = (k, body) => `=== REVIEW ROUND ${k} (/code-review) ===\n${body}`;

const probes = [
  { name: 'oracle', want: 1, material: `${round(1, asFindings(c.bug_ids))}\n\n${round(2, 'No issues found.')}` },
  { name: 'null', want: 0, material: '' },
  { name: "I don't know", want: 0, material: round(1, "I don't know.") },
  { name: 'wrong target', want: 0, material: round(1, asFindings(other.bug_ids)) },
];

const oauth = readOAuth();
let failed = 0, spend = 0;
for (const p of probes) {
  const work = mkdtempSync(join(tmpdir(), 'review-selftest-'));
  try {
    const g = await grade({ oauth, work, c, bugs, issue, prDiff, changes: '', material: p.material,
      counts: { bug_reviews: 0 }, tests: { before: null, after: null } });
    spend += costOf(g.judge_model, g.judge_usage) ?? 0;
    const ok = Math.abs(g.grade.recall - p.want) <= 0.15;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.name}: recall ${g.grade.recall.toFixed(2)} (want ${p.want}); ${g.explanation.recall}; findings ${g.detail.findings.map(f => f.category).join(',') || 'none'}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(`judge spend at API prices: $${spend.toFixed(2)}`);
process.exit(failed ? 1 : 0);
