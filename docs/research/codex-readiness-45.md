# #45: replay readiness audit

One harness portability fault is confirmed and corrected: Codex CLI 0.166.0's
implicit read-only `.git` placeholder at the writable temporary root changes
historical archive discovery. The other investigated behaviors do **not** justify
changing product code or relaxing a guard. All five pilot cases remain in the
screen; unresolved acceptance criteria and human decisions remain visible.

This is an **offline readiness audit**, not a new candidate experiment. No models,
Claude sessions, judge calls, reset redemption, remote replay repositories or
GitHub posts were used. Only these five pilot snapshots and their operational
evidence were inspected; no held-out findings, judge inputs, raw judge responses,
adjudication or calibration answers were consulted. Historical product files,
dataset snapshots, rubric, candidate instructions and approvals are unchanged.

## Provenance and approval boundary

Historical Sol/Astra pilot and deferred Opus/Astra fingerprint:

`e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612`

Changed harness fingerprint (115 files):

`b9f15bbf16115038993b7e3094049b6407ed180382d4429cbadc8533346d533a`

[New file inventory](codex-readiness-45/harness-files.json) records the exact
protected membership and byte hashes. The only changed protected file is
`evals/review/lib/codex.mjs`. The workflow identity remains `codex-baseline-v1`;
the audit procedure is `offline-readiness-45-v1`. Competitor/judge configuration
remains requested Sol/Astra High/Fast, subscription authentication, concurrency
1. Observed served model/tier and unpriced spend remain unknown/null. No new
response-backed identity was observed.

**HUMAN approval is required before any live run on the changed harness.** The
historical offline verifier exits 2 with that exact stop and the new SHA
([log](codex-readiness-45/checks/fingerprint-after.log)). No approval flag or
approved state was edited. This work does not authorize #46 or the deferred
Opus/Astra schedule to use the new runtime. The old pinned checkout, original
approval and deferred comparison remain identifiable and untouched. A human
must review the concrete policy diff, regression, inventory and readiness
limitations before approving a new flow; this audit grants no approval.

