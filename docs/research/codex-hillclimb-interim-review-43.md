# Interim integration review before calibration approval

## Standards

Standards review at `1cc777149937bedcc94d6c2cc68224aab184ba88`, against `34dc07b8879dfa175296ddcb84ee4a9296aefa65`.

Documented standards: no substantive violations found. Reviewed the named root/domain/triage docs, active ADRs 0005–0008, trace skill and eval README. The changed code stays in the eval tooling rather than adding review orchestration to the shipped plugin (ADR 0005). Human approval, unknown model/tier provenance and deferred live work are stated explicitly. The known integrated-runtime approval gap is excluded from this report as requested. No raw answer keys or held-out findings were inspected.

Heuristic smell — **Duplicated Code**, low priority (judgment call): `evals/review/calibration/freeze.mjs:14` and `evals/review/calibration/calibrate.mjs:22` independently implement the same canonical JSON serialization:

> `JSON.stringify(v, (_, x) => x && !Array.isArray(x) && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)`

(The second copy changes only variable names.) Both feed the runtime manifest hash: the writer at `freeze.mjs:33`, the verifier at `calibrate.mjs:143`. Keeping the serialization contract in two implementations makes a future ordering/normalization correction require synchronized edits and risks rejecting an otherwise identical manifest. Export one canonical serializer from a small calibration utility, or reuse the existing implementation alongside the already-shared `sha` and `schedule`. This is maintainability advice, not a current incorrect hash or approval bypass.

## Spec

**Spec review — one actionable finding (P1).**

**Preserve completed work when judging fails.** #43 requires “failed-attempt evidence”; #47 requires “Raw outputs, dispositions, variant identity and actual calls reach the saved trace and judge material.” In `evals/review/run.mjs:799–837`, the completed competitor transcript/raw events are persisted only after grading succeeds. If Sol finishes and Astra then rejects a tool attempt, times out, or exhausts retries, the catch at `run.mjs:860–883` records model/usage and the judge error stream, but never saves `lastRun.transcript` or `lastRun.meta.codex_events`. `runCase` has already removed the replay/home/tmp at `run.mjs:365–366`, so the completed review's findings, dispositions, verification and actual calls are lost. This affects both arms and prevents auditing failed paid attempts. Reproduction path: successful `runCodexAgent` → `lastRun = run` → failing `gradeCase` → errors row with no saved competitor trace. Also, if the findings judge succeeds and the changes judge fails, `grade.mjs:175–177` propagates usage but drops the first call's `rawEvents`/provenance; `gradeCase` deletes its work directory in `run.mjs:377–378`. Preserve per-attempt competitor and all judge-call evidence before cleanup, including failures followed by successful retries. The calibration driver already copies its on-disk call evidence before deletion; apply equivalent retention to the experimental runner.

No scope creep found in the reviewed implementation. Readiness documents preserve historical product failures and real human stops. Calibration comparisons, materiality rules and deferred status are explicitly disclosed. #46's zero live grades and #48/#49's blocked work are honest outstanding requirements, not newly discovered defects. The known integrated-runtime preregistration/approval preparation remains separate. No answer keys or held-out findings were inspected.

Standards: one low-priority maintainability finding; no hard violations. Spec: one P1 evidence-retention finding. The separately documented integrated-manifest preparation gap also remains to be addressed before requesting approval.

## Resolution and scope

Implementation revision `c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c` addresses the Spec P1 with per-attempt evidence retained before cleanup, including completed competitor output and all judge calls on later failures. It addresses the low-priority Standards duplication with a shared canonical serializer. Meaningful fake-execution regressions cover both failure retention paths; integrated covering checks pass 83/83. A new v3 snapshot verifies its own current membership and exact bytes, while the historical verifier still stops. This is an interim review and resolution record, not a fresh independent re-review or completion of the spec. Live calibration, baseline, paired experiment and final spec-wide review remain outstanding.
