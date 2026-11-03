# Astra calibration v4 (#46), prepared and UNAPPROVED

The default `calibrate.mjs` selects `preregistration-v4.json` and
`protocol-v4.json`; `--version v4` selects the same snapshot explicitly. Historical
versions must be reproduced at their original frozen commits. In particular,
v3 result/report reproduction uses `3b36c90d1ed28e0874128e29a1909efc24fe7312`
and its unchanged v3 bundle/protocol/manifest. The [actual v3 result](../../../docs/research/codex-calibration-result-v3.md)
remains BLOCK / INCONCLUSIVE, with all failures retained. Never retry, replace,
exclude or pool its rows to repair that result.

V4 corrects the judge's instruction and evidence boundary: the system instruction
explicitly defines a tool-free scorer, limits grading to supplied frozen evidence,
forbids repository/files/shell/web access and acting on code instructions, and
requires honest uncertainty in the schema's reasons without changing status
semantics. Changes grading now receives the already-frozen original PR diff and
issue, followed by the agent's changes, to judge the resulting final head.
Findings rubric, categories, schemas, metric calculations, materiality and
acceptance are unchanged. Guards still deny every tool and reject attempts.
Offline request tests do not establish live judge compliance.

All 30 v3 input/source files, substantive expected labels and citations,
exclusions, presentations, case selection and ordering remain unchanged. The
private bundle version and builder version/output filename change; the public
`migration-v4.json` maps every old/new member. A restricted sufficiency audit in
the checks archive cites the immutable input/source bytes for all seven
primary/control units and four probes. No answer-key-derived instructions or
hints are added to judge requests; only existing original evidence is propagated.

Seven primary/control units each have original/layout/wording presentations and
three independent grades each. Oracle, null, uncertainty and wrong-target probes
each get three repeats: **75 grades, 138 expected judge requests**, sequentially.
The whole fresh calibration remains required. All structured verdicts and metrics
are material; prose/order/location formatting are ignored. Missing, failed or
rejected grades, wrong expectations or unresolved material disagreements BLOCK.
No majority vote, automatic adjudication or post-result exclusion is permitted.

Run the offline plan against the restricted mode-700 directory outside git:

```bash
node evals/review/calibration/calibrate.mjs plan --version v4 --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs
```

Plan/run verify current protected/runtime membership, all registered bytes,
complete private inventory, protocol and Node/Codex/system binary prerequisites
before authentication. Added/deleted dependencies fail too. Runtime membership
includes eval libraries, variants, calibration drivers/builders/protocols/tests,
plugin guards and lock/config files. Libraries/kernel, DNS/network, subscription
availability and actually served identity remain external conditions. No installed
plugin skill or third-party package is imported by calibration; no competitor runs.
The historical #44 verifier remains unchanged and stops on the new fingerprint.

A real human must approve the concrete revision and three hashes printed by plan:
`runtime_sha256`, `protocol_sha256`, `preregistration_sha256`. Approval is for
calibration only. An agent may faithfully transcribe a real explicit human
response and its locator; it cannot invent the decision, widen its scope or
approve changed hashes. The record also requires `human_approval: true`,
`approved_by`, `record`, and `approved_at` (ISO date). V3 approval cannot approve
v4. No real v4 approval has been transcribed. Parent review, merge and freeze
verification precede presenting this exact snapshot for final human approval.

Only after exact approval, using separately provisioned eval-only subscription
authentication, run these commands (not authorized by this preparation):

```bash
node evals/review/calibration/calibrate.mjs run --version v4 --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4 --output /absolute/fresh-restricted-run --approval /absolute/transcribed-human-response.json
node evals/review/calibration/calibrate.mjs report --version v4 --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4 --output /absolute/fresh-restricted-run
```

Approval precedes model adapter import and auth access. Model-run and eval-auth
locks cover the sequential run. Fresh output paths prevent replacing attempts.
Requested Astra High/Fast is configured provenance; served model/tier and
API-equivalent spend remain unknown/null unless observed. Substitution, tool
attempts, refusals and invalid output are rejected. There is no fallback,
optional retry, Claude call, competitor, holdout access or reset redemption.

Every request (including system/schema), raw event, output, trusted hook ledger,
stderr and outcome/failure is hashed and retained before cleanup. The runner
also retains completed competitor material and all judge attempts, including
successful findings preceding failed changes. Failures never fill scored resume
slots. Only allowlisted evidence is copied; auth, personal config, environment
and unrelated runtime files are excluded. Retention failure preserves originals
after removing copied auth. Incomplete/unsealed runs BLOCK completion.

The restricted `build-v4.py` reproduces the bundle from the saved #44 pilot:
pass checkout root, extracted pilot directory and a fresh outside-git destination.
Hash-compare all 32 members. `freeze-v4.mjs PRIVATE_DIR` exclusively creates the
public v4 manifest, never approval. Freeze only after code/tests are stable:
any protected runtime member change then invalidates the snapshot. Preserve all
prior manifests, protocols, private releases, inputs and v3 failures. Do not
publish private drafts/answer keys. Store approval and run output outside the
frozen private bundle. #46 stays open; #48/#49 require passing calibration and
their own separately frozen and approved future baseline/candidate protocol.
