# Codex-only hillclimb #43: calibration BLOCK / INCONCLUSIVE

Integration [PR #50](https://github.com/lolisaigao1234/cc-agents/pull/50) merged at `f18ce230c1650e1693836f26233b716f5129fe2d`. Followthrough branch: `43-codex-calibration-v3-followthrough`. The approved v3 calibration ran on 2026-11-03 and returned **BLOCK / INCONCLUSIVE**. The hillclimb remains incomplete; no baseline/candidate results or adoption decision exist.

| Ticket | State | Evidence / next gate |
| --- | --- | --- |
| #44 integration handoff | Delivered; closed | [Reproduction and retained pilot evidence](codex-hillclimb-handoff-44.md). Five scored keys and eight failed attempts retained. |
| #45 readiness audit | Delivered; closed | [Five-case readiness matrix](codex-readiness-45.md). One confirmed temporary-root `.git` harness fault corrected; original product failures, guard denials and human requirements preserved. |
| #47 controlled variant | Delivered; closed | [v13 support and deterministic checks](codex-evidence-before-fix-47.md). No quality claim from injected execution. |
| #46 Astra calibration | Open; approved run BLOCK / INCONCLUSIVE | [Actual v3 result](codex-calibration-result-v3.md): 75/75 attempts, 69 valid grades, six tool-attempt rejections and 138 retained judge invocations. The pre-integration v1/v2 snapshots remain identifiable. |
| #48 frozen repeated baseline | Not started; blocked by #46 | Requires passing calibration, its own preregistered screening/holdout protocol and final baseline freeze/approval. |
| #49 paired experiment and decision | Not started; blocked by #46/#48 | No candidate, paired or held-out result exists; selection remains blocked. |

The native dependency frontier is #46. Closed prerequisites #44/#45/#47 do not approve changed runtime bytes or waive legitimate human decisions. #43 stays open until the remaining children deliver their evidence and the final decision is recorded. The source issue #39 remains open and unchanged.

## Review and historical verification

An [interim two-axis review](codex-hillclimb-interim-review-43.md) found one Spec P1 and one low-priority Standards heuristic. Implementation revision [`c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c`](https://github.com/lolisaigao1234/cc-agents/commit/c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c) fixes both: completed competitor and all judge-call evidence survives later grading failure, and the calibration writer/verifier share canonical serialization. The grading prompts, schemas and metrics remain unchanged. A final spec-wide review still belongs after the remaining tickets.

Historical merged verification at `bb0eca50ce2809c07698b00ae5d4a0e2dc43ee50`:

- `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`: **83 pass, zero failures/skips**, including actual no-model sandbox probes for both arms.
- Actual integrated v3 `plan` command: exit **0**, with the exact identities below. At that point, no real approval record existed; the missing-approval check blocked live execution before auth.
- Historical #44 verifier: expected exit **2 / HUMAN stop** for the changed protected fingerprint. Historical approvals and retained evidence were not rewritten.
- Implementer full-suite comparison: two existing failures (uppercase `GH` parsing; installed versus vendored Claude declarations) and 55 unchanged typecheck diagnostics. `npm run check` is not reported green.
- Branch whitespace check passes excluding historical raw `*.log` evidence. Those logs retain their original whitespace and hashes.

## Approved calibration and actual result

The human approval transcribed on 2026-11-03 bound the [v3 calibration packet](codex-calibration-approval-v3.md) to **75 grades / 138 expected Astra High/Fast requests**, subscription authentication and concurrency one. The [actual result](codex-calibration-result-v3.md) retains all 75 attempts: 69 valid grades and six tool-attempt rejections, with all 138 judge invocations preserved. No attempt was retried, replaced, relabelled or excluded. The six rejected grades require **BLOCK / INCONCLUSIVE**, despite zero expectation mismatches or material disagreements among evaluable valid grades. Requested identity remains configured provenance; served model/tier and API-equivalent spend remain unknown/null. Calibration ran no competitor and did not authorize the later baseline/paired experiment.

| Identity | SHA256 |
| --- | --- |
| Protected harness | `096843db6d49f6687401ae74208e5703e04a7253f47b917a3932094dce3af62e` |
| Runtime manifest | `169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4` |
| Protocol | `28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b` |
| Preregistration | `ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7` |

The frozen `report` CLI independently reproduced the sealed result and exited **2 / BLOCK**. The current `plan` exits **0** and is byte-identical to the retained pre-run and post-run plans. All 76 sealed indexes have exact membership and matching hashes; all 1,243 entries in the public [artifact index](codex-hillclimb-46/results-v3-artifact-index.json) match local retained bytes. No protected runtime, protocol, schedule, rubric or private bundle bytes changed.

The native frontier remains #46: a maintainer must review the retained failures before deciding any remedy. Any changed runtime, prompt or rubric needs a new versioned snapshot, explicit approval and fresh calibration. Failed rows cannot be replaced to repair this result. #46 stays open and #48/#49 stay blocked; baseline/candidate execution cannot advance from this result. Raw calibration answers remain outside public git in a maintainer-access draft release; retrieval and hashes are in the actual result and artifact index. Preserve the earlier releases and never publish answer keys automatically.

The deferred Opus/Astra comparison remains pinned to historical fingerprint `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612` in its original checkout. No Claude restart, schedule change, reset redemption, product rollout or merge to the source eval branch/main was performed.
