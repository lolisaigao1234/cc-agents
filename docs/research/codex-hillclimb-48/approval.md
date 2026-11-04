# #48 v2 exact baseline review packet — NOT APPROVED

Proposed first stage: **11 cases × 3 repetitions = 33 baseline-screen keys**.
Later candidate screen has 33 keys; paired holdout has 30+30. Total 126 keys.
Zero experiment rows/calls exist; no v1 outcomes or approvals inherit. Parent
review/merge and a real human exact baseline-only response remain required.

Read [rules](protocol.md), [config/membership](protocol.json),
[complete manifest](experiment-manifest.json), [exact proposed argv](plan.json),
[exposure correction](exposure.json), [independent exposure audit](exposure-review.md),
[methods audit/dispositions](methods-review.md), [review provenance](review-provenance.json)
and [v2 checks](checks-v2/summary.json). The [handoff](handoff.md) identifies the work.

V1 is preserved at immutable commit `36c1081983b93114073a9e334ae443f98633fbfe`,
including its original helpers/manifest and byte-identical `checks/`. Reproduce
that version from that commit, with the bound dependencies and private calibration
inventory. Current helpers are v2 and must not be paired with v1 hashes. V1 had
no experiment outcomes or approvals. The environment inventory is reused unchanged;
no 9,000-line dependency-tree duplication or calibrated-runtime changes were needed.

| Identity | SHA256 |
| --- | --- |
| V2 complete experiment manifest | `86feea45091c2a86e2d1ac545b7b4abb48202548e74a3ae80182844188f5ca22` |
| V2 protocol JSON | `8dc56d50a31612f72f6d80ffb1237030869c72a79ad1332404523cfb788c3090` |
| V2 exact generated offline plan | `9401adab8086fc74a939b2e7e894bb87902416e9335164e07526fe97f70eaedf` |
| Calibrated runtime, unchanged 150 members | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protected harness, unchanged 119 members | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |
| Calibration v4 protocol | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| Calibration v4 preregistration, including 32 private members | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |
| Baseline workflow content, unchanged | `e2ca7a2e86df9c78571a80952c066789affec562560f89c53e21abcbf622e3e2` |
| Sole v13 workflow content, unchanged | `daf18bd39385234b4393c3a9a9c7894a77281dc4e133034b9f8dbddc23c48d8e` |

The manifest binds 14 normative input files: source/helpers/tests, protocol,
metadata, state template, exposure and actual independent review provenance,
and the unchanged full environment inventory. The verifier detects altered bytes
and new input membership; it also derives the split from immutable v1 plus metadata.
`approval.md`, `handoff.md`, `plan.json`, `checks/` and `checks-v2/` are derived
review/evidence artifacts, not alternate execution policy. Any new normative
helper/command or changed code requires a fresh manifest and exact approval.
No informal execution helper or approval-writing command exists.

The pre-outcome metadata rule retains the original 21 selected eligible cases and
all five pilots, moving the whole numerically smallest optional selected primary
bug PR (PR14) to holdout. Screen is 5 bug/3 clean/3 convergence; holdout is 5/2/3.
Primary PR groups are 5+5 and PR-disjoint. At five groups the unchanged one-sided
95% sign-flip lower endpoint is min(D_g): every PR gain must exceed
T=max(.05, observed baseline repeat-range N). Feasibility is not adequate power.
Independent PRs and common symmetric shifts are assumptions, not established facts.
Strict paired harm/round/fix/regression/test gates and any-failed-attempt
INCONCLUSIVE policy remain unchanged, with their discretionary costs disclosed.

**Exposure limits must be included in any future human execution request.** The
persisted incident contains all 57 catalog rows and answer-bearing fields for all
reserved IDs. Original model-facing truncation remains unresolved. Original author
label/note exposure and exposure-conditioned pool/split selection are recorded.
No recorded post-incident candidate/workflow/runner/grader change or observed
experiment outcomes exist. Shared source/history, crossing ancestry and unknown
past exposure limit interpretation. No certified unseen/blind data, population
independence or adequate-power claim is supportable. The bounded possible claim
is a fixed untuned candidate validated on prereserved non-screen PR clusters within
this finite benchmark, conditional on stated assumptions and comparability.
Numerical PASS cannot settle provenance. Unsupported interpretation is INCONCLUSIVE.

The actual independent agent audits are bound records, not human clearance. V1's
extra independent-human-maintainer review was an agent-invented proposal; no such
review is fabricated or required via `holdout_acceptable=true`. The existing real
human exact-stage approval, with authenticated source/stage/hash, remains binding.
Nothing in this packet is an approval or a certification that exposure is acceptable.

