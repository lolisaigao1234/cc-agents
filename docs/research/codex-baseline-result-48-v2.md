# #48 v2 baseline-screen partial actual result: material stop

**3 scored keys, 1 failed key, 29 unstarted; baseline incomplete and adoption
INCONCLUSIVE.** The resumed run stopped after `pr17-r0/rep0` completed its app
but its native judge request was rejected: **1,068,777 characters exceeds the
1,048,576-character limit** (`input_too_large`, code `-32602`). The exact retained
prompt independently has 1,068,777 characters (1,070,189 UTF-8 bytes). No grade
exists for that key. Its successful app, requests, material, transcript and raw
calls remain retained, alongside the failed judge request/events/stderr/index.

Final offline verification also found a material environment membership change:
the bound Matt 1.3.2 cache acquired `.in_use/450239`, dated
**2026-11-04T20:09:22.902972Z**, during the fourth key. The expected 176-member
tree then had 177 members; existing member bytes were unchanged. Actual final
plan/gate/report commands reject that extra file. The operator did not create,
modify, delete or exempt it. No claim of an unchanged complete environment is made.

These are concrete execution blockers, beyond the repaired dependency prerequisite.
No request truncation, new ceiling, manual retry, replacement, regrading, exclusion,
guard relaxation or changed frozen code was used. The failed key cannot be retried
through a later repetition prefix. Continuing to spend on a complete comparable
baseline is unsupported under the frozen failure/environment rules.

## Historical preflight, recovery and authorization

The original blocked preflight remains immutable in commit
`51766e1a072102f674d42cb33da68a251bd9f3dd`, including the prior version of this
report and the unchanged [47-file preflight index](codex-hillclimb-48-results-v2/artifact-index.json).
Its [unpublished draft archive](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-a4fda5e28275889b97da)
and restricted originals were neither appended to nor resealed. It contains zero
model attempts and contributes no failed model key to this result.

The parent restored the previously absent `node_modules` from an independently
verified byte-identical 257-member tree with symlinks preserved. Recovery proof is
at `/home/ubuntu/cc-agents-artifacts/issue-48/dependency-recovery-20261104` and is
copied into the fresh resumed operator evidence. This was prerequisite restoration,
not a new snapshot or approval. The implementer then independently reran the actual
plan, exact-stage gate and v4 calibration plan: all exited 0. Actual plan stdout
again matched `9401adab8086fc74a939b2e7e894bb87902416e9335164e07526fe97f70eaedf`.
The same plan/gate and prior evidence were checked before each later invocation.

The existing real approval record, SHA256
`30d4af0b48049654c2095170fd53630a6772e89c93082296217d939fb0012a19`, faithfully
records **“Approve baseline and delegate native flag”** at
`2026-11-04T19:21:54.768Z`. No new approval or decision was invented or requested.
It covers only the exact 33-key baseline-screen packet and its first-key native
flag, with disclosed catalog exposure, postexposure selection, shared history,
unknown prior exposure, low power and conditional inference limitations.

The fresh mode-700 `experiment-v2/screen` flow received the exact mode-600
null-harness template, under umask 077. The first `pr16-r1/rep0` command appended
`--approve-harness` exactly once. The unchanged native runner computed/wrote
`85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` over 119
files and proceeded to score that key. It was not a preapproval probe or dry run;
that first key was not reinvoked. All three later native commands used the exact
plan argv without that flag. No approved state/digest was forged or copied.
Approval/native-write provenance and the actual flow state are retained.

The existing global `/tmp/cc-agents-43/model-run.lock` covered all four native
invocations, apps, judges and cleanup. Native eval-auth locking was respected.
Concurrency was one; both locks were released after execution/retention checks.
No candidate, holdout, Claude, reset or schedule action occurred. No original
catalog/bug registry, heldout answers or raw calibration outcomes were inspected
for tuning. No public source/helper/protocol/environment policy was changed.

Every invocation used the frozen values:
`CODEX_BIN=/home/ubuntu/.codex/packages/standalone/releases/0.166.0-aarch64-unknown-linux-musl/bin/codex`,
`CODEX_EVAL_HOME=/home/ubuntu/.config/trace-eval/codex`, `TMPDIR=/tmp`,
`PATH=/usr/local/bin:/usr/bin:/bin`, `LANG=C.UTF-8`, `TZ=UTC`.
Existing eval credentials were used only by the native runner; their values and
personal configuration were not read, printed or copied by the operator.

