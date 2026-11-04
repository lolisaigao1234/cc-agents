# #48 v2 baseline-screen actual preflight: blocked before execution

**0 completed, 0 failed model keys, 33 unstarted. Baseline incomplete; adoption
INCONCLUSIVE.** The approved baseline did not start. On 2026-11-04 the actual
offline experiment plan failed because the provided worktree has no
`node_modules` directory. The frozen inventory requires 257 members there.
The exact-stage gate and report CLI independently encountered the same failure.
No dependency installation, symlink, substituted working directory, changed
environment, gate bypass or model run was used to recover.

This is an operational stop report, not a baseline quality result. No candidate
gain, selection or promotion can be inferred. Candidate and holdout remain outside
the approval. The parent owns subsequent status and PR/issue handling.

## Approval, ancestry and the blocking gate

The worktree began clean at approved integration commit
`b1dc97f18d46f2a54c2b1cf0a79f7a2143339f60`, on
`t3/issue48-v2-baseline-screen`. Ancestry was confirmed. Both the local parent
`43-codex-calibration-v3-followthrough` and its freshly fetched remote tip were
merged before work and again before handoff preparation; both merges were already
up to date at that commit. No push or PR/issue mutation was performed.

The existing real approval record was read and verified, not recreated:

- Record: `/home/ubuntu/cc-agents-artifacts/issue-48/approval-v2-baseline-screen-20261104.json`.
- SHA256: `30d4af0b48049654c2095170fd53630a6772e89c93082296217d939fb0012a19`.
- Human response: **“Approve baseline and delegate native flag”**, at
  `2026-11-04T19:21:54.768Z`, bound to the exact linked packet and first key.

The grant covers the 33 baseline-screen keys and the first planned
`pr16-r1/rep0` invocation with `--approve-harness`. It accepts the packet's catalog
exposure, postexposure pool selection, shared-source/history, unknown past
exposure, low-power and conditional inference limits. It covers no candidate,
holdout, changed hashes, Claude, resets or schedules. No new decision or approval
was requested. The delegated flag was **never invoked** because the earlier
environment gate failed. There is no native digest or digest provenance to claim.
The null-harness template remains unchanged; no approved state was written/copied.

All four offline CLI commands used the plan's exact environment values:
`CODEX_BIN=/home/ubuntu/.codex/packages/standalone/releases/0.166.0-aarch64-unknown-linux-musl/bin/codex`,
`CODEX_EVAL_HOME=/home/ubuntu/.config/trace-eval/codex`, `TMPDIR=/tmp`,
`PATH=/usr/local/bin:/usr/bin:/bin`, `LANG=C.UTF-8`, `TZ=UTC`.
Only those allowed values were logged; credential values and personal config
were not read, printed or copied by the operator.

| Actual offline command | UTC start–finish, 2026-11-04 | Exit / result |
| --- | --- | --- |
| `cli.mjs plan` | 19:26:44.113–19:26:44.955 | 2; missing dependency directory |
| `cli.mjs gate --stage baseline-screen --approval <existing-record>` | 19:27:12.563–19:27:13.381 | 2; same environment failure, before approval check |
| `calibrate.mjs plan --version v4 --private <declared-v4-path>` | 19:27:13.381–19:27:14.157 | 0; unchanged snapshot/prerequisites verify |
| `cli.mjs report --split screen` | 19:27:14.157–19:27:14.971 | 2; same environment failure |

The concrete stderr is:

```text
ENOENT: no such file or directory, scandir '/home/ubuntu/.t3/worktrees/cc-agents/t3-ddc7f439/node_modules'
```

The mandatory *actual generated plan stdout* could not reproduce the approved
SHA256: stdout was empty, SHA256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Matching the committed plan file does not substitute for that failed gate.
The parent's prior successful verification in its environment was not reused as
an execution clearance in this worktree.

