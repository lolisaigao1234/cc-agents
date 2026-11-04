# #48 v3 baseline-screen actual result: material capacity stop

**7 scored keys, 1 failed key, 25 unstarted. Baseline incomplete; adoption
INCONCLUSIVE.** `pr18-r0/rep1` completed its three-round app, then the native local
grader guard rejected its findings request: **2,133,624 Unicode characters exceeds
1,048,576**. The complete request is 2,136,638 UTF-8 bytes, SHA256
`7a12bf94803ce1e091f304b6baaa7399bdd7f720a1e73fa39d514f98c79f5eb8`.
The retained failure explicitly records `provider_call_attempted=false`: no judge
CLI was launched for that key, and no grade exists. No truncation, summary model,
ceiling change, manual retry, regrade, replacement or exclusion occurred.

The approved rendering correction preserved every substantive record and removed
only the two declared audit diagnostics. This new, longer real three-round app
still exceeds native capacity. Offline fits of the four historical screened
requests never guaranteed future capacity. Source, cases, split, ordering, prompts,
metrics, gates and all frozen normative bytes remain unchanged.

## Calibration and exact execution authority

Fresh [calibration v5](codex-calibration-result-v5.md) actually PASSed: 75/75 valid
grades, 138/138 completed Astra CLI calls, zero blockers and zero disagreements
across 75 repeat and 189 presentation pairs. Final offline recomputation still
PASSes; historical v4 PASS and v2 INCONCLUSIVE remain historical and unpooled.

The real response at 2026-11-04T21:12:44.374Z approved the immutable
[packet at 65f7491](codex-hillclimb-48/approval.md) in separate calibration-only
and conditional baseline-screen-only scopes. Calibration record SHA256:
`4913dc3be0df96f809175945182108812fd92ece0fa5176b41f9299007bd2a81`;
baseline record SHA256:
`71cf164ac1ad9bbbc2955252595dd8f8c9f6bbf6f7b4404d0f239a1dedcdd4cb`.
Their exact provenance and response remain restricted, including byte-identical
copies in the actual archive. No grant or approved state was manufactured.

The actual v3 gate passed matching sealed v5 PASS before the fresh 0700 screen
flow and exact 0600 null-harness template were installed. The first planned
`pr16-r1/rep0` command used the freshly delegated `--approve-harness` once; native
execution computed/wrote
`540bed650dbdb39fa71331cef884c692604e181f768f42fdb1194e7decb8a3c8`.
That key and flag were never repeated. The other seven commands omitted the flag.
Each used the frozen plan argv/environment, High/Fast subscription authentication,
configured-only identity and global concurrency one. The external global model
lock covered every invocation; the native auth lock was observed and released.

Supervision was interrupted after `pr17-r0/rep0` finished at 22:01:29.489Z. Its
native completion receipt already recorded exit 0, both lock observations and
complete app/judge attempts. On resumption, process and lock checks, all four
started-key inventories and the fourth row's calls/stops/tests/post-row artifacts
were reconciled. No model was still running and `pr17-r0/rep1` was provably
unstarted. Execution resumed that next key under the original approval. The
interruption and receipt remain retained; no uncertain or failed attempt was
silently replaced. Calibration evidence was committed in `d2fbcb9`, and an
immutable [six-key checkpoint](codex-hillclimb-48-results-v3/checkpoint-6-artifact-index.json)
in `a57a04f` preceded the later material stop.

## Counts, timing and gaps

Eight native invocations produced eight successful app attempts, seven successful
judge attempts and one retained local judge failure. All **16 attempt indexes**
verify exact membership/bytes. There were **44 actual model CLI calls: 34 Sol,
10 Astra; all 44 completed**. Native and manual retries: zero. Together with
calibration, this execution used 182 completed model CLI calls (34 Sol / 148
Astra); this is not a count of billed/provider-internal requests. Quality evidence
is never pooled across calibration, pilot or historical baselines.

| Key | UTC start | UTC finish | Whole wall seconds | Exit |
| --- | --- | --- | --- | --- |
| pr16-r1/rep0 | 2026-11-04T21:30:57.481Z | 2026-11-04T21:36:40.954Z | 343.473 | 0 |
| pr16-r1/rep1 | 2026-11-04T21:37:09.320Z | 2026-11-04T21:45:05.274Z | 475.954 | 0 |
| pr16-r1/rep2 | 2026-11-04T21:45:26.316Z | 2026-11-04T21:52:36.901Z | 430.586 | 0 |
| pr17-r0/rep0 | 2026-11-04T21:52:55.736Z | 2026-11-04T22:01:29.489Z | 513.753 | 0 |
| pr17-r0/rep1 | 2026-11-04T22:15:42.988Z | 2026-11-04T22:28:38.144Z | 775.156 | 0 |
| pr17-r0/rep2 | 2026-11-04T22:28:57.339Z | 2026-11-04T22:46:38.381Z | 1061.042 | 0 |
| pr18-r0/rep0 | 2026-11-04T22:47:10.451Z | 2026-11-04T23:03:18.104Z | 967.653 | 0 |
| pr18-r0/rep1 | 2026-11-04T23:03:35.674Z | 2026-11-04T23:32:52.773Z | 1757.099 | 1 |


