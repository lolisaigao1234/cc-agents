# Astra calibration v3 actual result (#46): BLOCK

**BLOCK / INCONCLUSIVE.** All 75 scheduled attempts completed on 2026-11-03:
69 valid grades and six rejected grades. The six rejections were judge tool
attempts during changes grading, after successful findings calls. The frozen
driver retained them and continued the schedule. No attempt was retried,
replaced, relabelled or excluded. #46 remains open; #48/#49 remain blocked.
This result supports no candidate quality or adoption claim.

## Bound execution

The worktree started exactly at integration commit
`f18ce230c1650e1693836f26233b716f5129fe2d`, the tip of
`43-codex-calibration-v3-followthrough`, including merged PR #50. The published
[approval packet](codex-calibration-approval-v3.md),
[protocol](../../evals/review/calibration/protocol-v3.json),
[preregistration](codex-hillclimb-46/preregistration-v3.json) and
[existing CLI](../../evals/review/calibration/README.md) were used unchanged.

The existing human-approval transcription dated 2026-11-03T22:45:50.334Z
authorized this published calibration only. Its SHA256 is recorded in the
[hash-only artifact index](codex-hillclimb-46/results-v3-artifact-index.json).
No new approval was invented or requested. Both pre-run and post-run plans
verified the same identities, private inventory and binary prerequisites:

| Identity | SHA256 |
| --- | --- |
| Runtime | `169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4` |
| Protocol | `28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b` |
| Preregistration | `ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7` |
| Protected harness | `096843db6d49f6687401ae74208e5703e04a7253f47b917a3932094dce3af62e` |

The documented `run` CLI used the immutable restricted v3 bundle, existing
separately provisioned eval-only subscription login and a fresh mode-700 output
directory outside every git worktree. `CODEX_EVAL_HOME` selected that existing
login; credential contents were neither inspected nor printed. Concurrency was
one. Execution began at 22:48:17.809Z and sealed at 23:03:30.769Z. No protected
bytes, code, tests, schedule, rubric or labels changed. No competitor, fallback,
Claude call, reset redemption or later experiment ran.

## Counts and materiality

| Measurement | Actual result |
| --- | --- |
| Scheduled / completed grade attempts | 75 / 75 |
| Valid / rejected grades | 69 / 6 |
| Expected / retained judge invocations | 138 / 138 |
| Successful / rejected judge calls | 132 / 6 |
| Trusted `PostModelRequest` hook records | 144 |
| Expected-label mismatches among valid grades | 0 |
| Within-presentation repeat disagreements | 0 / 67 evaluable pairs (75 scheduled) |
| Between-presentation disagreements | 0 / 164 evaluable pairs (189 scheduled) |
| Report blockers | 6 `missing_or_failed` |

Each rejected call recorded one denied `PreToolUse` event. The six affected
sessions account for six additional `PostModelRequest` records beyond the 138
judge invocations. These are diagnostic hook counts, not proof of billed API
requests or served identity. There were no operator retries or replacement
sessions. The successful findings call preceding each failure is retained.

All six rejected grades belong to opaque preregistered unit `u02`:
`original/0`, `original/1`, `layout/0`, `wording/0`, `wording/1`, `wording/2`.
That unit has three valid grades; each other primary/control unit has nine.
Raw responses, tool inputs, answer labels and citations remain restricted.

The independently verified report applies the preregistered zero-tolerance
rules to categories, known-bug matches, harmful status, fixed/reintroduced
status, rounds and derived metrics. Valid grades meet their expected fields,
with zero repeat or presentation disagreements. Failed grades cannot contribute
comparison pairs: the smaller denominators prevent claiming complete stability.
Pair counts are dependent, descriptive comparisons. Prose/order differences
remain nonmaterial. No post-result exclusions, adjudications, majority vote or
rubric corrections were introduced. Missing/rejected grades alone require BLOCK.

| Probe | Valid attempts meeting preregistered expectations |
| --- | --- |
| Oracle | 3 / 3 |
| Null | 3 / 3 |
| Uncertainty | 3 / 3 |
| Wrong target | 3 / 3 |

Requested identity was GPT-6 Astra, High/Fast, subscription authentication and
configured-only verification. Served model, observed service tier and
API-equivalent spend remain **unknown/null**. The CLI report's identity count
of 126 covers calls in the 69 scored rows; it excludes the 12 calls belonging
to rejected grades. The full retained evidence contains all 138 invocations.
Active-model hook fields were not promoted to response-backed identity.

## Verification and retention

The unchanged `report` CLI verified the sealed inventory, recomputed the report
from all scheduled outcomes and matched its retained bytes. Both `run` and
`report` exited **2**, as required for this completed BLOCK result; both stderr
files are empty. Independent exact-membership/hash checks verified all 76 indexes
(75 attempts plus the run), including all 1,196 run-index members. No auth,
personal configuration or environment dump is retained. Credential-pattern scans
found zero matches across the 1,242 archived source files.

The fresh [maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-0218dfe1e2f32db2d220)
retains the actual run, operator verification logs and unchanged private v3
bundle. Release **433314416**, asset **707419567**, remains a draft and must
**never be published automatically**. Preserve the earlier v1/v2/v3
preregistration releases too.

- Archive: `astra-calibration-results-v3-20261103.tar.gz`, 2,532,460 bytes.
- SHA256: `708ff40d6579cd12b854a834edacaa74539f10b7e721cb253d6d5b52610d7602`.
- A fresh download matched the archive hash and all **1,243 file members**,
  including the 1,242-file `SHA256SUMS` inventory. No symlinks are included.
- The public [artifact index](codex-hillclimb-46/results-v3-artifact-index.json)
  contains only identities, retrieval metadata, paths, sizes and hashes.

Retrieve with maintainer access into a fresh mode-700 directory outside git:

```bash
gh release download cc-agents-46-calibration-results-v3-20261103 --repo lolisaigao1234/cc-agents --pattern astra-calibration-results-v3-20261103.tar.gz --dir /absolute/fresh-private-download
```

Verify the archive hash before extraction, then every extracted member against
the public index and `run-v3-20261103-SHA256SUMS`. The restricted report can be
reverified with the frozen CLI and extracted bundle:

```bash
node evals/review/calibration/calibrate.mjs report --private /absolute/private-extraction/preregistration-v3 --output /absolute/private-extraction/run-v3-20261103
```

Expected exit: **2 / BLOCK**. Local original evidence is retained under
`/home/ubuntu/cc-agents-artifacts/issue-46/run-v3-20261103`; operator logs are
under the sibling `evidence-v3-20261103` directory. The prior approval and private
bundle remain unchanged. No new tests were added or needed for this operational
execution; the actual plan, run, report and artifact verification are its checks.

## Next gate

The calibration is complete as an attempted schedule and fails its acceptance
gate. #46 stays open. A maintainer must review the retained tool-attempt failures
before deciding any remedy. Any changed runtime, prompt or rubric needs a new
versioned snapshot, explicit approval and fresh calibration; this run cannot be
repaired by replacing failed rows. #48/#49 cannot start from this BLOCK result.
