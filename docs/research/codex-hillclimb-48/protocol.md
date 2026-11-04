# Frozen v3 preparation protocol for #48 and the later #49 comparison

Version `codex-hillclimb-48-v3`, prepared from parent
`7b475390ef377fd978dc53598b7cb4cfcd2a81a1`. This is unapproved technical
correction preparation after observed partial v2 outcomes. V2 remains
INCONCLUSIVE: three scored keys, one failed, 29 unstarted, 17 native model CLI
calls. This is not a wholly blind pre-outcome design. No quality tuning,
selection/threshold/workflow change or inherited result follows those outcomes.
A whole fresh calibration v5 (75 grades / 138 expected requests) must actually
PASS before a whole fresh 33-key baseline may start, each with distinct exact
human approval. V4 PASS is historical only. No call, approved state, native flag,
resume, regrade, retry, case exclusion or replacement is authorized here.
The parent owns review, publication, final approval and #49.

## Version history, fixed sample and exposure

V1 remains reproducible at immutable commit
`36c1081983b93114073a9e334ae443f98633fbfe`, including its original manifest,
protocol, helpers, raw check bytes/hashes and incident claims. To reproduce it,
use that commit with its bound host/dependencies/private calibration inventory;
do not combine current helpers with the v1 manifest. No v1 experiment rows or
approvals exist or inherit. V2 preparation is immutable at
`b1dc97f18d46f2a54c2b1cf0a79f7a2143339f60`; actual evidence is retained at
`daa5f4bf581775c5214dc8228aedfbfdd5518136` and the parent report at `7b47539`.
Reproduce historical v2 from its commit, never current helpers. Its live-cache
membership gate remains red; no marker is removed or waived. Current paths
advance to v3 under a new manifest. `checks/` and `checks-v2/` remain unchanged;
`checks-v3/` records new evidence. All old approvals and native flag history stay
historical and cannot authorize these changed hashes.

`protocol.json` is the exact ordered membership. `deriveV2Split` in the bound
numeric helper reads only `cases.metadata.json` and immutable v1 selected membership.
It retains the 21 selected eligible cases, reserves all pilot clusters in screen,
and chooses the numerically smallest optional selected screen primary bug PR.
It moves that entire PR cluster to the front of the prior holdout. This selects
PR14 (`pr14-r0`); no truth, difficulty, grade or candidate outcome enters the rule.
The freezer independently verifies both lists against that derivation. V2 applied the rule
before its outcomes; v3 preserves its exact resulting IDs, order and gates; it does not undo
original postexposure pool selection or certify blindness.

Screen: 11 cases, five bug / three clean / three convergence, 33 rows per arm.
Holdout: ten cases, five bug / two clean / three convergence, 30 rows per arm.
All five pilot cases remain in screen. The full design remains 126 keys.
Three fresh sessions/replays per case/arm, repetition labels 0–2; no shared model
session or guaranteed random seed. All repetitions are scored. Pair by case and
repetition label, without a claim of common randomness or statistical independence.

Screen groups: PR12,16,17,18,19,24,33,35 (eight PRs). Primary bug PRs are
16/17/18/24/35. Holdout groups and primary bug PRs: 14/20/21/26/38 (five).
Bug/convergence and clean/convergence cases within a PR remain dependent.
IDs and PR groups are disjoint across splits. The existing dropped pr30 and
harm-excluded clean-pr28 remain excluded on eligibility metadata before outcomes.
The original purposive pool is retained for continuity and bug/clean/convergence
coverage, not as a random repository sample. No sample expansion after outcomes.

At G=5, minimum exact one-sided p=1/32 and lower95=min(D_g). Passing is possible
only if every primary PR gain clears T. This removes v1's four-group lattice
barrier without lowering the 95% gate; it is still low power, not adequate-power
certification. Independent-PR/common symmetric-shift assumptions remain unproved.

All cases share source/history, possible defect families and ancestry; PR26's base
is PR24's head. PR disjointness does not imply independent data. Past sessions and
training exposure remain unknown. Never open raw heldout findings, traces,
adjudications, bug records or judge responses for tuning. Fresh implementer used
only the permitted metadata projection and the supplied audits, read in full.