| Identity independently checked | SHA256 / membership |
| --- | --- |
| Experiment manifest | `86feea45091c2a86e2d1ac545b7b4abb48202548e74a3ae80182844188f5ca22` |
| Protocol JSON | `8dc56d50a31612f72f6d80ffb1237030869c72a79ad1332404523cfb788c3090` |
| Stored approved plan file, not actual generated stdout | `9401adab8086fc74a939b2e7e894bb87902416e9335164e07526fe97f70eaedf` |
| Calibrated runtime | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5`; 150 unchanged members |
| Protected harness | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144`; 119 unchanged members |
| V4 calibration protocol | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| V4 preregistration | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47`; 32 private members verify |

The 14 normative experiment inputs verify with unchanged membership/bytes.
V4 snapshot verification and its offline plan pass; the existing actual v4
calibration PASS is unchanged and was not rerun or pooled. Experiment environment
verification remains blocked. Source, runtime, rubric, workflows, tests, helpers,
protocol, manifest and configuration were not changed. No file was added inside
the bound experiment directory. No new tests or broad test reruns were performed;
the existing 14 protocol / 83 covering passes are historical preparation evidence.

## Denominators, metrics and case limits

The existing read-only `nativeReport` public interface was also called on the
nonexistent screen flow as an explicitly labelled **empty-flow component
diagnostic**. It returns `baseline.complete=false`, scheduled 33, received 0,
valid keys 0, and null validated aggregates/noise/variability. This does not
replace the failed experiment CLI gate or claim an execution report passed.
The paired report is INCONCLUSIVE with missing baseline and candidate keys;
missing candidate keys alone would be expected after a valid baseline, but here
the baseline itself never started.

Each case has completed/failed/unstarted **0/0/3**, with all repetition labels
0, 1 and 2 provably unstarted. The restricted disposition lists every exact
protocol/split/arm/case/rep key in approved order.

| Case | Kind | Recall rep0 / rep1 / rep2 | Min / max / range | Retained readiness limit |
| --- | --- | --- | --- | --- |
| pr16-r1 | bug | null / null / null | null / null / null | Pilot audit retains protected Node/live human verification requirements |
| pr17-r0 | bug | null / null / null | null / null / null | Metadata/object checks only; live readiness unestablished |
| pr18-r0 | bug | null / null / null | null / null / null | Metadata/object checks only; live readiness unestablished |
| pr24 | bug | null / null / null | null / null / null | Pilot audit retains declared baseline test failures |
| pr35-r0 | bug | null / null / null | null / null / null | Pilot audit leaves five claimed passing suites unverified |
| clean-pr12 | clean | not applicable | not applicable | Metadata/object checks only; live readiness unestablished |
| clean-pr19 | clean | not applicable | not applicable | Metadata/object checks only; live readiness unestablished |
| clean-pr33 | clean | not applicable | not applicable | Pilot audit retains failing-suite/human evidence |
| conv-pr18 | convergence | null / null / null | null / null / null | Metadata/object checks only; live readiness unestablished |
| conv-pr19 | convergence | null / null / null | null / null / null | Metadata/object checks only; live readiness unestablished |
| conv-pr33 | convergence | null / null / null | null / null / null | Pilot audit retains third-round cap and contradictory host/candidate test evidence |

All five primary PRs (16, 17, 18, 24, 35) have null per-repetition case means.
The PR-weighted primary recall, baseline noise floor N, three macro per-rep recalls
and their min/max/range are all **null**, with primary valid/scheduled rows 0/15.
There is no descriptive uncertainty estimate or population confidence claim.
No threshold is manufactured from missing data. Convergence remains separate.

Final-head fixed/reintroduced fractions, harmful/wrong counts, finding noise,
precision, rounds, first clean round, asked-human, hook denials, final-app latency
and token metrics all have known/scheduled coverage **0/33** (0/3 per case) and
null summaries. Before/after host-test coverage is separately **0/33** each;
zero observed passes and zero observed failures describe absent observations.
There are no test logs, rejected-finding dispositions or human-stop decisions to
review. No human stop was suppressed or readiness condition treated as waived.
Missing rg, empty-Claude-home assumptions, protected read-record denial,
uppercase GH, vendored declaration mismatch and historical timing limitations
remain as disclosed in the frozen packet; none was repaired or credited here.

Native runner invocations: **0**. App attempts: **0**. Judge attempts: **0**.
Failed model attempts: **0**. Scored rows: **0**. Model CLI invocations: **0**.
Diagnostic model-hook records: **0**. These are separate counts, not overlapping
usage or billed-request totals. Four offline CLI processes and one read-only
component diagnostic are operator work, not model requests.

Requested identity remains Sol High/Fast and Astra High/Fast, subscription-only,
configured-only, concurrency one. Observed served model/tier and API-equivalent
spend are **unknown/null**; there are no response-backed observations or usage
records. No authentication/model execution was reached, so neither the global
model-run lock nor native eval-auth lock was acquired. No competing evaluation
was launched by this operator. No replay, app success, judge failure, attempt
index, raw provider event, request, trace, ref, judge input, error sidecar, flow or
`_state.json` was created. There is no scoped cleanup or leftover attributable
to this stage; unrelated repositories and historical evidence were untouched.

## Restricted retention

The fresh [unpublished maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-a4fda5e28275889b97da)
retains the original failed preflight logs, exact argv/allowed environment,
timestamps/exits, approval record, source checks, issue snapshot, empty-flow
diagnostic and all 33 unstarted-key identities. **Never publish automatically.**
Earlier releases and calibration evidence were not modified or copied.

- Tag: `cc-agents-48-baseline-v2-blocked-20261104-192644`.
- Asset: `codex-baseline-v2-blocked-20261104.tar.gz`, ID **710653404**,
  **15,942 bytes**.
- Archive SHA256: `2136123cf8e295d92f75f7e944fd4dcc4dfc10a089d5406f248f8b8dfe53446e`.
- Fresh download matched the archive hash and every member: **47 files**, one
  directory; `SHA256SUMS` independently covers the other **46** files.
- Credential-pattern scans of the allowlisted originals and all downloaded file
  members found zero matches. No credential/config/personal file, symlink or
  hardlink was archived. Directories are mode 700, files mode 600, umask 077.

The [hash-only artifact index](codex-hillclimb-48-results-v2/artifact-index.json)
contains retrieval metadata and exact member paths/sizes/hashes. Local originals
are at `/home/ubuntu/cc-agents-artifacts/issue-48/baseline-v2-20261104-evidence`;
post-seal release/download receipts are in its `retention/` directory. The fresh
verified download is in sibling `baseline-v2-20261104-download`. Raw approval
provenance and operational logs stay restricted; public git contains only this
sanitized report and hashes/retrieval pointers.

Retrieve with maintainer access into a fresh mode-700 directory outside git:

```bash
gh release download cc-agents-48-baseline-v2-blocked-20261104-192644 --repo lolisaigao1234/cc-agents --pattern codex-baseline-v2-blocked-20261104.tar.gz --dir /absolute/fresh-private-download
```

Verify the archive hash and every member against the public index before use.
This archive contains no baseline grades or answer keys.

## Next prerequisite

The parent must provide an execution worktree whose installed dependency tree
matches the existing bound 257-member inventory. The actual offline plan must
then reproduce the approved stdout hash and the exact-stage gate must pass with
the existing real approval record before flow creation/authentication. No new
human decision is needed merely to reuse unchanged approved identities; changes
remain outside that grant. The first key and its delegated native flag are still
unstarted. Preserve the fresh-flow, per-key reconciliation and no-manual-retry
rules if execution later proceeds. Candidate selection stays withheld; #48 has
no completed baseline, #49's later gate is unmet, and adoption is INCONCLUSIVE.
