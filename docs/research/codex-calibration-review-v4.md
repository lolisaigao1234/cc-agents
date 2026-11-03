# Calibration v4 review and merged verification (#46)

The correction is prepared, with zero live v4 calls and no v4 approval record.
V3 remains BLOCK / INCONCLUSIVE; #46 stays open and #48/#49 remain blocked.

Reviewed fixed range: `3b36c90d1ed28e0874128e29a1909efc24fe7312...230ade413dee3f8ad098f932169b4a477899794c`.
Implementation `a9b57be3162cdbae0229d72975efbe6f18190f33`, frozen preparation
`230ade413dee3f8ad098f932169b4a477899794c`; merged to integration in `01d22fc`.
Two fresh GPT-6.1 Sol subagents reviewed the axes independently and read only.

## Standards

No actionable standards findings.

No documented standard breaches found against CLAUDE.md, GLOSSARY.md,
domain/issue-tracker/triage guidance, or active ADRs 0005–0008.

No actionable smell findings. The copied v4 freezer resembles v3, but preserving
historical freezer/runtime bytes is explicitly documented; extracting shared
code here would conflict with that preservation boundary.

## Spec

No actionable spec findings in `3b36c90...230ade4`.

Actual judge requests receive explicit tool-free instructions and the frozen
issue/PR diff. The sufficiency audit supports the narrow existing expectations;
private bundle semantics, citations, inputs and source bytes remain unchanged
apart from versioning. Public indexes retain hashes without exposing raw labels.

Actual v4 planning reproduces the advertised hashes and 75-grade/138-request
schedule. Focused review verification passed 33 tests, with four opt-in sandbox
checks skipped in that invocation. The implementer's covering invocation
explicitly enabled sandbox tests: 83 passed, zero failures/skips.

Fresh recalibration remains pending exact human approval. No live-compliance or
calibration-success claim is made.

Standards: zero actionable findings. Spec: zero actionable findings.

## Integrated evidence

The [preparation packet](codex-calibration-correction-v4.md) retains red/green
checks, the 83-test covering run, known broad-suite failures, immutable private
migration, the sufficiency audit and verified draft-release archives.

The integration merge preserves protected runtime bytes. The actual plan after merge exits 0 and is byte-identical to the retained
preparation plan against `/home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4`.
A real explicit response bound to the packet's runtime/protocol/preregistration
hashes must precede auth and live execution. V3 approval is not reused.