**Exposure correction:** original preparation requested the entire catalog before
projecting metadata. The independent audit found all 57 catalog rows in persisted
activity, with answer-bearing fields for every reserved ID. Original model-facing
truncation is unresolved; v1's displayed-excerpt claim is unverified self-report.
The original author acknowledged label/note exposure and explicitly conditioned
its split on exposure status. No recorded post-incident v13/workflow/runner/grader
quality tuning occurred in that preparation. Partial v2 outcomes have since been
observed; v3 performs the declared technical corrections only. Preserve that history.

[Incident record](exposure.json), [independent exposure audit](exposure-review.md),
[methods audit](methods-review.md) and [review provenance](review-provenance.json)
are normative inputs. These are actual independent agent audits, not human
clearance or certification. V1's extra-human-maintainer clearance was an invented
proposal, not a user requirement; v2 removes `holdout_acceptable=true` and requires
no fabricated reviewer signature. The existing real human exact-stage approval
must transparently include these provenance limits before authentication/models.

The bounded possible claim is a fixed untuned candidate validated on prereserved
non-screen PR clusters within this finite benchmark under the stated assumptions,
with shared-source, author-exposure, postexposure selection and unknown-past-exposure
limitations. No certified unseen/blind data or population independence is claimed.
A numeric pass cannot settle provenance; unsupported comparability or provenance
requires INCONCLUSIVE. Human approval cannot retroactively make the catalog blind.

## Configuration and immutable inputs

Competitor `gpt-6.1-sol`, High/Fast; judge `gpt-6-astra`, High/Fast, subscription
only, concurrency one globally across all roles, runners and stages. Exactly
`baseline` / `codex-baseline-v1` versus sole `v13` /
`codex-evidence-before-fix-v1`; content hashes are in `experiment-manifest.json`.
The baseline synthetic manifest hash alone is insufficient: the full calibrated
runner/adapter and grade bytes are separately pinned. Existing grader prompts,
schemas, metric calculations, v13 instructions and trace guards are unchanged.
Configured-only identity explicitly accepts missing response-backed model/tier;
unknown remains null. Observed substitution fails. No fallback backend or tier.

The new manifest binds the full current runtime/protected membership,
calibration v5 protocol/preregistration/private inventory/prerequisites, this
protocol, state template, source pin builder/verifier, helpers/tests, metadata,
exposure/review records and complete external environment inventory. Added or
removed runtime and helper members fail. Exact counts/hashes are in the packet.
No runtime file is relocated to evade a gate. The actual v5 plan must verify,
and the baseline `gate` recomputes the actual sealed v5 report and requires PASS
with all 75 grades and 138 calls. No conditional or historical PASS is invented.

Environment binds Node and Codex 0.166.0/companions, system tools, npm
launcher/runtime, installed locked development dependencies, and the immutable
Matt pin in `environment-files.json`. New pinned flows never discover or bind
mutable installed-cache membership/newest version. The pin is constructed
outside git from exactly the original expected 176 members: 175 regular files,
three executable, plus relative `AGENTS.md -> CLAUDE.md`. Original bytes and
source modes are checked; only that declared member projection is copied.
The control manifest is outside the plugin root. Sealed regular modes 0400/0500
and directory mode 0500 are bound, with file kinds, exact membership, byte hashes
and literal/resolved relative link target. Safe links remain relative in the run
copy. No credentials/personal configuration are copied; installed cache, leases,
settings and auto-update are untouched.

`CC_AGENTS_MATT_PLUGIN_DIR`, bound flow `matt_plugin` and manifest hash must agree.
Validation runs before setup/auth/native approval writes; run-copy verification
runs before adapter use. Invalid/missing pins cannot fall back to live cache.
Only legacy flows declaring neither option retain legacy newest-cache behavior.
Do not introduce a general `.in_use` exemption into an old or new gate. Read-only
modes prevent accidental writes, not hostile same-uid races: the operator controls
the private parent and permits no concurrent writer during use.

Only `active_model` and `token_usage` are removed from audit events in the grader's
copy of the typed workflow, before rendering. Every audit record/order, tool
input/response, hook denial/error, unknown semantic field, finding/disposition,
test result and human stop survives. The full original workflow/events/provenance
and retained raw hook/provider evidence remain intact. GitHub material collection
and its suffix are unchanged. No marker parsing occurs in production. All
competitor instructions/prompts/control flow and judge rubric/schemas/metrics
remain unchanged; this is harness rendering, not outcome-based quality tuning.

