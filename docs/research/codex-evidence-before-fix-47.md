# Issue #47: Codex evidence before fix v1

Implemented `v13`, protocol `codex-evidence-before-fix-v1`, alongside the unchanged baseline review/fix/update policy. [Behavioral delta](../../evals/review/variants/v13/change.md) distinguishes this narrow intervention from today's evidence-aware Codex baseline and Claude v5/v12. [Manifest](../../evals/review/variants/v13/variant.json) contains the exact treatment instruction. [Freeze record](codex-evidence-before-fix-47.json) pins its bytes and the protected runner content together; it is **not approval**.

No models or Claude calls were made. No calibration or held-out answers were inspected. Evidence is synthetic, with an injected executor and real local checks. Requested competitor remains Sol High/Fast, requested judge Astra High/Fast, subscription auth, concurrency one. Observed served model/tier and spend remain unknown/null. These results make no model-quality claim.

The two public seams are runner variant/preflight/resume validation and the injected-executor review/fix/update loop. Red/green slices observed: v13 initially rejected as baseline-only; the scenario initially lacked the pre-edit verification instruction; runner invalid variants initially reached the harness gate before protocol validation; cross-arm resume initially reached token setup before identity validation. Each passed after its corresponding implementation. Further regressions cover complete disposition accounting, both reviewers, three rounds, multi-commit SHA boundaries, accumulated Update, failure evidence and retry, hook denials/leaks, the unchanged tool-free judge, and actual pinned no-model sandbox execution through both arms' roles.

Reproduce without auth or models:

```bash
npm ci --ignore-scripts
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs
CODEX_WORKFLOW_EVIDENCE_DIR=/absolute/new/evidence node --test --test-name-pattern='verifies support, rejects' test/eval-codex.test.mjs
```

The second command includes the real pinned CLI `sandbox` subcommand only; all model execution is injected or uses a fake CLI. Prerequisites are the #44 host prerequisites (Node 24, Linux bubblewrap/user namespaces, Codex 0.166.0 and companion binaries). No live selftest, answer-key grading run or approval flag is needed.

The scenario runs both arms with identical synthetic allegations: zero is incorrectly defaulted; negative inputs allegedly throw (contradicted by an actual passing assertion); an upper limit requires a human choice absent from the requirements. It checks the failing zero assertion before editing, preserves negative inputs, verifies after editing, and then carries the unanswered upper-limit question into Update. Both arms use seven calls across two independent reviewer pairs, two fix sessions and Update. Baseline responses use its existing free-text summary; v13 responses use the new disposition schema. Saved evidence retains all three allegations, verification, rejection and decision, including earlier rounds.

Artifacts are outside git at `/home/ubuntu/cc-agents-artifacts/issue-47/`: `scenario/{baseline,v13}/{requests.json,raw-events.jsonl,trace.json,judge-input.json,provenance.json}`, `checks/`, and `SHA256SUMS`. They contain only synthetic scenario data and no answer material or credentials. The final handoff records check counts, hashes and immutable git revision.

New scored arms must use a separate flow with a real human review of the new fingerprint. Resume refuses different execution configuration, judge, effort/tier or variant identity before setup; legacy rows lacking the new identity cannot silently migrate. The deferred Opus/Astra comparison, its historical approval `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612`, source checkout, states, evidence and schedules remain unchanged. The historical verifier should STOP with exit 2 against this changed harness. The repeated baseline has not started; no approval was granted or written.

Final checks: covering eval + guard **72 pass, zero failures/skips**. `npm test`: **184 pass, two pre-existing failures, four skips** (190 total); failures remain uppercase `GH` trace parsing and installed/vendored Claude declaration versions. The additional sandbox skip reflects exercising the full workflow per arm; both were run with zero skips in the covering command. `npm run typecheck`: the same **55 diagnostics**, byte-identical to #44's saved typecheck log. `git diff --check` passes. Full logs and an artifact hash index remain outside git at the evidence path above.

Runtime revision: `5cbcfaf21c4a1945570fabcb7b368d0aabe7d16a`. New protected fingerprint: `b7f0110f034fdf68cc1c96334231efded23bad96418ee51f0f6773663201633a` (118 files). The historical verifier returned the required exit **2**, HUMAN stop. Approval remains outstanding; this ticket did not run or approve a repeated baseline.
