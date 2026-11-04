# PR #52 full-send review and proof

PR: https://github.com/lolisaigao1234/cc-agents/pull/52.
The user explicitly requested full-send, babysitting, merge when ready, and updates
on the parent issue and PR. Execution had separate exact human approval for the
v5 calibration and conditional baseline v3, including first-key native-flag
delegation. Merge permission does not widen execution authority.

## Sol-loop

One round, GPT-6.1 Sol, high effort, Codex provider: **APPROVE**, zero findings.
Usage was not returned. Fixed base `bd1ce2c4d6823fd4d0306c845aa2c5551788b513`;
reviewed behavior head `65f7491e51e1b4c409c78d5d7689369c4cf5d4b6`.
The reviewer independently passed 23 focused tests, verified manifest/plan
identities, unchanged v2 selection/gates, all 30 calibration migration hashes,
the exact 176-member Matt pin and 257 dependencies. No code changes were requested,
fixed or declined. The reviewed diff had 103 files, 23,931 insertions and 111
deletions, mostly frozen manifests and retained evidence; review did not grow it.

Independent Standards and Spec reviews also found zero findings; their separate
reports remain in [the correction review](codex-hillclimb-review-48-v3.md).
Later execution commit `150581f5cb1f1f68ade40aacf47b54fe65a1f995` and integration
merge `67c194d5ecd5bde19cb759198cdf2758be94aaf9` add only seven sanitized
reports/indexes. Final parent edits record status and proof. No behavior or frozen
normative input changed, so another behavior review round is not required.

## Proof observed by the parent

- Covering command `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`:
  **89 passed, zero failures/skips**. Protocol command
  `node --test docs/research/codex-hillclimb-48/protocol.test.mjs`:
  **15 passed, zero failures/skips**.
- Ordinary `npm test`: **200 passed, two historical failures, five skips**.
  Four opt-in sandbox checks skipped by this ordinary command passed explicitly
  in the covering command; the other skip requires an interactive loaded mod.
  Historical failures are uppercase-GH shell parsing and installed Claude
  2.1.318 versus vendored 2.1.312 declarations. `npm run typecheck` exits 2 with
  the same 55 known diagnostics. No green full-check claim is made.
- Both actual plans reproduce the exact approved hashes. The native baseline
  approval/calibration gate accepts the matching real records and sealed v5 PASS.
  Prior traced missing/stale gates reject before network/credential access.
- Sealed actual calibration report recomputes **PASS: 75/75 grades, 138 completed
  calls, zero blockers**, zero disagreements across 75 repeat and 189 presentation
  pairs. Actual baseline report exits 2, **INCONCLUSIVE**: seven scored, one failed,
  25 unstarted; completeness false and all validated aggregates/noise null.
- The eighth app is retained ungraded. Its findings prompt is **2,133,624 Unicode
  characters**, above 1,048,576. The local failure preserves the complete request
  and records `provider_call_attempted=false`; no judge CLI launched for it.
  Baseline calls total 34 Sol and 10 Astra, all completed; no retries/replacements.
  Legitimate human stops, three-round stop, tests and adverse evidence remain.
- Parent freshly downloaded the unpublished actual archive and independently
  matched all **1,720 files and 397 directories**, exact member sets, byte sizes,
  hashes, kinds and modes, then matched all original file bytes/hashes/modes.
  Archive SHA256:
  `bb8a209a6fdd9290b65cb8f1126c2376287d6856b2f71e197faa2c1c86cb9fad`.
  The [public hash-only index](codex-hillclimb-48-results-v3/actual-artifact-index.json)
  supplies retrieval metadata; raw evidence stays restricted and unpublished.

Private parent proof is under
`/home/ubuntu/cc-agents-artifacts/issue-48/pr52-full-send`, including original
test logs, review ledger, downloaded archive, independent archive verification
and actual merge verification. No model call was made by the parent to regrade,
retry or replace an experiment result. Source tests were not broadened after
report-only changes.

## Decisions and limits

Preserve the user's requested eval-branch target. The target is an ancestor of
the PR head; importing newer main commits would change the frozen trace skill.
Use the repository's normal merge-commit method, with no admin/protection bypass.
GitHub reports no configured workflows, check runs, commit statuses or submitted
reviews; the REST aggregate's empty `pending` status is not a running CI job.
Check current head/base, mergeability, comments and review threads immediately
before merge. The actual merge commit and final result are recorded on PR #52
and issues #43/#48 after GitHub confirms the merge.

Retain the full capacity failure rather than changing inputs, ceilings or gates
under approval. No new capacity correction, retry or future execution is approved.
Keep #43/#48 open and #49 blocked. Candidate/holdout, Claude, resets and schedules
remain excluded. No numerical adoption or superiority claim is supported.

The merger reported a diagnostic serialization of the failed screened judge
request into its private task tool output. Raw values were not committed or posted
to GitHub. Further output was restricted to allowlisted counts/hashes. This adds
screen-evidence exposure to the already disclosed author-exposure limitations;
it supplies no blindness certification or permission to tune the candidate.
No heldout material was used for this review. The incident is retained in the
restricted merger proof without copying raw values into this report.

Exposure, partial-v2 outcomes, shared source, low power, unknown past exposure,
unproved independence and pin concurrency assumptions persist. Host stdout/stderr
was not retained by the frozen runner; booleans and available agent test evidence
do not establish live readiness. Served identity/tier and spend remain unknown.
Calibration PASS is limited readiness evidence. Adoption remains **INCONCLUSIVE**.