## Counts, gaps and timing

| Case | Scored / failed / unstarted | Raw recall rep0 / rep1 / rep2 | Retained case limit |
| --- | --- | --- | --- |
| pr16-r1 | 3 / 0 / 0 | .125 / .125 / .125 | All stop for human input; protected Node/settings probe and live verification unresolved |
| pr17-r0 | 0 / 1 / 2 | null / null / null | Rep0 app retained but ungraded; reps1/2 prefixes would retry failed rep0; live/subagent evidence unresolved |
| pr18-r0 | 0 / 0 / 3 | null / null / null | Metadata/object checks only; unstarted |
| pr24 | 0 / 0 / 3 | null / null / null | Pilot audit's declared baseline failures remain; unstarted |
| pr35-r0 | 0 / 0 / 3 | null / null / null | Pilot audit leaves five claimed passing suites unverified; unstarted |
| clean-pr12 | 0 / 0 / 3 | not applicable | Metadata/object checks only; unstarted |
| clean-pr19 | 0 / 0 / 3 | not applicable | Metadata/object checks only; unstarted |
| clean-pr33 | 0 / 0 / 3 | not applicable | Pilot audit's failing-suite/human conditions remain; unstarted |
| conv-pr18 | 0 / 0 / 3 | null / null / null | Metadata/object checks only; unstarted |
| conv-pr19 | 0 / 0 / 3 | null / null / null | Metadata/object checks only; unstarted |
| conv-pr33 | 0 / 0 / 3 | null / null / null | Pilot audit's third-round cap and contradictory test evidence remain; unstarted |

All unstarted repetition labels are explicit in the restricted stop disposition.
The 29 gaps are two unsafe higher reps of the failed case plus 27 later keys
unstarted after the material stop. No hard case was excluded after its outcome.

| Native key | UTC start–finish, 2026-11-04 | Whole invocation wall seconds | Exit |
| --- | --- | --- | --- |
| pr16-r1/0 | 19:35:37.718–19:41:18.021 | 340.304 | 0 |
| pr16-r1/1 | 19:43:02.587–19:48:40.071 | 337.484 | 0 |
| pr16-r1/2 | 19:49:43.485–19:54:49.424 | 305.939 | 0 |
| pr17-r0/0 | 19:55:42.800–20:13:14.286 | 1051.486 | 1 |

There were **4 runner invocations, 4 successful app attempts, 4 judge attempts,
3 scored rows and 1 failed judge attempt**. Native retries and manual retries:
zero. The final error sidecar and retained judge failure describe the same failed
attempt. The report's two failure-evidence records are not two failed keys/calls.
No timeout occurred. Whole invocation timing includes setup, scoring and cleanup;
it is separate from native `latency_s`, which measures the final app attempt only.

## Validity, raw metrics and human/test evidence

The existing read-only `nativeReport` interface verifies three received,
structurally valid scheduled rows out of 33, with `baseline.complete=false`.
The attempted unscored key and retained failure are explicit blockers. Final
experiment CLI report generation itself fails on the external-cache membership
change. The retained component report is labelled diagnostic-only and confers
no execution clearance or environment/comparability certification.

The paired gate is **INCONCLUSIVE**. Missing candidates alone are expected after
an otherwise valid baseline; here the baseline is independently incomplete and
invalid for readiness. Under the frozen contract, validated primary PR-weighted
recall, N, all case min/max/ranges, PR per-rep means, macro per-rep recalls and
macro min/max/range are **null**. Primary valid/scheduled rows are **3/15**.
There is no validated noise floor, threshold, descriptive uncertainty estimate,
population confidence coverage, candidate gain or promotion claim.

The following are retained raw `pr16-r1` row values, not validated stage aggregates:

