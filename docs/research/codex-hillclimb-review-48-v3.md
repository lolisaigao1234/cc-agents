# #48 correction review and merged verification

Reviewed fixed diff `7b475390ef377fd978dc53598b7cb4cfcd2a81a1...07b0290787b7d59e307ccdf4f7b17c32d5061d26`.
Implementation merged as `f2642e71d0206981bd6c6fac1058933bc9a30082`; the merge tree
exactly matches the source tree. [Exact approval packet](codex-hillclimb-48/approval.md).
This review grants no execution permission.

## Standards

No findings. Independent fresh-context review checked `CLAUDE.md`, `GLOSSARY.md`,
`docs/agents/*`, active ADRs 0005–0008, issue #48 with comments and the maintenance
smell baseline. Changes remain in the eval harness and preserve documented trace,
archive and domain boundaries. No actionable maintenance heuristic was found.

## Spec

No findings. Independent fresh-context review checked issue #48 and the correction
packet. Raw evidence is preserved; only the two specified top-level audit fields
are removed from grader material. Oversized requests retain complete failure
evidence. The exact Matt pin verifies before native approval/authentication and
after copying; pinned flows cannot fall back to the mutable cache.

V2 cases, split, ordering, metrics and gates remain equal. Calibration retains the
30 input/source files and substantive expectations. Baseline v3 recomputes the
matching sealed v5 report and requires PASS, 75 grades and 138 calls. Historical
v4 PASS/v2 INCONCLUSIVE and distinct fresh approval scopes remain explicit.

Total findings: Standards 0; Spec 0. Neither axis has an outstanding issue.

## Merged verification

The merger independently reproduced both actual plans and every packet identity,
verified the 176-member production pin and exact 257-member dependency inventory,
and ran 23 focused checks including 15 protocol checks: all passed, zero skips.
Missing/stale approvals and absent actual v5 PASS reject; traced gate probes show
zero network connects, zero credential-path opens and no new run output.

All 286 historical v2 live/downloaded archive members and its archive hash verify.
The merger checked 73 historical preservation hashes, 148 unchanged product,
variant, data and historical files, and all 30 calibration inputs. Scoped
whitespace checks pass excluding retained raw logs. The implementation ledger
lists `exclusions` among equal protocol fields although it is absent from both
versions; substantive equality holds. No frozen input was changed for that wording.

Private merged proof:
`/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-integration-verification/summary.json`.
Implementer results and red/green regressions are in the
[check ledger](codex-hillclimb-48/checks-v3/summary.json): 89 covering passes;
204 full-suite passes, two historical failures and one intentional skip;
55 unchanged historical typecheck diagnostics, none introduced.

No new model calls, approvals, approved states or first-key native flag occurred.
Offline checks establish neither live quality nor future prompt capacity. The
packet's exposure, shared-source, low-power, observed-partial-outcome and
operator-controlled/no-concurrent-writer limits remain. Adoption is INCONCLUSIVE.
