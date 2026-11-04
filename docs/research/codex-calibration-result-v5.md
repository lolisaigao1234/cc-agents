# Calibration v5 actual result for #48

**PASS: 75/75 valid fresh grades, 138/138 completed Astra CLI calls, zero
failed grades, expectation blockers, tool attempts or replacements.** The frozen
report independently recomputes to PASS. This pilot-derived calibration makes no
model-quality, code-review gain or adoption claim. Adoption remains INCONCLUSIVE.

The real calibration-only approval at 2026-11-04T21:12:44.374Z binds immutable
packet `65f7491e51e1b4c409c78d5d7689369c4cf5d4b6`. Its restricted record SHA256 is
`4913dc3be0df96f809175945182108812fd92ece0fa5176b41f9299007bd2a81`.
The separate conditional baseline approval is not evidence of PASS.

Execution: 2026-11-04T21:16:30.357Z to 2026-11-04T21:29:51.809Z;
whole invocation 801.450 seconds, exit 0. All 75 scheduled
attempts ran once, in frozen order, concurrency one under the global model lock
and native eval-auth lock. No extra model diagnostic, retry, regrade or pooling
occurred. Historical v4 PASS and v2 INCONCLUSIVE remain unchanged.

Repeat comparisons: 75 pairs, zero disagreements.
Presentation comparisons: 189 pairs, zero
disagreements. These dependent pairs are descriptive, not independent trials.
All preregistered expectations and the four repeated probes passed.

Independent raw-evidence reconciliation checked every request/prompt/schema,
structured final, event stream, trusted hook ledger and outcome provenance.
All 138 calls completed, with 138 trusted PostModelRequest records and zero tool
attempts. The 276 error-typed notices are exactly the frozen native hook-trust
warning; no other error item was found. All 75 attempt indexes and every one of
the root index's 1,196 members match exact membership/hashes. The hash-only
[index](codex-calibration-results-v5/artifact-index.json) includes the root index
itself (1,197 files). No candidate app or human stop occurred in calibration.

The initial independent audit found only two copied **public** metadata files
(`preregistration.json`, `protocol.json`) at 0644 inside the restricted 0700 run
directory. Their copies were tightened to 0600; bytes and sealed indexes did not
change. All private request/response files already had 0600. Both initial audit
and permission-operation record are preserved. Final audit has zero issues; no
frozen source, installed cache/settings/lease or pin was changed by the operator. Native authentication followed the frozen runner;
credential values were never printed or included in reports.

Requested: gpt-6-astra, High/Fast, subscription authentication,
configured-only identity. Served model/tier and API-equivalent spend are null.
Usage coverage is 138/138 CLI calls: 2,680,071 known input tokens
(including cached input), 15,865 known output tokens. Hook
records are not added to CLI-call totals or treated as billed requests.

Post-run actual v5 plan SHA256 remains
`40810e512e71e83d30c2408a2dec1049b1a108598fd47db7241014f56f8832bd`;
actual v3 plan remains
`377b6d6c467a0037347251b8d9ac65867980a36fe79bde49552a4caf0b18f183`.
Runtime, protocol, preregistration, protected harness, 32 private inputs, exact
257-member dependencies and production Matt pin all verify against the
[approved packet](codex-hillclimb-48/approval.md). No frozen normative byte changed.

Restricted actual artifacts:
`/home/ubuntu/cc-agents-artifacts/issue-48/correction-v3-calibration-v5-run`.
The [unpublished actual draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-edc85c914dd78aafa592)
retains the full run and operator proof; fresh download verifies all 1,720 files
and 397 directories. Archive SHA256:
`bb8a209a6fdd9290b65cb8f1126c2376287d6856b2f71e197faa2c1c86cb9fad`.
The [complete hash-only index](codex-hillclimb-48-results-v3/actual-artifact-index.json)
records exact members/sizes/hashes/modes and zero credential-scan matches.
Existing input, pin and historical releases remain preserved. Raw evidence never
enters git.

The actual complete matching sealed v5 PASS condition is satisfied. Baseline
still requires the real exact v3 gate before fresh flow creation/authentication,
then the delegated native first-key flag once and per-key independent checks.
Candidate/holdout, changed hashes, Claude, resets and schedules are excluded.
Exposure, partial-v2, shared-source, low-power, pin/capacity and #45 readiness
limits remain; calibration does not settle those limits.