All four retained SCREENED requests were checked offline. The happened failed
request becomes 1,040,422 characters (8,154 headroom); raw prompt hash and v2
failure stay unchanged. This does not guarantee capacity for future legitimate
payloads. Native requests above 1,048,576 Unicode scalars fail locally with the
full request/failure retained and no fabricated provider call. No truncation,
summary model, lossy compression, tool-enabled judge, fallback or case exclusion.
Offline acceptance is neither live compliance nor grader-quality evidence.

Use only declared environment variables. Kernel/shared libraries, DNS/GitHub,
subscription availability, clocks and served snapshots remain external. Record
these limits and stage timestamps; do not silently change inputs between arms.

## Execution and attempts, after approval only

Fresh restricted flows are reserved at the paths in `protocol.json`; no approved
state or real flow is created by preparation. The state template has null
`harness_sha`. The human approves each exact new flow after reviewing the complete
experiment packet. Existing calibration/historical `_state.json` approval is
never copied. Agent execution must not use `--approve-harness` without fresh explicit human
delegation for this exact v3 first key; the historical v2 delegation is insufficient.
After an actual exact baseline approval, an authorized operator may create only
the fresh restricted screen flow and install the unapproved template as
`_state.json`; preserve the null harness_sha. The human reviews the exact manifest,
helper/environment identities, state and first baseline-screen key argv. Only the
human may append `--approve-harness` to that exact first key command from plan.json
and run it personally from the repository root with the frozen environment.
This native flag writes harness_sha and then proceeds to authentication/execution
of that key; it is not an offline approval-only command. That first key must not
then be invoked again. Retain its approval provenance and all evidence; subsequent
agent invocations use the unchanged plan without the flag after per-key preflight.
The native digest is narrower than the experiment manifest, so neither replaces
the other. Candidate and holdout stages still require their separate real exact
scope approvals; holdout is a distinct fresh native flow requiring its own human
review. No agent writes an approved state, copies a historical approval, or uses an
execution helper to bypass this sequence. `run.mjs --dry-run` authenticates and accesses GitHub; it is not an offline check.

Offline `plan` prints proposed argv only. Execute baseline screen first. Seal its
report/noise estimate before separately approving the sole candidate screen.
Only a provisional screen winner may receive separate paired-holdout approval.
Run fresh holdout baseline and the exact unchanged final v13, both three reps.
Baseline-first blocking is intentional; label pairing does not remove temporal
service drift. Report stage timing and any observed drift. Unexplained material
drift blocks comparability and promotion rather than prompting selective reruns.

Use one native runner invocation per key with `--cases ID --reps REP+1`.
Earlier reps must already have one valid row and sealed evidence. The native
runner skips those rows, producing exactly the next repetition. Plan order is
native catalog order, then rep 0–2. Before each invocation, independently check
that all lower reps are present/valid, the current key has no prior attempt/error,
the new command's argv and state exactly match the approved plan, and global
concurrency is one. After it finishes, validate rows, error sidecars and all
per-attempt indexes before the next command. Do not batch unchecked commands.
The binding key is protocol content identity / split / arm / case / repetition;
the native within-flow key is `(prompt_id, rep)`. A success row without complete
trace/ref/judge/attempt artifacts is incomplete, even if the CLI exits zero.

No manual retry of a failed or uncertain-start key. On interruption, resume only
provably unstarted keys after inventory reconciliation. Existing runner retry
behavior is frozen: at most five app attempts plus five grading attempts per
key, only transient 429/529/5xx/overload/rate-limit, jittered exponential backoff
bounded by the case deadline. A whole app retry can create another private replay;
a grading retry can repeat a completed first grade. All remain separate retained
attempts; successful retries never erase failure evidence. A failed attempt makes
the adoption evidence INCONCLUSIVE under v3, even if native scoring later succeeds.
No discretionary replacement/regrading, majority vote or hidden failure pooling.

Case scoring ceiling 5,400 seconds includes replay, tests, agent and grading.
Agent allowance 4,500 seconds; each judge request at most 900 seconds and remaining
deadline minus five seconds. Host tests have existing 600-second process limits.
At most three review rounds; Update preserves legitimate human stops. Up to ten
Sol calls per app attempt, two Astra calls per grading attempt: up to 50 Sol +
10 Astra per key with native retries, not a promise of billed-request counts or
internal provider retry visibility. Baseline screen has 33 keys (at most 1,650
Sol + 330 Astra CLI invocations); both screen arms 66; both holdout arms 60;
entire future design 126 keys (at most 6,300 Sol + 1,260 Astra). Without retries
baseline screen has at most 330 Sol + 66 Astra. No token/output cap; the mandatory
`--budget-usd 40` argument is a legacy Claude limit and does not price/cap Codex.