Requested Sol High/Fast, Astra High/Fast, subscription only, configured-only model
verification, concurrency one. Served model/tier, usage and spend remain unknown.
Per key: one native invocation, 5,400s scoring ceiling, 4,500s app allowance,
<=3 reviews, bounded five app/five judge attempts and zero manual retries.
33 baseline keys allow at most 1,650 Sol + 330 Astra CLI invocations including
native retries, or 330+66 without retries. These are not billed-request guarantees.
Every failure stays retained. No Claude, reset redemption or schedule changes.

Five pilot snapshots have #45's full readiness audit; the other six screen and all
ten holdout cases have metadata/object checks only. Preserve legitimate human stops,
failing tests, missing rg and all #45 portability/timing/verification conditions.
Do not drop a case or weaken a gate because of later readiness or quality outcomes.
A complete valid baseline alone reports its raw recall triples, case ranges,
PR repeats and macro repeat spread. These are descriptive variability, not
three-repetition population confidence coverage. Invalid baseline evidence
withholds validated aggregates/noise/completeness; absent candidates do not.

Offline reproduction from this committed revision on the bound host:

```bash
node --test docs/research/codex-hillclimb-48/protocol.test.mjs
node docs/research/codex-hillclimb-48/cli.mjs plan
node docs/research/codex-hillclimb-48/cli.mjs gate --stage baseline-screen
node docs/research/codex-hillclimb-48/cli.mjs report --split screen
node evals/review/calibration/calibrate.mjs plan --version v4 --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4
```

Expected exits: 0 (14 tests), 0, 2/HUMAN, 2/INCONCLUSIVE, 0 (v4 verification).
Covering suite: `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`
passes 83/83, zero skips. V4 plan output is byte-identical; actual calibration PASS
is unchanged, not rerun. Two historical broad-suite failures and 55 typecheck
diagnostics remain disclosed; those broad checks were not rerun.

[Traced gates](checks-v2/gate-proof.json) show plan exit 0; missing approval,
actual calibration approval and actual immutable v1 manifest passed as an approval
all reject with exit 2/HUMAN. No actual v1 approval ever existed; stale exact hashes
and wrong scope are separately rejected by explicitly synthetic public-interface
tests. All six traced CLI checks have zero network connect calls and zero credential
path opens. Both empty split reports are INCONCLUSIVE with null noise. No real flow
or state exists. `run.mjs --dry-run` authenticates/accesses GitHub and was not used
as an offline approval procedure.

After parent review/merge, the parent may present the following concrete request
with the committed revision link. This is proposed wording only, not a request
sent by this implementer and not a decision recorded:

> I approve baseline-screen only for #48 codex-hillclimb-48-v2, exact manifest
> SHA256 86feea45091c2a86e2d1ac545b7b4abb48202548e74a3ae80182844188f5ca22 and protocol
> SHA256 8dc56d50a31612f72f6d80ffb1237030869c72a79ad1332404523cfb788c3090:
> 33 fresh Sol/Astra High/Fast keys, subscription authentication, concurrency one,
> configured-only identity, unknown served model/tier/spend, with the frozen ceilings
> and attempt/evidence policy. I understand the documented readiness limits,
> original author label/note exposure, unresolved original response truncation,
> postexposure pool selection, shared-source/history and unknown prior exposure.
> Any later comparison supports only the stated conditional finite-benchmark claim,
> with unproved PR independence/common-shift assumptions and low power; it does not
> certify unseen/blind data or population independence. The actual independent agent
> provenance/methods audits are records, not human clearance. This covers no
> candidate, holdout, changed hashes, Claude, resets or schedules.

Only an actual clear human response can be faithfully recorded as approval.
Afterward, follow the [native human approval procedure](protocol.md): create only
the fresh restricted screen flow with the null-harness template; the human reviews
and personally runs the exact first planned baseline key with `--approve-harness`.
That flag writes the native digest and proceeds to execution of that key. It is
not an offline approval-only command and must never be invoked by the agent.
Do not rerun that first key. Subsequent approved keys use the plan without that
flag after evidence reconciliation. The experiment gate and native digest are
both required. Candidate and paired-holdout approvals remain separate stages;
the latter uses a distinct fresh native flow. No approved state has been written.

Operational proof is retained at
`/home/ubuntu/cc-agents-artifacts/issue-48/preparation-v2`, with a
[hash-only index](checks-v2/private-artifact-index.json). No unique personal/raw
model artifact was produced; committed source and hashes suffice, so no draft
release was created. All v1 checks remain unchanged, including six trailing-
whitespace lines in three raw red logs. Scoped whitespace checks exclude retained
raw logs; no blanket green claim is made. No push, PR mutation, comment, watch,
issue mutation, model/eval-authentication call or remote replay was performed.
