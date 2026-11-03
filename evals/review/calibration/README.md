# Astra calibration v3 (#46), integrated and UNAPPROVED

The default `calibrate.mjs` command now uses
`docs/research/codex-hillclimb-46/preregistration-v3.json` and `protocol-v3.json`.
It prepares the actual integrated #45/#47 runtime plus the failed-attempt
retention correction. No live grades exist and no approval is supplied.
V1/v2 public/private manifests, protocols, citations and original input bytes
remain historical evidence at their frozen commits and separate draft releases.
The unchanged #44 verifier still exits 2/HUMAN stop on this runtime. V3 checks
its own current membership/bytes; it never treats an old fingerprint as approval.

The restricted v3 set preserves all v2 input/source bytes, substantive labels,
citations, exclusions and schedule. Only bundle version and builder version/output
filename change. The public `migration-v3.json` records every old/new file hash.
No held-out findings or historical judge grades are used as answer keys.

Seven primary/control units each have original/layout/wording presentations and
three independent grades each. Oracle, null, uncertainty and wrong-target probes
each get three repeats: **75 grades, 138 expected judge requests**, sequentially.
Changes prompts repeat nine times per primary/control unit with identical patch
bytes. Findings/changes prompts, system instruction, schemas and metrics retain
the original rubric. `grade.mjs` now carries successful calls through a later
failure; that implementation change is part of this new runtime identity.

`protocol-v3.json` fixes materiality, rejection and acceptance before results.
Every structured verdict and metric is material. Prose, ordering and location
formatting are ignored. Missing/failed/rejected grades or wrong expectations
block selection. Repeat and presentation pair counts remain separate, descriptive
counts. There is no majority vote, automatic adjudication or post-result exclusion.

Run the offline plan against the restricted directory (mode 700, outside git):

```bash
node evals/review/calibration/calibrate.mjs plan --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v3
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs
```

Plan and run verify current git-visible protected/runtime membership, every
registered byte, the complete private inventory, protocol and Node/Codex/system
binary prerequisites before authentication. Added or deleted dependencies also
fail. The runtime includes all eval libraries, v13/codex-variants, calibration
driver/builders/protocols, tests, plugin guard code and lock/config files.
System libraries/kernel, DNS/network and subscription availability are declared
external prerequisites. No installed plugin skill or third-party package is
imported by this calibration driver. It never runs a competitor.

A real human must explicitly approve the concrete revision, protocol and
preregistration. Approval is for calibration only. A clear response bound to the
three hashes printed by plan is enough; an agent may faithfully transcribe that
response and its locator into a record. The agent cannot invent a decision,
broaden its scope or approve changed hashes. The human need not hand-write JSON
or personally adjudicate every raw answer. The record fields are
`human_approval: true`, `approved_by`, `record` (human response locator),
`approved_at` (ISO date), `runtime_sha256`, `protocol_sha256`, and
`preregistration_sha256`. No approval-writing command is provided, and no real
record has been written. Historical #44 approval cannot cover this snapshot.

Only after that approval, with existing separately provisioned eval-only
subscription authentication:

```bash
node evals/review/calibration/calibrate.mjs run --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v3 --output /absolute/fresh-restricted-run --approval /absolute/transcribed-human-response.json
node evals/review/calibration/calibrate.mjs report --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v3 --output /absolute/fresh-restricted-run
```

Approval is checked before importing the model adapter or accessing auth. The
model-run lock and eval-auth lock cover the sequential run. Fresh output paths
prevent replacing old attempts. Requested Astra High/Fast is configured provenance;
served model/tier and unpriced API-equivalent spend remain unknown/null unless
observed. There is no fallback, optional retry, Claude call or reset redemption.

Every request (including system instruction/schema), raw events, final output,
trusted hook ledger, stderr and outcome/failure is retained with hashes before
cleanup. The runner likewise saves completed competitor traces/material and all
judge attempts under each arm's git-ignored restricted `attempts/`, including
failed calls followed by successful retries. Failures stay outside results and
never fill scored resume slots. Only allowlisted call evidence is copied; auth,
personal config, environment and unrelated runtime files are excluded. Retention
failure leaves originals for recovery after removing copied auth. Incomplete or
unsealed runs block completion and must remain retained.

The restricted `build-v3.py` reproduces the set from the saved pilot bundle.
Run it with checkout root, extracted pilot directory and a fresh outside-git
destination, then hash-compare every output. `freeze-v3.mjs PRIVATE_DIR` creates
the public v3 manifest exclusively once; it never approves it. Changed bytes
require a new snapshot and fresh human approval. Keep all prior releases.
Actual calibration must precede a separately frozen/approved future baseline;
#48/#49 remain blocked.