Deadline scoring rejection drains in-flight retention/cleanup before the next
slot; cleanup can outlive the scoring ceiling. The parent must stop on retention,
identity, answer-key, guard or environment problems and retain the whole failed
run. Do not force-delete evidence or replay repositories. Normal native cleanup
uses only scoped eval repositories after approval; failures/leftovers are recorded.
No source repo write privilege is accepted by the runner's existing negative
scope probe. Preparation checks login/namespace/file metadata only, not secrets
or live eval-token write probes. No resets, Claude or schedule changes.

## Metrics, uncertainty and fixed decision rules

Use unchanged native grades. Primary recall is restricted to bug-kind cases:
unique known in-diff bugs found / known in-diff bugs, not finding count. Missing
recall is invalid, never zero; clean recall is not applicable. Each case first
averages its three repetitions, then cases average within underlying PR, then PR
groups get equal weight. Convergence recall is reported separately, not an extra
independent copy of its bug case. Also report every case's final-head fixed
fraction, reintroduced fraction, harmful/wrong and noise counts, precision where
defined, review rounds/first clean round, asked_human, before/after host tests,
test logs/dispositions, hook denials, failures, latency and known usage coverage.
The numeric helper is a summary; raw-evidence review is still required.

For primary PR group g, let B_gr be baseline recall (average eligible cases in
that PR for each rep), and let D_g be the mean paired v13-minus-baseline recall
over cases/reps in that PR. Noise N is the equal-PR mean of each case's baseline
`max(rep recall) - min(rep recall)` (case ranges average within PR first).
Three repeats give a descriptive observed floor, not a population variance bound.
Before candidate results exist, the validated baseline report publishes each primary
case's raw recalls in rep0/1/2 order and min/max/range; each primary PR's
per-repetition case mean; the three equal-PR macro recalls and their min/max/range.
This empirical descriptive variability supplies no population confidence coverage
from three repetitions or proof of PR independence. The macro recall range is
reported separately from N and does not replace it. Incomplete or invalid baseline
key/metric/native identity/provenance/evidence/failed-attempt validation withholds
baseline.complete and all validated aggregates/noise/variability (null), with
scheduled, received and valid-key denominators and reasons. Missing/invalid
candidate rows do not invalidate an otherwise complete valid baseline. The same
validation contract runs before normalized-row and native-report aggregation.
Per-case known counts use unique valid scheduled rows; invalid raw numeric rows
and evidence locators remain visible without manufacturing scores. Test coverage
reports known/scheduled and observed pass/fail counts, not a claim of readiness.

Do not use the three pairwise differences per case as independent observations.
Retain the discretionary minimum practical gain 0.05 absolute recall, as chosen
before outcomes to require a five-point meaningful improvement. Threshold T = max(0.05,N).
Screen and holdout each use their own fresh baseline N with this same formula.

Uncertainty: enumerate all 2^G sign flips of the G PR differences under the
explicit independent-cluster, common symmetric location-shift assumption. The
one-sided p at shift theta is the fraction of signed centered means at least as
large as the observed centered mean. Equivalently, count the empty subset plus
all nonempty subsets whose mean D is <= theta, divided by 2^G. The one-sided 95%
lower bound is the first theta where p(theta) >= 0.05, clipped below at -1;
if the empty subset alone exceeds alpha the bound is -1. Ties count against
promotion. This exact finite enumeration avoids Monte Carlo randomness; it is
conditional inference under symmetry, not a randomized trial or a claim that
PR clusters are independent in reality. Report G, differences, p and lower bound,
baseline ranges and all per-case values. Shared-source dependence and small G
remain serious limits. Worked analytic examples are tested independently.

