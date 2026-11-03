# Sol/Astra integration pilot — 2026-11-03

**Status: complete.** Five unique `(case, rep=0)` rows are scored with status `ok`. Eight failed attempts remain in the error sidecar; none occupies a scored slot. This is a one-rep integration pilot. The matched Opus/Astra pilot is deferred until the reported Claude reset.

**Packaging (#44):** The [durable handoff](codex-hillclimb-handoff-44.md) gives remote revision and artifact retrieval instructions. Its [inventory](codex-hillclimb-44/artifact-inventory.json) hashes every scored key, failed attempt and retained raw artifact. Paths below describe the original ignored source evidence; use the retained bundle on a fresh checkout. No model call was made to package or reverify this evidence.

## Configuration

- Competitor: requested `gpt-6.1-sol`, High, Fast (`service_tier=fast`).
- Judge: requested `gpt-6-astra`, High, Fast; existing Fable findings/fixes rubric and metrics.
- Codex CLI: pinned `0.166.0`; baseline adapter; concurrency 1.
- Harness SHA: `e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612`.
- Model verification: explicitly approved `configured_only`; response-backed model and served tier remain unknown. No claim of independently verified server identity.
- Cost: unknown/unpriced, not zero. Cached input is included once; reasoning is part of output. Banked usage resets were not automatically redeemed.

## Scored cases

| Case | Recall | Known bugs fixed | Harmful findings | Noise | Review rounds | Asked human | Agent time, minutes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `pr16-r1` | 0.125 | 0.000 | 1 | 1 | 1 | 1 | 5.96 |
| `pr24` | 0.000 | 0.000 | 0 | 1 | 2 | 0 | 7.44 |
| `pr35-r0` | 0.000 | 0.000 | 0 | 0 | 1 | 1 | 10.06 |
| `clean-pr33` | — | — | 1 | 1 | 2 | 1 | 9.89 |
| `conv-pr33` | — | — | 0 | 6 | 3 | 0 | 18.90 |

Agent time excludes judge time, retries and backoff. Dashes mean the metric does not apply.

## Interpretation

The pilot exposes quality concerns to investigate in the matched comparison: the three cases with known introduced bugs have recall 0.125, 0 and 0; no known introduced bug was credited as fixed. The clean case received one harmful finding. Three cases stopped for human input. The convergence case completed three rounds without reintroducing its listed historical regressions.

Do not pool historical Fable-graded Opus results with this Astra-graded pilot. A matched Astra-graded Opus run and the original multi-rep/noise-floor design are needed before selecting a hillclimb winner. Native Claude versus adapted Codex workflow differences remain part of the candidate definition.

## Verification

- 47 covering eval checks pass, including 18 Codex tests and actual pinned nested sandbox tests. These were rerun for #44 with zero skips.
- Astra live selftest: oracle, null, “I don’t know” and wrong-target probes all pass.
- Sol-loop: APPROVE after 4 rounds using GPT-6.1 Sol, High/Fast. Reviewer token usage was not returned. Findings S1–S3 and D1–D5 are resolved; none declined.
- All five score keys are unique; saved traces, judge inputs and agent/judge raw JSONL exist.
- Independently recomputed recall, harmful, noise and precision from saved findings. Explicit round markers and reviewer-call counts match scored rounds.
- Per-call raw Codex input/output token totals reconcile with every scored row; hook diagnostics were not added to them. Exact pricing/cache-write coverage remains unknown.
- Only pr16-r1 had tests passing before review; they still passed afterward. The other replay test suites were already failing before the candidate, so a clean regression result is not claimed for them.
- Source typecheck diagnostics are unchanged from before this integration. Two original full-suite failures (uppercase GH trace parsing, vendored Claude declaration version mismatch) were reproduced independently.

## Preserved failed attempts

- First five attempts: nested sandbox initialization failure before meaningful review; recorded at the time as answer-key leaks because their error text mentioned protected paths. The redundant inner `/tmp` deny was removed; the outer private mount and specific denies remain. Future bootstrap failures are classified `sandbox_unavailable`.
- One retry: valid replay comment authorship was misclassified by the broad leak pattern. Input/output distinction now matches the existing Claude digest; raw failed evidence remains unchanged.
- Two grading attempts: Astra attempted a tool call; the judge guard rejected both grades. Fresh retries succeeded under the same frozen settings. No rejected grade was accepted or backfilled.

## Artifacts and cleanup

- Scored rows: retained archive member `review-codex-sol-astra/baseline/results.jsonl` (see [retrieval and hashes](codex-hillclimb-handoff-44.md#evidence-inventory-and-retention)).
- Failed attempts: retained archive member `review-codex-sol-astra/baseline/errors.jsonl`.
- `baseline/traces/`, `baseline/judge-inputs/`, `baseline/codex-events/` and `baseline/leaks/` retain detailed evidence and are ignored by git.
- The two diagnostic replay repositories, retained work tree and matching per-case temp directories were removed after artifact verification. The private persistent eval login remains provisioned; its runtime lock is released.
- No implementation commit, push, source-repository GitHub post, or research idea implementation was made during the original pilot. #44 separately packages the scoped integration on its ticket branch; the original evidence remains unchanged.

## Deferred comparison

Claude-dependent work stays deferred until the reported **2026-11-07 12:00 UTC** reset. The new `review-opus-astra` flow has the same reviewed harness approval and Astra configuration. A separate scheduled handoff records the exact resumption time; no historical stopped screen is restarted.

### Scheduled reset handoff

The matched Opus/Astra pilot is scheduled for **2026-11-07 12:05 UTC**, five minutes after the reported Claude reset. It uses the same five cases, one rep, concurrency 1, Opus 5.5 High, and Astra High/Fast. The current reviewed harness approval is already recorded for the new Opus flow. The scheduled run will stop on unreviewed harness changes, preserve Sol results and failures, and will not restart the historical screen or redeem banked resets automatically. It disables its schedule after completion.

Scheduled task: `scheduled-task:command:mcp:8a7f0824-c24c-456e-927b-8ef2e90adc7b:schedule-task:opus-astra-resume-after-reset-20261107`.
