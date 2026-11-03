# #46: Astra calibration preregistration and gated replay tooling

**Selection: BLOCK. No live calibration grades exist.** The new calibration
runtime/protocol requires real human approval. The historical #44 approval is
not approval for this driver or experiment. An unapproved execution exits 2,
before authentication, locking a subscription login or creating a run directory.
No approval flag was used, approval record written, model called, candidate
prompt inspected/tuned, held-out case used or Claude/reset/schedule action taken.

The concrete deliverable is a versioned, evidence-cited calibration set plus
replay, retention and comparison tooling. [Protocol](../../evals/review/calibration/protocol.json),
[driver and instructions](../../evals/review/calibration/README.md), and
[preregistration manifest](codex-hillclimb-46/preregistration.json) are reviewable
before any live results. Raw input/answer-key bytes and citations are kept in the
separate [restricted artifact bundle](codex-hillclimb-46/retention.json), outside
public git. Its 32 members include a reproducible builder and untouched copies
of the four selected saved pilot inputs. Running the builder into a fresh
private directory produced all 32 files byte for byte.

Seven focused units cover known matching, valid-other, wrong/harmful, noise,
fixed/unfixed and introduced/not-introduced decisions. Every unit has an original,
a layout presentation and an equivalent wording presentation, each repeated
three times. Four probes (oracle, null, uncertainty and wrong target) each have
three repeats. The frozen schedule is **75 grades, 138 expected judge requests**,
concurrency one. Controls explicitly change a finding's truth, fix an existing
bypass, or reintroduce an evidence-backed defect. All patches and findings are
derived from saved pilot code/issue material and scoped known-bug evidence.
Synthetic final heads are labelled as controls, never reported as historical
agent changes. No historical Astra verdict is treated as independent truth.

The unmodified `grade.mjs` rubric and Codex adapter request Astra High/Fast,
subscription authentication, configured-only verification, fresh sessions and
tool-free judging. Every request, rendered prompt/schema, raw response, final
output, stderr, hook ledger and failure is retained separately with hashes.
The driver adds rejection of explicit refusal envelopes, retains rejected
attempts and never substitutes a grade. Authentication files are excluded from
retention. The fixed model-run lock and existing eval-auth lock cover the entire
sequential execution. No fallback, automatic retry, reset redemption or candidate
run exists in this driver.

| Acceptance item | State and evidence |
| --- | --- |
| Versioned inputs and evidence-cited expected labels before live results | Prepared: private bundle with exact source hashes, JSON pointers and checked verbatim evidence fragments; public 32-file inventory. All seven requested categories/status classes covered. |
| Original + two equivalents, each graded three times; semantic controls | Preregistered 63 primary/control grades plus 12 probe grades. Live execution blocked; no completion claim. |
| Requests/raw responses/failures retained; compare categories, matches, fixes/regressions and metrics | Tooling implemented. Independent repeat/presentation pair counts; immutable per-attempt/run indexes; protocol mismatch cannot be pooled. No live measurements yet. |
| Oracle/null/uncertainty/wrong-target and tool/refusal/invalid-output rejection | Four probes frozen, awaiting live execution. Offline tool/refusal/schema/sandbox tests pass; live probe outcomes remain unknown. |
| Materiality and acceptance rules before interpreting results | Versioned zero-tolerance rules. Any unexplained structured change, wrong expected label, missing/rejected grade or unresolved ambiguity returns BLOCK; CLI exits 2 for blocked completed reports. |
| Rubric corrections versioned and recalibrated | No rubric correction. Future changes require a new version, fresh human approval and calibration; no differently graded/Fable rows pooled. |

Exclusions and limits are preregistered inside the restricted bundle. Originals
are focused derived inputs rather than unchanged full replay transcripts. Bug
context is limited to selected pilot records, without loading the global
trap/held-out collection. The wrong-target probe specifies zero recall without
inventing a category for an assertion the shown diff cannot confirm; repeat
category changes still block selection. The disputed marketplace-install flag
is excluded from expected finding labels. Final-head patch bytes remain
identical across equivalent presentations; this measures repeatability of those
fix prompts rather than robustness to rewriting patches. Explanatory prose,
location formatting and list order are nonmaterial. No post-result exclusions,
majority vote or automated adjudication are allowed. There are no live
ambiguities adjudicated or live comparisons to interpret.

Within each three-presentation unit, the report counts nine within-presentation
repeat pairs separately from 27 between-presentation pairs. Probe pairs add only
to repeat variation. These dependent pairs are descriptive, not independent
statistical trials. Expected labels independently catch unanimous errors. A
PASS would certify this pilot-derived calibration only; it would not establish
code-review gains, a repeated baseline or candidate adoption.

Frozen identity before integration merge:

- Original protected #44 harness: `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612` (115 files), unchanged.
- Complete new driver runtime manifest: `6c73240c1d9ad966354069d64bc6012f44b56d2c8b21166fdde2721a6fa45cc3` (133 public code/config/check files plus separately bound private inputs/builder and runtime binaries).
- Protocol SHA256: `e5e4ecee0b8ac3196e8bae57ff63378d359e854ef833dc17e3bf5ee7ea258350`.
- Preregistration SHA256: `beaddfc4d9563f3154dd86411bd517f162c6292888bd638e2db3a331155ee498`.
- Restricted archive SHA256: `21357f7b9d9a5941cc312b87b2c5e7fa1e3236a41b3d7fd048c5edc06e2f5df5`; 183,365 bytes, 32 files; credential-pattern scan found zero matches.

Human review must cover the public driver/protocol, all private input and
expected-label evidence, and these three runtime/protocol/preregistration hashes.
The explicit implementation contract says: “NEVER silently bypass human approval
for a changed runtime/rubric.” The #44 handoff also says its flow states are
historical approvals, not approval for later experiments. No human record covers
this new snapshot. Until one exists, live calibration, live probes and selection
remain blocked. Requested identity is Astra High/Fast; observed served model,
served tier and API-equivalent spend are unknown/null.

[Verification logs](codex-hillclimb-46/checks/summary.json): covering eval checks
**52 pass, zero failures/skips**, including actual pinned Codex CLI sandbox
subcommands without model calls; all five new comparison/gate/rejection tests
pass. Red-before-green logs retain the missing comparison interface and approval
gate failures. Typecheck retains **55 existing diagnostics**, byte-identical to
#44, with none in the new files. Historical verifier passes all 115 protected
file bytes and 39 retained artifact hashes. The preregistered input builder
reproduces byte for byte. `git diff --check` passes. Full-suite historical failures
are documented by #44; this scoped task did not rerun that unchanged suite.

Integration compatibility and the final immutable commit are recorded in the
implementation handoff. A later integration merge must not be used to run this
frozen snapshot under historical approval: changed protected bytes stop before
authentication. Keep the frozen commit and private artifact archive together.