`latency_s` in the [normalized scored rows](codex-hillclimb-48-results-v3/normalized-rows.json)
measures the final app attempt only. The table above separately retains whole
invocation wall time, including setup, grading, retention and cleanup. The frozen
5,400-second case / 4,500-second agent / at-most-900-second judge limits and
three-round cap were unchanged; cleanup was allowed to drain.

| Case | Scored | Failed | Unstarted |
| --- | --- | --- | --- |
| pr16-r1 | 3 | 0 | 0 |
| pr17-r0 | 3 | 0 | 0 |
| pr18-r0 | 1 | 1 | 1 |
| Each of pr24, pr35-r0, clean-pr12, clean-pr19, clean-pr33, conv-pr18, conv-pr19, conv-pr33 | 0 | 0 | 3 |

All 25 remaining attempt paths are absent and their exact keys are in the
[summary](codex-hillclimb-48-results-v3/summary.json). `pr18-r0/rep2` would rerun
the failed lower repetition under native prefix semantics and must not be invoked.
The other 24 keys remain unstarted after the global material stop. No v13,
holdout, Claude, reset or schedule action occurred.

## Metrics, human stops and raw evidence

The frozen actual report exits 2 with **INCONCLUSIVE**:
`baseline.complete=false`, 7/33 received and structurally valid keys, primary
recall coverage 7/15, clean coverage 0/9 and convergence coverage 0/9. Noise N,
validated primary aggregate, all validated variability/uncertainty summaries and
stage metric means remain **null**. The approval/calibration gate still exits 0;
it does not authorize a failed-key retry or establish baseline completeness.
The report's two failure-evidence records (sidecar and attempt failure) refer to
the same one failed key, not two failures or extra CLI calls.

The following are raw scored-key observations, not validated stage aggregates:

| Key | Recall | Fixed | Reintroduced | Harm | Noise | Precision | Rounds | Human |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pr16-r1/rep0 | 0.125 | 0 | null | 2 | 0 | 0.5 | 1 | 1 |
| pr16-r1/rep1 | 0.125 | 0 | null | 1 | 0 | 0.833333 | 1 | 1 |
| pr16-r1/rep2 | 0.125 | 0 | null | 2 | 0 | 0.6 | 1 | 1 |
| pr17-r0/rep0 | 0.2 | 0 | null | 1 | 0 | 0.9 | 1 | 1 |
| pr17-r0/rep1 | 0.2 | 0.2 | null | 0 | 0 | 1 | 1 | 1 |
| pr17-r0/rep2 | 0.3 | 0.25 | null | 0 | 0 | 1 | 1 | 1 |
| pr18-r0/rep0 | 0.166667 | 0.083333 | null | 0 | 0 | 1 | 1 | 1 |


All seven scored keys retain their human stop in the raw workflow,
Update and judge output. Protected-access and unresolved live/runtime-verification
requirements remain visible. Original outputs, rejected/unresolved dispositions,
trusted hooks and raw metadata survive in full; the grader-only projection is
independently equal apart from exactly `active_model` and `token_usage` on audit
records. The first six stop summaries were additionally checked using only output
string values, avoiding matches on JSON field names. No findings or stop evidence
were tuned, erased or treated as waived. Parent independent semantic adoption
review remains required; numerical reporting alone is insufficient.

The failed eighth app separately retains **10 completed Sol calls, 1,073 audit
records, all 12 original review findings, all three review rounds and fix outputs,
the explicit three-round stop and Update's `asked_human=true`**. Its complete
projected workflow and every original output remain in the failed grader request.
Its successful app is ungraded and supplies no recall/fix credit.

Scored host tests have 7/33 known before and after observations: before, six true
and one false; after, seven true. The failed app separately has false/true host
booleans and is excluded from scored coverage. The frozen `testsPass` retains
booleans, not host stdout/stderr; missing host logs were not reconstructed or
rerun. Agent tool/test outputs and dispositions remain in raw events and audits.
All #45/new-case readiness limits remain, including protected Node/settings,
missing rg, read-record denial, live/subagent checks, uppercase GH, vendored
declaration and empty-Claude-home/timing limitations. Host booleans do not settle
live readiness. No guard, fixture or product patch was made by this operator.

## Identity, usage and frozen inputs

Requested Sol/Astra High/Fast and subscription-only settings stayed unchanged.
All 44 baseline calls have usage; **zero** have response-backed model or tier
identification. Served identity/tier and API-equivalent spend remain **null**.