Numerical PASS requires mean(D) > T **and** lower95 > T; every paired clean
case/rep must have v13 harmful <= baseline; every case/rep must have v13 rounds
<= baseline. Additionally no paired decrease in fixed fraction, increase in
reintroduced fraction, or new host true-to-false test break is accepted.
No missing metric or changed metric coverage can imply success. Harm and rounds
use observed per-key non-increase, not a claim of population noninferiority.
These per-key dominance rules and any-failed-attempt INCONCLUSIVE are deliberate
strict policy choices retained by the parent, beyond the issues' minimum rules.
They can reject equal-mean stochastic arms due to rep pairing and can withhold
adoption after a successfully recovered bounded retry. Do not call those costs
issue-mandated or change them after outcomes. Human stops are not an adverse score to suppress: independently verify their
legitimacy and preservation of rejected findings, unresolved decisions and tests.
An illegitimate disappearance blocks adoption. Latency/usage are descriptive:
quality/latency precede token savings; no post-result latency cutoff is introduced.

Complete comparable evidence with a point gain <= T or a harm/round/fix/regression/
test violation is REJECT. Positive point gain above T but inadequate uncertainty
is INCONCLUSIVE. Any missing/duplicate/truncated/invalid row, failed attempt,
unresolved identity/exposure/retention/readiness/security issue is INCONCLUSIVE,
with the denominator/gap reported. Screen PASS is provisional only. PROMOTE is
allowed only after both splits pass for the exact unchanged final v13 and the
independent evidence/human-stop review is recorded. Otherwise reject or report
inconclusive reasons. These preparation choices grant no population guarantee. No later prompt revision inherits results, thresholds,
exclusions or holdout wins. No Opus/Fable/pilot/calibration or historical v2 baseline grades are pooled.

## Readiness, retention and gate

Only the five pilot snapshots have the #45 full offline audit. Six new screen
and all ten reserved holdout cases have metadata/object availability checks,
not a claim of passing tests or live readiness. The #45 matrix remains binding:
pr16-r1 retains protected Node/live verification human requirements; pr24 has
declared baseline failures; pr35-r0's five passing suites remain unverified;
clean-pr33 retains failing-suite/human evidence; conv-pr33 retains its third-round
cap and contradictory host/candidate test evidence. Preserve the missing rg,
empty Claude-home assumption, protected read-record denial, uppercase GH,
vendored declaration mismatch and historical timing limitations. No product
or fixture patch, guard relaxation or invented read credit is authorized here.

This v3 preparation has zero new live calls/grades, no measured baseline noise, unknown future
model/tier/usage/spend, and no exact future approval. The limited pilot-derived
future v5 calibration PASS would not validate every new source context or guarantee live
judge compliance. Insufficient context requires uncertainty, never invented facts.
Material runtime/prompt/rubric/workflow/selection changes invalidate comparability
and require a new version, review/approval and fresh relevant calibration/baseline.

Retain fresh mode-700 directories and mode-600 files outside every git worktree,
umask 077 during future execution. Seal complete per-attempt requests, schemas,
raw events, hooks, outputs, stderr, outcomes and errors plus exact sizes/hashes,
CLI argv/env allowlist, timestamps, exit statuses, source/config identities and
all results. Include app successes that precede grading failures. Reconcile
all attempts with keys and usage; unknown usage/cost is null, not zero. Existing
`latency_s` measures only final app attempt; separately retain whole invocation
wall time, grading/retry/cleanup time where known. Do not add overlapping usage
hook diagnostics to authoritative usage. No billable-total claim without coverage.

Keep raw inputs/answer keys out of public git and away from the competitor;
tool-free judging uses only supplied evidence. Public indexes are hash-only.
Use an unpublished maintainer-only draft release with verified fresh download
if raw evidence needs remote retention; never auto-publish or overwrite earlier
releases. This preparation's source/config/checks are committed and reproducible;
private correction evidence includes the restricted projected screened request
and migrated version-only calibration bundle, never new live answers.

The next gate is parent review/merge, v5 and v3 frozen-identity verification,
then distinct real human approvals for calibration v5 and baseline v3. The parent
may present both packets in one conditional question, with baseline execution
strictly conditional on actual v5 PASS. A calibration-only response never covers
baseline. No response, conditional PASS or native delegation is invented here.
Whole fresh 33-key baseline only; no 29-key resume or failed-key replacement. Candidate and paired holdout approvals remain separate. Missing/stale/wrong
scope approval must stop before authentication, state/output creation or models.
The offline gate is a change detector; only actual human provenance grants
authorization. A synthetic record in tests is never a live approval.
