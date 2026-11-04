# Codex-only hillclimb #43: partial baseline material stop; adoption INCONCLUSIVE

Integration [PR #50](https://github.com/lolisaigao1234/cc-agents/pull/50) merged at `f18ce230c1650e1693836f26233b716f5129fe2d`. Followthrough branch: `43-codex-calibration-v3-followthrough`. The approved [actual v4 calibration](codex-calibration-result-v4.md) returned a limited **PASS** on 2026-11-03: 75 valid grades, 138 successful retained requests and zero failures. The approved [v2 baseline-screen execution](codex-baseline-result-48-v2.md) stopped materially on 2026-11-04 with **3 scored keys, 1 failed key and 29 unstarted keys**. The baseline is incomplete, validated stage metrics and noise/uncertainty estimates are withheld, and adoption remains **INCONCLUSIVE**. No candidate or held-out result or candidate quality claim exists. The original v3 result remains **BLOCK / INCONCLUSIVE**.

| Ticket | State | Evidence / next gate |
| --- | --- | --- |
| #44 integration handoff | Delivered; closed | [Reproduction and retained pilot evidence](codex-hillclimb-handoff-44.md). Five scored keys and eight failed attempts retained. |
| #45 readiness audit | Delivered; closed | [Five-case readiness matrix](codex-readiness-45.md). One confirmed temporary-root `.git` harness fault corrected; original product failures, guard denials and human requirements preserved. |
| #47 controlled variant | Delivered; closed | [v13 support and deterministic checks](codex-evidence-before-fix-47.md). No quality claim from injected execution. |
| #46 Astra calibration | Delivered: v4 PASS; PR #51 closes #46 | [Actual v4 result](codex-calibration-result-v4.md): 75/75 valid grades, 138/138 successful retained requests, zero failures, zero repeat/presentation disagreements and all probes passing 3/3. V3 remains BLOCK. |
| #48 frozen repeated baseline | Open; partial actual material stop | [Retained actual result](codex-baseline-result-48-v2.md): 3 scored / 1 failed / 29 unstarted. Judge input limit and external-cache membership block completion; offline correction is being prepared before any new snapshot or approval. |
| #49 paired experiment and decision | Not started; blocked by #48 | No candidate, paired or held-out result exists; selection remains blocked. |

The [v4 correction](codex-calibration-correction-v4.md) was approved and a whole fresh calibration completed under the unchanged frozen snapshot. All 30 input/source files, substantive expectations and the 75-grade/138-request schedule are unchanged. The sealed report reproduces **PASS / exit 0**, with zero disagreements across **75 repeat pairs** and **189 presentation pairs**, and oracle/null/uncertainty/wrong-target probes each **3/3**. The [full-send ledger](codex-calibration-full-send-v4.md) records authorization, proof and review. Preparation statements about zero calls and missing approval are historical.

PR #51 delivered #46 acceptance and closed #46. The current frontier is #48's material baseline blockers, with #49 blocked by the incomplete baseline. Earlier no-start and preparation statements below describe their historical snapshots. Closed prerequisites #44/#45/#47 and the limited calibration PASS do not approve changed runtime bytes or future experiments. #43 stays open until the remaining children deliver their evidence and the final decision is recorded. The source issue #39 remains open and unchanged.

## Review and historical verification

An [interim two-axis review](codex-hillclimb-interim-review-43.md) found one Spec P1 and one low-priority Standards heuristic. Implementation revision [`c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c`](https://github.com/lolisaigao1234/cc-agents/commit/c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c) fixes both: completed competitor and all judge-call evidence survives later grading failure, and the calibration writer/verifier share canonical serialization. The grading prompts, schemas and metrics remain unchanged. A final spec-wide review still belongs after the remaining tickets.

Historical merged verification at `bb0eca50ce2809c07698b00ae5d4a0e2dc43ee50`:

- `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`: **83 pass, zero failures/skips**, including actual no-model sandbox probes for both arms.
- Actual integrated v3 `plan` command: exit **0**, with the exact identities below. At that point, no real approval record existed; the missing-approval check blocked live execution before auth.
- Historical #44 verifier: expected exit **2 / HUMAN stop** for the changed protected fingerprint. Historical approvals and retained evidence were not rewritten.
- Implementer full-suite comparison: two existing failures (uppercase `GH` parsing; installed versus vendored Claude declarations) and 55 unchanged typecheck diagnostics. `npm run check` is not reported green.
- Branch whitespace check passes excluding historical raw `*.log` evidence. Those logs retain their original whitespace and hashes.

## Historical v3 approval and actual result

The human approval transcribed on 2026-11-03 bound the [v3 calibration packet](codex-calibration-approval-v3.md) to **75 grades / 138 expected Astra High/Fast requests**, subscription authentication and concurrency one. The [actual result](codex-calibration-result-v3.md) retains all 75 attempts: 69 valid grades and six tool-attempt rejections, with all 138 judge invocations preserved. No attempt was retried, replaced, relabelled or excluded. The six rejected grades require **BLOCK / INCONCLUSIVE**, despite zero expectation mismatches or material disagreements among evaluable valid grades. Requested identity remains configured provenance; served model/tier and API-equivalent spend remain unknown/null. Calibration ran no competitor and did not authorize the later baseline/paired experiment.

| Identity | SHA256 |
| --- | --- |
| Protected harness | `096843db6d49f6687401ae74208e5703e04a7253f47b917a3932094dce3af62e` |
| Runtime manifest | `169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4` |
| Protocol | `28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b` |
| Preregistration | `ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7` |

The frozen v3 `report` CLI independently reproduced the sealed result and exited **2 / BLOCK**. At that frozen revision, `plan` exited **0** and was byte-identical to the retained v3 pre-run and post-run plans. All 76 sealed indexes have exact membership and matching hashes; all 1,243 entries in the public [artifact index](codex-hillclimb-46/results-v3-artifact-index.json) match local retained bytes. No protected runtime, protocol, schedule, rubric or private bundle bytes changed during v3 execution.

At the v3 result, the native frontier remained #46. The [reviewed v4 correction](codex-calibration-review-v4.md) subsequently addressed the instruction/context gaps in a new frozen snapshot and received approval for its whole fresh calibration. Failed v3 rows cannot be replaced to repair that result. Baseline/candidate execution cannot advance from the v3 result. Raw calibration answers remain outside public git in maintainer-access draft releases; retrieval and hashes are in the actual results and artifact indexes. Preserve the earlier releases and never publish answer keys automatically.

The deferred Opus/Astra comparison remains pinned to historical fingerprint `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612` in its original checkout. This followthrough made no Claude restart, schedule change, reset redemption or product rollout. PR #51 targets its intentionally requested source eval branch at base `f18ce230`; it has not been retargeted to main.

## Frozen v4 packet and historical preparation gate

The [correction and exact snapshot](codex-calibration-correction-v4.md) are merged
into the integration branch. Historical independent Standards and Spec reviews found no
actionable issues; see the [review and merged verification](codex-calibration-review-v4.md).
The current plan verifies 150 runtime, 119 protected and 32 private members.
All 30 input/source files and substantive expectations remain unchanged.

| Frozen v4 identity | SHA256 |
| --- | --- |
| Runtime | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protocol | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| Preregistration | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |
| Protected harness | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |

Approved scope: calibration only, 75 fresh grades / 138 expected Astra High/Fast
requests, subscription authentication, concurrency one, configured-only identity.
Unobserved served model/tier and API-equivalent spend remain unknown/null. The
actual v4 approval and result are retained separately from this frozen packet;
v3 approval covers different bytes and remains rejected before auth. The current
plan exits **0** and reproduces these hashes. Its frozen status text about missing
approval and no live results describes preparation, while the separate sealed
report exits **0 / PASS**. No protected runtime, README, manifest, protocol, test
or private bundle bytes changed. Calibration did not authorize #48/#49 calls;
the separately approved v2 baseline and its material stop are recorded below.

## Historical #48 v2 baseline preparation

This section records preparation at `b1dc97f`, before the later real approval and
partial actual execution. Its no-start and next-approval statements are historical.

[Draft PR #52](https://github.com/lolisaigao1234/cc-agents/pull/52) contains the
[exact v2 baseline packet](codex-hillclimb-48/approval.md) and
[parent preparation review](codex-hillclimb-review-48.md). Screen: 11 cases with
three reps, 33 keys per arm. Reserved validation: 10 cases, 30 keys per arm.
Five primary PR groups per split permit the unchanged conditional 95% gate to
pass mathematically; power remains low and independence is unproved. All pilots
remain in screen. No baseline/candidate/holdout run or approved flow exists.

The catalog-read incident exposed answer-bearing author context. V2 records the
full persisted catalog, unknown original response truncation and postexposure pool
selection. Exact v13/runtime bytes remain unchanged. The bounded potential claim
is fixed-candidate validation within this finite benchmark, not certified unseen
or blind data. These limits are part of the proposed real approval request.

The offline plan and 14 protocol tests pass after merge. Calibration v4 still
verifies unchanged. Invalid baseline evidence now withholds completeness/noise;
valid baseline-only results can disclose descriptive repeat variability. The next
step is real exact baseline-screen approval; #49 still waits for baseline evidence
and its later separate approval. Adoption remains INCONCLUSIVE.

## #48 v2 partial actual baseline and current frontier

The user approved the exact 33-key baseline-screen packet and delegated the native
first-key `--approve-harness` flag. Four native runner invocations produced four
successful app attempts, four judge attempts, three scored rows and one failed
judge attempt. No retries or replacements occurred. `pr17-r0/rep0` has no grade:
its native judge request was rejected as `input_too_large` (`-32602`), with
**1,068,777 characters against the 1,048,576-character limit**. The retained app,
request, raw calls and failure evidence supply no grade or fix credit.

Final execution checks also rejected a new Matt 1.3.2 `.in_use/450239` marker:
the bound 176-member external cache had 177 members, with existing member bytes
unchanged. A current read-only check still rejects live cache membership drift
(`.in_use/461364` at verification time). No marker was removed, exempted or copied
into a new bound snapshot. The old v2 experiment plan exits **2**, as expected;
the current v4 calibration plan separately exits **0** with the unchanged runtime,
protocol, preregistration and protected-harness hashes above. Its stdout SHA256 is
`358321851475a4025f55fda886414cf873a22967bf7572689a5ec61d3805f1e4`.
The sealed actual calibration PASS remains unchanged and was not rerun or pooled.

The [actual report](codex-baseline-result-48-v2.md) retains raw observations and
coverage, including human stops and unresolved live verification. Only three of
33 rows are scored; primary recall coverage is 3/15. All validated stage metric
means, primary PR-weighted recall/N, repeat ranges, noise floor and uncertainty
estimates remain null. No clean-case harm observation or candidate gain exists.
The 29 unstarted keys include two higher repetitions that would retry failed rep0
and 27 later keys stopped after the material failure. No old-key retry, replacement,
regrading or pooling with pilot, calibration or future results is authorized.

The [actual hash-only artifact index](codex-hillclimb-48-results-v2/actual-artifact-index.json)
independently matches the fresh downloaded archive: **286 file members, 55 directory
members and 285 checksummed members**, with exact membership, sizes and hashes;
all 286 restricted originals and 12 post-seal receipts also verify. Archive SHA256:
`5137e8525c63bf01eb93fcff22111293ef230ff842fb83dbf909e07bdec40d6f`.
Raw evidence remains in the unpublished maintainer-only draft release. The original
zero-attempt preflight and its separate 47-file index remain historical and intact.

An offline correction is being prepared for the judge input envelope and mutable
external-cache prerequisite. Any changed runtime, prompt or protocol needs a new
versioned snapshot, relevant calibration, a fresh comparable baseline and exact
future human approval. No corrected packet or new execution approval is claimed.
#48 remains open and incomplete, #49 remains blocked, and adoption remains
**INCONCLUSIVE**.