| Actual baseline evidence | Sol | Astra |
| --- | --- | --- |
| CLI calls / completed calls | 34 | 10 |
| Calls with known usage | 34 | 10 |
| Known input tokens, including cached input | 25940473 | 1686448 |
| Known output tokens | 267113 | 12092 |
| Trusted PostModelRequest records | 518 | 10 |


Known baseline input/output subtotals are 27,626,921 / 279,205. Hook records are
not added to CLI calls or authoritative usage. Cached input is included in input;
provider-internal retries/billing remain unobserved. The rejected local request
has no judge CLI or provider attempt, not a fabricated zero-cost grade. The
legacy `--budget-usd 40` did not price or cap Codex spend.

The actual environment used Node v24.22.2 and Codex 0.166.0, with these frozen overrides:

| Variable | Value |
| --- | --- |
| CODEX_EVAL_HOME | `/home/ubuntu/.config/trace-eval/codex` |
| TMPDIR | `/tmp` |
| CODEX_BIN | `/home/ubuntu/.codex/packages/standalone/releases/0.166.0-aarch64-unknown-linux-musl/bin/codex` |
| PATH | `/usr/local/bin:/usr/bin:/bin` |
| LANG | `C.UTF-8` |
| TZ | `UTC` |
| CC_AGENTS_MATT_PLUGIN_DIR | `/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-matt-pins/e59429136a417ca8c6ecd971d0f46e946a3e96d4d255e650c210ff15e6e61419/plugin` |

Final actual v3 plan stdout and stored plan SHA256:
`377b6d6c467a0037347251b8d9ac65867980a36fe79bde49552a4caf0b18f183`.
Final v5 plan stdout:
`40810e512e71e83d30c2408a2dec1049b1a108598fd47db7241014f56f8832bd`.
The manifest `10a04f6ba925a0acfa9c785e6010c369e8831a19421227494a6d2f9cfb57e36d`
and protocol `78cf3b2bb52462fbfb0acb74abf9d68a73776b814c4fe21977b4110cd60fef19`
remain exact. Runtime/protected/private inventories, Node/Codex/system/npm files,
257 installed dependency members, 33 dependency-directory modes and the exact
176-member Matt pin verify. No operator mutation of installed Matt/cache/settings/lease
or pin was performed. The historical mutable-cache gate remains historical/red, not waived.

No new broad suite was run for report-only changes. Parent preparation evidence
remains 89 covering / 15 protocol passes, zero Sol-loop behavior findings, with
two historical broad-suite failures and 55 unchanged TypeScript diagnostics.
No fresh CI result is invented.

## Restricted retention and handoff

A new [unpublished maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-edc85c914dd78aafa592) retains complete actual
calibration, screen flow and operator evidence. **Never publish automatically.**
All prior releases and historical evidence remain unchanged.

- Tag: `cc-agents-48-correction-v3-actual-20261104-233516`.
- Asset: `correction-v3-actual-20261104-233516.tar.gz`, 34,132,673 bytes.
- Archive SHA256: `bb8a209a6fdd9290b65cb8f1126c2376287d6856b2f71e197faa2c1c86cb9fad`.
- Fresh download: **1,720 files and 397 directories**,
  exact members/sizes/hashes/kinds/modes; directories 0700, files 0600, no links.
- Credential-pattern scans of originals and downloaded members: zero matches.
- The pin and original calibration-input bundle are not copied into this actual
  archive; their unchanged restricted preparation assets remain bound in
  [retention-v5.json](codex-hillclimb-46/retention-v5.json).

The [actual hash-only artifact index](codex-hillclimb-48-results-v3/actual-artifact-index.json)
contains every member and retrieval metadata. Restricted originals remain at
`/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-calibration-v5-run`,
`/home/ubuntu/cc-agents-artifacts/issue-48/experiment-v3/screen` and
`/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-execution-evidence`.
Archive/download receipts are at `/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-actual-retention`.
All native work roots are absent, no cleanup warning exists, no native model/run
process remains, both locks are free and all earlier sealed hashes reverify.
Remote replay deletion had no native warning; no separate remote deletion audit
is claimed. No unrelated file/repository was deleted.

The child included approved `65f7491`, fetched and merged latest parent integration
before handoff (already up to date); parent/PR head remains `65f7491`. No push,
PR/issue mutation, watch, closure or merge to an eval/default branch was performed.
Parent owns PR52 and reviews. This material capacity failure prevents a complete
comparable baseline. Frozen bytes must not be changed under the existing grant;
any correction needs its own version, review, relevant fresh calibration/baseline
and exact approval. There is no authorized retry, replacement or 25-key resume
under changed bytes. #48 remains incomplete; #49/candidate and paired holdout
remain separate later gates. Exposure, partial-v2, shared-source, low-power and
unknown-serving/spend limits persist. Adoption remains INCONCLUSIVE.
