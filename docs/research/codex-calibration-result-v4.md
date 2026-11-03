# Astra calibration v4 actual result (#46): PASS

**Limited calibration PASS; adoption INCONCLUSIVE.** All 75 scheduled attempts
completed on 2026-11-03 with 75 valid grades and no failures. All 138 expected
judge invocations succeeded and are retained. Every specified expectation was
met, with zero material repeat or presentation disagreements and all four probes
passing three repeats. No attempt was retried, replaced, relabelled, pooled or
excluded. This certifies only the preregistered pilot-derived calibration; it
establishes neither code-review gains nor candidate adoption. Cross-version
differences do not identify the cause of changed behavior.

The next gate is a separately frozen and approved baseline protocol. #46 remains
open for the parent's review/merge and issue handling. No baseline/candidate
experiment ran, and this execution did not change #48/#49 or any PR.
The [original v3 result](codex-calibration-result-v3.md) remains **BLOCK** and
immutable; its rows are not pooled into v4.

## Bound execution and approval

The supplied worktree started exactly at
`0d40c6abba37cb719c9625a2cc2c424d1e41c097`, the tip of parent integration branch
`43-codex-calibration-v3-followthrough`. `git merge-base --is-ancestor` confirmed
the required ancestry before execution. The unchanged
[protocol](../../evals/review/calibration/protocol-v4.json),
[preregistration](codex-hillclimb-46/preregistration-v4.json), private bundle and
[documented CLI](../../evals/review/calibration/README.md) were used with explicit
`--version v4`. The preparation manifest and README retain their historical
zero-call/unapproved statements as frozen bytes; this report records the later
approved actual execution.

The existing `approval-v4-full-send-20261103.json` records the user's
`$full-send check on this PR.` message `221cd284-c152-44cf-98f6-aecf3f2477b1` at
**2026-11-03T23:29:56.540Z**, after presentation of the concrete v4 packet.
The invoked full-send skill explicitly
authorizes necessary direct testing without another ask-first test gate. Combined
with the correction-and-recalibrate request, the existing record binds that
grant to this exact snapshot only. Its SHA256 is
`45c3096abef5564509a2a818c53ad773c76f7cfb92463098d7341f5be9108a72`.
No new approval was requested or invented. Its scope is one whole calibration:
75 fresh grades / 138 expected Astra High/Fast requests, subscription auth,
concurrency one and configured-only identity. Changed hashes, baseline/candidate
experiments, competitor/holdout/Claude calls, reset redemption and schedule
changes remain outside that record.

Before authentication, the actual plan matched all four approved identities,
complete runtime/private membership and binary prerequisites. The post-run plan
is byte-identical:

| Identity | SHA256 |
| --- | --- |
| Runtime | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protocol | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| Preregistration | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |
| Protected harness | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |

The runner created the fresh mode-700 output outside git at
`/home/ubuntu/cc-agents-artifacts/issue-46/run-v4-full-send-20261103`.
`CODEX_EVAL_HOME=/home/ubuntu/.config/trace-eval/codex` selected the already
provisioned eval-only subscription login. The operator did not inspect or print
credential contents. Model-run and auth locks covered the sequential execution.
The run started at **23:35:57.176Z**; its sealed index was written at
**23:48:57.255Z**. No protected runtime, test, rubric, label, context or schedule
bytes changed. No other model experiment, fallback or later experiment ran.

## Counts and preregistered materiality

| Measurement | Actual result |
| --- | --- |
| Scheduled / completed grade attempts | 75 / 75 |
| Valid / failed grades | 75 / 0 |
| Expected / retained judge invocations | 138 / 138 |
| Successful / failed judge calls | 138 / 0 |
| Trusted `PostModelRequest` hook records | 138 |
| Trusted `PreToolUse` hook records | 0 |
| Expected-label mismatches among valid grades | 0 / 75 |
| Within-presentation repeat disagreements | 0 / 75 evaluable pairs (75 scheduled) |
| Between-presentation disagreements | 0 / 189 evaluable pairs (189 scheduled) |
| Report blockers | 0 |

Each of the seven primary/control units has nine valid grades: three repeats of
each original, layout and wording presentation. The unchanged report applies
zero tolerance to finding categories, known-bug matches, harmful/wrong status,
final-head fixed/reintroduced status, rounds and derived metrics. All specified
expected fields match; all repeat and presentation signatures match. Pair counts
are dependent descriptive comparisons, not independent statistical trials.
Prose, ordering and location-format differences remain nonmaterial. There were
no post-result exclusions, adjudications, majority votes or rubric corrections.
The existing rejection rules were used unchanged; no rejected or substituted
response was accepted as a grade.