Before the edit, the #44 verifier checked both pinned approvals, all 39 retained
artifact hashes, five unique scored keys and eight failed attempts. All 39 files
were hashed again afterward and remain unchanged. The original archive SHA256 is
`ada8cad455f614aadb10f7b2e2d1789c2fc5aafe3b3ab88709463b74b57d10ce`;
its maintainer-access draft-release retention is documented in the
[#44 handoff](codex-hillclimb-handoff-44.md). Nothing was rescored or backfilled.

## Reproduction and measurement boundaries

[replay-check.mjs](codex-readiness-45/replay-check.mjs) materializes each allowlisted
historical head using `git archive` excluding the human archive, applies the same
slug rewrite and opt-in as `buildReplay`, installs locked dependencies without
scripts, and creates an isolated repository on an issue branch. There is no
baseline repository overlay. Every tracked snapshot file is hashed before and
after tests; all remain identical. New untracked runtime directories are not
product edits. A minimal offline GitHub stub supplies an open replay issue to old
smoke tests; test-owned GitHub stubs take precedence. It never falls through to
the network. This does not reproduce GitHub service behavior or model decisions.

The **host** measurement uses a fresh home with an empty `.claude` directory,
separate temp and system tools. It approximates the runner's outside-sandbox
`testsPass`, without reading personal configuration. The **sandbox** measurement
uses the real pinned CLI's `sandbox` command inside `codexBwrap`, dummy auth,
the full protected plugin layout and an empty Codex-style home. The command is
an agent-role test process, permitted to create scratch files; reviewer writes
are checked separately. Product hooks invoked by tests run inside this command
sandbox; trusted review hooks run outside it. That distinction explains the
read-record results below.

Node is v24.22.2 at `/usr/local/bin/node`; Codex is 0.166.0 on Linux aarch64.
Claude is absent from the isolated system PATH, so the two later-snapshot skips
are missing CLI declarations/version comparison and missing interactive-generated
declarations. The repository's ordinary full suite separately checks the actual
installed CLI version. Skips are not passing verification.

An initial fixture put the protected plugin under denied `/home` and omitted
the replay issue-branch context. Its sandbox could not start (`Can't mkdir
/home/ubuntu: Read-only file system`). Those setup failures are retained under
`ticket-45-evidence/replay-v1`; they are excluded from the matrix. The corrected
fixture copies the protected plugin under the attempt root, as the actual runner
does. The complete valid pre-edit and corrected measurements are committed in
[unmodified/checks.json](codex-readiness-45/checks/unmodified/checks.json) and
[corrected/checks.json](codex-readiness-45/checks/corrected/checks.json), with logs,
hashes and unchanged snapshot manifests.

## Balanced readiness matrix

Counts are **pass / fail / skip**. "Historical host" is the original recorded
before/after boolean, not a claim that every candidate-side command passed.
Candidate outcomes below are saved observations, not new model executions.
The case-level [operational record](codex-readiness-45/checks/pilot-record.json)
gives immutable trace hashes, zero-based message indexes, test observations and
final dispositions without judge material.

| Case (kind; historical head) | Historical host before → after | Unmodified host | Unmodified sandbox → corrected sandbox | Saved candidate outcome | Readiness / exclusion |
| --- | --- | --- | --- | --- | --- |
| pr16-r1 (bug; `8b2a99f`) | true → true | 29/0/0 | 28/1/0 → **29/0/0** | One round; no source fix; 28/1/0 inside sandbox; `asked_human=1` | Runnable test baseline after correction. Preserve human stop for protected Node probe and live/subagent verification. Excluded from autonomous acceptance completion. |
| pr24 (bug; `0ad0f2d`) | false → false | 89/2/0 | 85/6/0 → 86/5/0 | Two rounds; README change; 85/6/0 inside sandbox; `asked_human=0` | Runnable docs screen with declared baseline failures. Original issue #23 has documentation criteria; failures cannot be described as passing regression coverage. |
| pr35-r0 (bug; `52c688f`) | false → false | 93/1/2 | 89/5/2 → 90/4/2 | One round; deadline regression/typecheck passed; five full-suite runs exited 1; `asked_human=1` | Runnable diagnostic screen. Excluded from declaring original issue #32 complete: five consecutive passing runs remain unverified. |
| clean-pr33 (clean; `8eddafd`) | false → false | 92/1/2 | 88/5/2 → 89/4/2 | Two rounds; changed status/band and its tests; 88/5/2 inside sandbox; `asked_human=1` | Retain as the clean control, including candidate edits and human stop. Excluded from claiming issue #31's passing-suite criterion. |
| conv-pr33 (convergence; `195172b`) | false → false | 92/1/2 | 88/5/2 → 89/4/2 | Three rounds; candidate changed instructions, status and several tests; reported 94/0/2 inside sandbox; `asked_human=0` | Retain convergence control and round-cap evidence. Candidate's green command does not supersede the saved host-after=false measurement or establish acceptance. No fourth round is authorized. |

All five are reproducible offline cases. **All live execution on the changed SHA
is excluded until real human harness approval.** Baseline failures are accepted
as disclosed screening conditions, not waived issue criteria or successful
reviews. No case is silently dropped to improve readiness. Three bug cases, one
clean control and one convergence case are the minimum balanced continuation of
the existing pilot. More cases/repetitions are needed for a quality/latency or
adoption claim, but not to establish this environment fault. Choosing additional
cases using held-out findings would contaminate that later experiment; no such
selection was performed here.

## Evidence-backed classifications

| Behavior | Observation and controlled check | Classification, action and uncertainty |
| --- | --- | --- |
| Temp directory / sandbox archive failure | Under the frozen policy, the real sandbox exposes an empty read-only `TMPDIR/.git`; `git -C TMPDIR rev-parse` says it is not a repository. The unchanged archive test fails. Giving only `TMPDIR/.git` explicit write access removes the placeholder and the same test passes. Each of five full replay suites loses exactly this failure. | **Confirmed HARNESS portability fault.** Corrected only that path. The historical product's `.git`-existence heuristic and dataset stay unchanged. This is not a reason to remove the archive guard. |
| Protected-path Node requests | Raw pr16-r1 agent JSONL events **171 and 383** contain the two denied requests. Replaying both exact command strings through `handleHook` and the real trusted product hook produces the same "node names Claude Code's settings or plugins" denial. A separate real sandbox probe executes Node v24.22.2 successfully. | **Valid product guard / legitimate human boundary**, not Node installation failure. One request actually creates scratch settings; the other calls verdict functions with protected settings names. The guard conservatively refuses interpreter commands it cannot certify. No denied command was executed, and no bypass was used. Whether human-run live/subagent verification would satisfy the issue remains unobserved. |
| Claude-home assumption | On unchanged pr35-r0, `mv notes.md ~/.claude/` in the guard test is refused with an absent `.claude` directory. Creating only an empty directory makes the same test pass; removing it restores the original environment. No personal config is copied. | **Historical test/environment assumption.** An existing directory means moving an ordinary file into it; an absent directory can rename a file onto the configuration directory. Codex does not promise a Claude home. Do not relax this legitimate settings guard or manufacture personal configuration. A supported-home convention would be a separately reviewed protocol decision. |
| Protected read records | Original pr35-r0 read/context tests fail in the real sandbox. The record-store tamper-denial test passes. With only a fresh test-owned `TMPDIR` subdirectory, the same three unchanged tests pass 3/3 while the real `TMPDIR/trace-reads` remains unreadable. | **Valid sandbox denial plus historical test isolation assumption.** In-command test hooks cannot write the actual protected review store. Trusted review hooks are outside this sandbox. Do not grant model commands write access to it or fabricate read credit. Tests needing their own store must isolate it; this audit does not modify historical tests or candidate instructions. |
| Uppercase GitHub command | The current full suite and old replay suites expect `GH pr create` to be treated like `gh`. On this Linux host the parser returns null for uppercase `GH`; it is a distinct executable name. The shell probe finds no usable uppercase executable. Lowercase trace tests retain their ordinary enforcement. | **Pre-existing PRODUCT test portability expectation**, not a confirmed harness fault. Do not change shell parsing or the dataset to satisfy a platform-inappropriate assertion. Actual uppercase aliases/executables and case-insensitive platforms were not exhaustively tested. |
| Installed/vendored Claude declarations | Ordinary full suites before and after fail the explicit comparison of vendored **2.1.312** against installed **2.1.317**. Generated declarations are absent. | **Pre-existing developer-tool version mismatch**, an intentional compatibility check. No vendoring/product fix belongs in this harness audit. Isolated replay skips are disclosed separately. |
| Historical module-load deadline | Some older snapshots have a 20-second deadline established at import; original issue #32 explicitly describes it. Candidate convergence traces show an additional deadline failure and later changes to test fixtures. This audit's valid clean/convergence host runs did not reproduce that intermittent failure. | **Historical PRODUCT behavior / timing uncertainty**, retained in the dataset. A green isolated run does not establish absence, and this is not patched out of the screen. No claim that every saved candidate test change is a valid fix is made. |
| Missing `rg` in command PATH | The original pr16-r1 trace reports `rg: command not found`; the isolated probe also finds no `rg`. This host's binary lives under the deliberately hidden personal installation. | **Provisioning/tool-availability limitation**, not the cause of the reproduced archive-verdict assertion or Node denial. Existing tool prerequisites do not promise ripgrep. Do not expose the personal installation; a future explicit tool-runtime requirement would need its own narrow review and fingerprint. |

[Probe records](codex-readiness-45/checks/probes/probes.json) contain commands,
exit statuses and hashes; adjacent logs retain assertions. The protected-records
probe fails two read/context tests while its denial test passes; the separate-store
probe passes all three. Empty-home absent/present probes fail/pass respectively.
These are diagnostics, not a changed default runtime or a relabeled review.

The three human stops are independently attributable in the immutable traces:
pr16-r1 final message **152** and standards message **107** name the Node denial
and outstanding live verification; pr35-r0 messages **188/224** retain the
five-pass requirement, with first failing run **101** and runs 2–5 exiting 1 in
**103**; clean-pr33 final **262** explicitly retains the passing-suite criterion
despite saying "ready for human review." All three remain `asked_human=1`.
The corrected archive test does not decide any of these human questions.

## Correction and validation

The new real-sandbox regression exercises the **public archive guard interface**
against a scratch child repository. It fails before the change because the guard
returns null and passes afterward with its archive denial. See
[red](codex-readiness-45/checks/temp-git-red.log) and
[green](codex-readiness-45/checks/temp-git-green.log).
`codexConfig` now explicitly allows Git metadata at the already writable scratch
root. Replay reviewer permissions, hook/auth/control paths, source checkout,
other cases and `trace-reads` denials remain enforced. The full-layout sandbox
test now also proves that the read-record sentinel cannot be read or overwritten.

- Frozen covering eval baseline: **47 pass, 0 fail, 0 skip**.
- Corrected covering eval suite with actual no-model CLI sandbox probes:
  **48 pass, 0 fail, 0 skip**. Protected sentinel, `/proc` alias denial,
  reviewer-write denial, fixer writes, tool-free judge rejection, model identity
  checks, failure retention and approval gates still pass.
- Ordinary `npm test`: before **168 pass / 2 fail / 3 skip** (173 total);
  after **168 pass / 2 fail / 4 skip** (174 total). The added opt-in sandbox test
  accounts for the extra broad-suite skip and was exercised in the covering run.
  The same uppercase-GH and declaration-version failures remain.
- `npm run typecheck`: **55 diagnostics**, before/after output byte-identical.
  No unrelated product correction or packaging test was added.
- Five unmodified snapshot manifests are unchanged in both valid runs.
  Original pilot evidence hashes remain unchanged. `git diff --check` passes.

To reproduce without models (use new output paths each time):

```bash
npm ci --ignore-scripts
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs
node docs/research/codex-readiness-45/replay-check.mjs /tmp/readiness-old --historical-policy
node docs/research/codex-readiness-45/replay-check.mjs /tmp/readiness-new --sandbox-only
node docs/research/codex-readiness-45/probes.mjs /tmp/readiness-new/pr35-r0 /tmp/readiness-probes /home/ubuntu/cc-agents-artifacts/issue-44/pilot/review-codex-sol-astra/baseline
node docs/research/codex-readiness-45/pilot-record.mjs /home/ubuntu/cc-agents-artifacts/issue-44/pilot /tmp/readiness-pilot.json
npm test
npm run typecheck
```

The historical-policy switch recreates only the prior generated filesystem rule
set for an offline sandbox measurement; it cannot approve or launch a model.
`probes.mjs` changes only fixture-home/temp diagnostic state, so run it after
recording unmodified checks. Do not run the live `selftest` or runner to reproduce
this audit. All committed evidence files are covered by
[SHA256SUMS](codex-readiness-45/SHA256SUMS); the private artifact bundle and final
ticket handoff record additional local retention pointers and hashes.