| Metric | rep0 | rep1 | rep2 |
| --- | --- | --- | --- |
| Recall | .125 | .125 | .125 |
| Final-head fixed fraction | 0 | 0 | 0 |
| Reintroduced fraction | null | null | null |
| Harmful/wrong findings | 2 | 1 | 2 |
| Finding noise | 0 | 0 | 0 |
| Precision | .5 | .8 | .3333333333333333 |
| Review rounds | 1 | 1 | 1 |
| First clean round | null | null | null |
| Asked human | 1 | 1 | 1 |
| Hook denials | 2 | 2 | 3 |
| Host tests before / after | true / true | true / true | true / true |
| Final-app latency seconds | 312.650 | 302.641 | 287.766 |
| App input tokens, including cached input | 893480 | 907825 | 941008 |
| App output tokens | 12746 | 12193 | 11372 |

Fixed/harm/noise/precision/round/human/hook/latency/token observations have
known-row coverage **3/33**; reintroduced fraction and first clean round have
**0/33**. Primary recall coverage is **3/15**, convergence recall **0/9**;
clean recall is not applicable. Every validated stage metric mean remains null.
No clean-case harm observation exists, so zero observed clean harm is not claimed.
The failed app's claimed fixes are not grades and supply no recall/fix credit.

Host-test coverage in scored rows is **3/33** before and **3/33** after, each with
three observed true and zero observed false. The fourth, ungraded app separately
retains true/true host booleans; it is not counted as a graded row. The frozen
`testsPass` discards host npm stdout/stderr and retains booleans only. Those missing
host logs were not reconstructed or rerun. Candidate tool/test outputs and
model-reported test dispositions remain in raw events/material. Passing booleans
and candidate claims do not establish the unresolved live readiness requirements.

Manual review matched all original findings against retained issue comments and
Update outputs. In pr16, repeated findings were explicitly consolidated with
attribution (five review entries to four, five to five, five to three matters).
Protected Node/settings hook denials and unresolved live/plugin checks support
the legitimate stops; Update preserved them. In pr17 the app retained all ten bug
and nine standards/spec findings/dispositions, including the unresolved actual
main-session/subagent verification. Fix and Update both request human input.
The app's reported 53 passing tests and direct-hook smoke checks are explicitly
distinguished from actual live dispatch/subagent evidence. No rejected finding,
human decision or verification gap was silently dropped or treated as waived.
Missing rg, protected read records, uppercase GH, vendored-declaration differences,
empty-Claude-home assumptions and historical timing limits remain disclosed.

## Requested identity and known usage

Requested Sol High/Fast and Astra High/Fast, subscription-only, configured-only
identity, concurrency one remained unchanged. **Observed served model, observed
tier and API-equivalent spend remain unknown/null.** All 17 retained CLI calls
have zero response-backed model identifications. No observed substitution is
recorded; configured settings do not prove served identity/tier.

| Separate count | App / Sol | Judge / Astra |
| --- | --- | --- |
| CLI invocations | 13 | 4 |
| Completed CLI turns | 13 | 3 |
| Calls with usage | 13 / 13 | 3 / 4 |
| Trusted PostModelRequest hook records | 166 | 3 |
| Known input-token subtotal, including cached input | 7648069 | 434655 |
| Known output-token subtotal | 83515 | 2454 |

The 169 diagnostic hook records are not added to the 17 CLI invocations and do
not establish billed requests. The failed Astra CLI retained only `thread.started`,
its rejected request and stderr, with no final output or trusted model-request
hook. Its usage is **unknown, not zero**. Thus whole-judge/whole-run usage totals
are null; the judge numbers above cover only three calls. Native normalization
reports missing cache-write breakdown; cached input is a subset of input and
reasoning is a subset of output. No billed-total or complete pricing claim is made.
The legacy `--budget-usd 40` argument did not price or cap Codex spend.

## Frozen identities and restricted retention

The 14 normative inputs, 150-member runtime, 119-member protected harness and
32 private v4 members still verify. The v4 offline plan still exits 0; existing
actual calibration PASS is unchanged and was not rerun or pooled. Repository
source/runtime/helper/protocol/manifest/config bytes and membership are unchanged.
The restored node_modules still has 257 matching members and npm 1794; the extra
Matt cache marker is the observed external environment violation, not a source edit.

