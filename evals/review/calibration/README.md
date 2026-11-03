# Astra calibration v1 (#46)

This driver replays a preregistered, pilot-derived calibration set through the
unchanged `../lib/grade.mjs` findings/fixes rubric. It never runs a competitor.
The public preregistration lives in
`docs/research/codex-hillclimb-46/preregistration.json`; the answer keys,
citations, input bytes and reproducible builder live in the separate restricted
artifact bundle identified there. Do not put that bundle in git.

Seven focused units cover known matching, valid-other, wrong/harmful, noise,
fixed/unfixed, and introduced/not-introduced defects. Each has an original and
two equivalent presentations, with three independent grades each. Four probes
(oracle, null, uncertainty and wrong target) each run three times: **75 grades,
138 expected judge requests**. Fix and regression decisions get nine identical
changes prompts per unit; only review material is rewritten. These are focused
derived inputs and explicit synthetic controls, not untouched historical replay
outputs. Original saved input bytes remain separately retained. No historical
judge grade is used as an answer key. Context is restricted to selected pilot
bugs; this deliberately does not load the global trap/held-out collection.

`protocol.json` freezes the comparison, materiality, rejection and acceptance
rules. Every structured verdict and derived metric is material. Explanatory
prose, list order and location formatting are ignored. The driver reports all
within-presentation repeat pairs separately from between-presentation pairs.
These dependent pairs are descriptive counts, not independent significance
tests. Missing/failed/rejected grades and unsupported expectations block
selection, even if the surviving grades agree. It never takes a majority vote
or automatically adjudicates ambiguity. Corrections require a new version,
fresh approval and fresh calibration; old protocols cannot be pooled.

Run the offline plan with the retained directory (mode 700, outside any git
worktree):

```bash
node evals/review/calibration/calibrate.mjs plan --private /absolute/preregistration-v1
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs
```

The plan hashes all registered code/config/input bytes and verifies the original
115-file #44 fingerprint. **The new driver has a separate runtime manifest.**
Matching the old fingerprint is necessary but does not approve this driver.
The manifests identify the driver, protocol, tests, runtime dependencies and
restricted builder/input bytes; Node and the pinned Codex binaries are separately
bound. This eval uses no installed plugin skills or runtime third-party imports.

Live execution is blocked until a real human reviews the public code/rules and
restricted inputs/expected-label citations, then supplies a separate approval
record. Required record fields are `human_approval: true`, `approved_by`,
`record` (the human review locator), `approved_at` (ISO date), and exactly the
three hashes printed by `plan`: `runtime_sha256`, `protocol_sha256`, and
`preregistration_sha256`. There is deliberately no approval-writing command.
An agent must not create or edit this record to approve itself. The historical
#44 flow approval does not cover this experiment. A changed byte requires new
human review; do not edit old approvals or use `--approve-harness`.

After that approval, using the already provisioned eval-only subscription auth:

```bash
node evals/review/calibration/calibrate.mjs run --private /absolute/preregistration-v1 --output /absolute/fresh-restricted-run --approval /absolute/human-approval.json
node evals/review/calibration/calibrate.mjs report --private /absolute/preregistration-v1 --output /absolute/fresh-restricted-run
```

The driver verifies approval before importing the model adapter or accessing
authentication. It holds `/tmp/cc-agents-43/model-run.lock` plus the eval auth
lock, schedules sequentially, and never invokes Claude, retries a failed grade,
changes candidate prompts, falls back to another model or redeems resets. A fresh
output directory prevents replacement of a prior run. Requested identity is
Astra High/Fast; configured-only identity stays distinct from observed identity.
Missing served identity/tier and API-equivalent spend remain unknown/null.

Every attempt retains the input request, exact rendered prompts and schemas,
raw responses, final outputs, trusted hook ledger, stderr, outcome/failure and
hash index. Allowlist copying excludes runtime auth before cleanup. A crash
without a complete sealed run blocks completion; retain the incomplete directory
and do not turn it into scored evidence. Use a fresh directory for a new approved
run. Restricted reports include label-level details; CLI output shows only safe
counts and status. Keep all failed attempts and previous protocol versions.

Reproducing the frozen set requires the restricted `build-v1.py` artifact and
its saved pilot archive. Run that builder with this checkout, the extracted
pilot directory and a fresh outside-git destination. Hash-compare every output
to the preregistered private inventory. `freeze.mjs PRIVATE_DIR` creates the
public manifest once (exclusive create); it never approves the result. A future
set/rubric version must get new retained artifacts and new human approval.
