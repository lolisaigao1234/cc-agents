# Codex-only hillclimb #43: waiting for calibration approval

Integration branch: `43-codex-hillclimb-integration`, [draft PR #50](https://github.com/lolisaigao1234/cc-agents/pull/50), stacked on the existing eval branch. This is a partial implementation handoff, not a completed hillclimb or an adoption decision.

| Ticket | State | Evidence / next gate |
| --- | --- | --- |
| #44 integration handoff | Delivered; closed | [Reproduction and retained pilot evidence](codex-hillclimb-handoff-44.md). Five scored keys and eight failed attempts retained. |
| #45 readiness audit | Delivered; closed | [Five-case readiness matrix](codex-readiness-45.md). One confirmed temporary-root `.git` harness fault corrected; original product failures, guard denials and human requirements preserved. |
| #47 controlled variant | Delivered; closed | [v13 support and deterministic checks](codex-evidence-before-fix-47.md). No quality claim from injected execution. |
| #46 Astra calibration | Open; awaiting exact human approval | [Integrated v3 approval packet](codex-calibration-approval-v3.md). Zero live grades; the pre-integration v1/v2 snapshots remain identifiable. |
| #48 frozen repeated baseline | Not started; blocked by #46 | Requires actual calibration, its own preregistered screening/holdout protocol and final baseline freeze/approval. |
| #49 paired experiment and decision | Not started; blocked by #48 | No paired or held-out result exists; selection remains blocked. |

The native dependency frontier is #46. Closed prerequisites #44/#45/#47 do not approve changed runtime bytes or waive legitimate human decisions. #43 stays open until the remaining children deliver their evidence and the final decision is recorded. The source issue #39 remains open and unchanged.

## Review and current verification

An [interim two-axis review](codex-hillclimb-interim-review-43.md) found one Spec P1 and one low-priority Standards heuristic. Implementation revision [`c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c`](https://github.com/lolisaigao1234/cc-agents/commit/c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c) fixes both: completed competitor and all judge-call evidence survives later grading failure, and the calibration writer/verifier share canonical serialization. The grading prompts, schemas and metrics remain unchanged. A final spec-wide review still belongs after the remaining tickets.

Merged verification at `bb0eca50ce2809c07698b00ae5d4a0e2dc43ee50`:

- `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`: **83 pass, zero failures/skips**, including actual no-model sandbox probes for both arms.
- Actual integrated v3 `plan` command: exit **0**, with the exact identities below. Missing approval blocks live execution before auth; no real approval record exists.
- Historical #44 verifier: expected exit **2 / HUMAN stop** for the changed protected fingerprint. Historical approvals and retained evidence were not rewritten.
- Implementer full-suite comparison: two existing failures (uppercase `GH` parsing; installed versus vendored Claude declarations) and 55 unchanged typecheck diagnostics. `npm run check` is not reported green.
- Branch whitespace check passes excluding historical raw `*.log` evidence. Those logs retain their original whitespace and hashes.

## Exact calibration request

Approve or decline the [v3 calibration packet](codex-calibration-approval-v3.md) for **75 grades / 138 expected Astra High/Fast requests**, subscription authentication, concurrency one. Requested identity remains configured provenance; unobserved served model/tier and API-equivalent spend remain unknown/null. No live calls have occurred in this implementation run. Calibration does not run a competitor or authorize the later baseline/paired experiment.

| Identity | SHA256 |
| --- | --- |
| Protected harness | `096843db6d49f6687401ae74208e5703e04a7253f47b917a3932094dce3af62e` |
| Runtime manifest | `169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4` |
| Protocol | `28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b` |
| Preregistration | `ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7` |

The existing runner requires human review when protected harness bytes change, and the [v3 protocol](../../evals/review/calibration/protocol-v3.json) binds that decision to the exact runtime/protocol/preregistration. A genuine explicit human response can be faithfully transcribed into the documented record; agents must not invent it or approve changed hashes. No hand-written JSON is required from the human.

After approval, use a fresh implementer context based on the integration tip to run #46 with the documented restricted v3 bundle. Retain all requests/responses/failures and report actual material disagreements; do not silently modify labels or replace failed grades. Only close #46 when its actual acceptance evidence is delivered. Then advance the native frontier to #48. Raw calibration answers remain outside public git in a maintainer-access draft release; retrieval and hashes are in the packet.

The deferred Opus/Astra comparison remains pinned to historical fingerprint `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612` in its original checkout. No Claude restart, schedule change, reset redemption, product rollout or merge to the source eval branch/main was performed.