| Identity | SHA256 |
| --- | --- |
| Manifest | `86feea45091c2a86e2d1ac545b7b4abb48202548e74a3ae80182844188f5ca22` |
| Protocol | `8dc56d50a31612f72f6d80ffb1237030869c72a79ad1332404523cfb788c3090` |
| Initial and every pre-key actual plan stdout; stored plan unchanged | `9401adab8086fc74a939b2e7e894bb87902416e9335164e07526fe97f70eaedf` |
| Runtime | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protected harness / native digest | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |
| V4 preregistration | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |

All eight app/judge attempt indexes independently verify exact membership/hashes,
single-link files and restricted permissions. Successful rows additionally match
retained app/judge results, traces, judge inputs and raw-event sidecars. Frozen
references and prior successful-key hashes were rechecked before later keys.
The failed judge request/error/index and successful app originals are intact.
Native cleanup reported no warnings; all four scoped local work roots are absent.
Remote replay deletion was performed only by native cleanup, with no reported
failure; no separate remote cleanup audit is claimed. No unrelated repository or
personal file was deleted. No additional operator repository tests or broad
verification suites were run, and no tests were added to this worktree. Native
case/app test actions remain part of the scored or ungraded evidence. Historical
14 protocol / 83 covering passes are not presented as fresh tests.

The fresh [unpublished maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-d2cd78ec51be6fe7c2e1)
retains the complete screen flow and fresh resumed operator evidence, including
raw screened answers, approval/native provenance, recovery proof, exact argv,
allowed environment, timestamps/exits, failed requests, errors and all attempts.
**Never publish automatically.** No calibration bundle, credential/config file,
external cache marker contents or unrelated personal/replay files were copied.

- Tag: `cc-agents-48-baseline-v2-partial-actual-20261104-201803`.
- Asset: `codex-baseline-v2-partial-actual-20261104.tar.gz`, ID **710794700**,
  **10,058,140 bytes**.
- SHA256: `5137e8525c63bf01eb93fcff22111293ef230ff842fb83dbf909e07bdec40d6f`.
- Fresh download verified **286 file members and 55 directory members**, exact
  membership/sizes/hashes; `SHA256SUMS` covers the other **285** file members.
- Credential-pattern scans of all allowlisted originals and downloaded members
  found zero matches; no symlink/hardlink members. Directories mode 700, files
  mode 600, umask 077.

The [actual hash-only index](codex-hillclimb-48-results-v2/actual-artifact-index.json)
contains retrieval metadata and every member path/size/hash. Restricted originals:
`/home/ubuntu/cc-agents-artifacts/issue-48/baseline-v2-resumed-20261104-evidence`
and `/home/ubuntu/cc-agents-artifacts/issue-48/experiment-v2/screen`.
Fresh download: sibling `baseline-v2-resumed-20261104-download`.
Post-seal release/download receipts remain in the operator evidence's `retention/`.
Public git contains only this sanitized report and a new hash index; the original
preflight index and bound experiment directory are unchanged.

Retrieve with maintainer access into a fresh mode-700 directory outside git:

```bash
gh release download cc-agents-48-baseline-v2-partial-actual-20261104-201803 --repo lolisaigao1234/cc-agents --pattern codex-baseline-v2-partial-actual-20261104.tar.gz --dir /absolute/fresh-private-download
```

Verify the archive SHA256 and every member before use. Keep raw answers restricted.

## Handoff and next prerequisite

The existing worktree started clean at `51766e1`, descended from approved parent
`b1dc97f18d46f2a54c2b1cf0a79f7a2143339f60`. Local and freshly fetched parent
integration tips were merged and ancestry checked before handoff; they remained
at b1dc97f. No push, PR/issue mutation, comment, watch or subagent was used.

The parent must resolve the frozen judge input-envelope defect and the mutable
external-cache prerequisite before any new comparable experiment. A changed
runtime/prompt/protocol requires a new version, relevant calibration/fresh baseline
and exact approval under the existing policy. This failed key is retained and
cannot be manually retried, replaced or regraded under v2. Merely clearing the
cache marker would not undo the failed attempt or validate this partial baseline.
No candidate-selection gate is satisfied; #48 remains incomplete and adoption is
INCONCLUSIVE. Parent owns PR52 and the next decision.