| Probe | Valid attempts meeting preregistered expectations |
| --- | --- |
| Oracle | 3 / 3 |
| Null | 3 / 3 |
| Uncertainty | 3 / 3 |
| Wrong target | 3 / 3 |

Requested identity was **GPT-6 Astra, High/Fast**, using subscription auth and
configured-only verification. Served model, observed service tier and
API-equivalent spend remain **unknown/null**. All 138 retained invocations are
represented in the scored-row identity count, with zero response-backed model
identifications. The 138 `PostModelRequest` records are a separate diagnostic
hook count; neither that count nor active-model hook fields establish billed
requests or actually served identity/tier.

## Verification and restricted retention

The unchanged `report --version v4` CLI verified the sealed inventory, recomputed
the report from all 75 scheduled outcomes and matched its retained result.
Both run and report exited **0 / PASS**, with empty stderr. Independent
exact-membership, size and SHA256 checks verified all **76 indexes** (75 attempts
plus the run), including all **1,196 run-index members**. Every request, schema,
raw event, trusted hook ledger, final output, stderr and outcome remains retained.
All **1,243 original v3 artifact-index entries** still match their original sizes
and hashes. No historical evidence or result was changed.

The fresh [maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-03ef0052e20cacf1fd82)
retains the actual run, separate operator logs/scripts, the unchanged 32-member
private v4 bundle and the existing full-send proof logs. Release **433343915**,
asset **707530946**, remains unpublished and must **never be published
automatically**. Preserve the earlier preparation and v3 actual-result releases.

- Archive: `astra-calibration-results-v4-full-send-20261103.tar.gz`, **3,338,928 bytes**.
- SHA256: `4845c5602c0e7074aa73aac991160abb1dc738ad617e8f44e2f879b7bed92723`.
- A fresh download matched that hash and the exact directory/file inventory:
  **1,252 file members**, including the 1,251-file `SHA256SUMS` inventory.
- Credential-pattern scans found zero matches in all 1,252 downloaded file
  members. Credential locations were excluded; no auth, personal configuration,
  environment dump, symlink or hard link is archived.
- The downloaded private bundle and run independently recompute to **PASS / exit 0**
  after restoring extracted directory mode 700.
- The public [hash-only artifact index](codex-hillclimb-46/results-v4-artifact-index.json)
  contains retrieval metadata, public identities, paths, sizes and hashes; raw
  inputs, answer keys, labels and responses remain restricted.

Retrieve with maintainer access into a fresh mode-700 directory outside git:

```bash
gh release download cc-agents-46-calibration-results-v4-full-send-20261103 --repo lolisaigao1234/cc-agents --pattern astra-calibration-results-v4-full-send-20261103.tar.gz --dir /absolute/fresh-private-download
```

Verify the archive hash before extraction, then every member against the public
index and `run-v4-full-send-20261103-SHA256SUMS`. Restore directory mode 700.
Reproduce using the frozen v4 CLI at the bound execution commit:

```bash
node evals/review/calibration/calibrate.mjs report --version v4 --private /absolute/private-extraction/preregistration-v4 --output /absolute/private-extraction/run-v4-full-send-20261103
```

Expected exit: **0 / PASS**. Original operator logs are in
`/home/ubuntu/cc-agents-artifacts/issue-46/evidence-v4-full-send-20261103`;
fresh retrieval verification is in the sibling `download-v4-full-send-20261103`.
The retained existing proof logs show **83 covering passes, zero failures/skips**;
the full suite has **194 passes, two known failures, five skips**, with **55
unchanged typecheck diagnostics**. No broad tests were rerun or new tests added
for this operational execution; actual plan/run/report and retention verification
provide its direct proof. No claim is made that the broad suite/typecheck is green.

## Next gate

Calibration v4 satisfies this preregistered pilot-derived gate only. The parent
owns PR #51 review/merge, frontier and issue comments. A future baseline protocol
must be frozen and receive its own exact approval before any baseline call;
candidate/paired work needs its corresponding separate gate. This pass does not
authorize those runs or close any issue. Adoption remains **INCONCLUSIVE**.
