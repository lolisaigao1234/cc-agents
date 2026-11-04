# #48 v2 preparation review and integrated verification

Reviewed preparation head `6bd0412c7610efca219158c6741e09013e12861f`
against fixed point `bd1ce2c4d6823fd4d0306c845aa2c5551788b513`.
The v2 revision is merged in `e6606a8c329cb6fa2cbf6283ce514130adb98892`.
Two fresh GPT-6.1 Sol subagents reviewed Standards and Spec independently.
This is preparation review, not execution approval or a completed baseline.

## Standards

No documented-standard breaches found.

P3 — possible Duplicated Code: `protocol.mjs:123` and `:154` calculate the same
equal-PR mean of case recall ranges in the gate and baseline summary. A future
correction could change the displayed baseline noise without changing the gate.
The reviewer suggested consuming one validated calculation. This is a maintenance
heuristic, not a documented-standard violation.

Disposition: deferred as a non-blocking maintenance note. Both current formulas
implement the same declared statistic and the public-interface tests check
independent worked noise/threshold values. No current disagreement or intended-case
failure was found. The frozen preparation is kept minimal; a future behavior
change must update the manifest and receive fresh exact approval.

## Spec

No actionable spec findings in the reviewed preparation diff.

V2 addresses the earlier defects: metadata-only partition revision removes the
four-group lattice impossibility without weakening gates; per-arm validity now
precedes completeness/noise; valid baseline-only evidence exposes descriptive
three-repeat variability. Exact v13 and calibrated runtime identities are unchanged.

Author exposure, postexposure pool selection, shared ancestry and low power are
disclosed without blindness or population-independence claims. The native
human-only approval procedure accurately describes the runner: its flag records
the digest and proceeds with the first key. The offline gate remains structural;
actual human provenance, prerequisite review and evidence reconciliation remain
operator duties. No native flow approval or experiment execution has occurred.

The remaining live acceptance is explicit: #48 needs the repeated baseline and
sealed results; #49 needs the paired screen, reserved validation and final decision.
Those are pending steps, not claims made by this preparation.

Standards: zero hard violations, one deferred P3 heuristic. Spec: zero actionable findings.

## Integrated checks

The merger and parent independently ran 14 protocol tests: 14 passed, no failures
or skips. The covering implementation run has 83 eval/guard passes and no skips.
The actual plan after merge exits 0 and reproduces its exact retained bytes:
33 baseline-screen keys, 33 candidate-screen, 30 baseline-holdout and 30 candidate-
holdout. Every stage remains unapproved; only baseline-screen is proposed next.

Manifest `86feea45091c2a86e2d1ac545b7b4abb48202548e74a3ae80182844188f5ca22`,
protocol `8dc56d50a31612f72f6d80ffb1237030869c72a79ad1332404523cfb788c3090`,
plan `9401adab8086fc74a939b2e7e894bb87902416e9335164e07526fe97f70eaedf`.

The 150-member calibrated runtime, 119 protected files, 32 private members,
original v1 check bytes and exact v13 remain unchanged. V4 plan output matches
retained bytes; actual calibration PASS is not rerun or pooled. Fresh missing-
approval tracing rejects with exit 2/HUMAN, zero credential opens and zero network
connect calls. No flow, approved state or baseline row exists. Scoped whitespace
checks exclude immutable raw logs with documented original trailing whitespace.
Historical broad-suite failures/diagnostics remain disclosed.

[Exact packet](codex-hillclimb-48/approval.md) and
[independent provenance/methods records](codex-hillclimb-48/review-provenance.json)
are available before the real baseline-only approval. A user may explicitly delegate
the exact first-key native approval command as part of that response; this review
itself grants no exception or execution permission.
