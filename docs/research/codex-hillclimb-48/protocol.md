# Frozen preparation protocol for #48 and the later #49 comparison

Version `codex-hillclimb-48-v1`, prepared 2026-11-04. This is a proposal for
review, not approval or a completed baseline. Calibration v4 PASS is a prerequisite
only. Adoption is INCONCLUSIVE. No baseline, candidate, holdout or Claude calls
are permitted by this document. The parent owns publication, approval and #49.

## Fixed sample and exposure

`protocol.json` is the exact ordered membership. All five pilot cases remain.
Screen: 12 cases, six bug / three clean / three convergence, 36 rows per arm.
Holdout: nine cases, four bug / two clean / three convergence, 27 rows per arm.
Three independent fresh sessions/replays per case/arm, repetition labels 0–2;
no shared model session or guaranteed random seed. All repetitions are scored.
Pair by case and repetition label, not by a claim of common randomness.

The screen deliberately oversamples bug cases for recall while matching clean
and convergence control counts. It covers edit/commit/doc gates, documentation,
deadline behavior and repeated review. It is a fixed purposive sample, not a
random repository benchmark. No sample-size expansion after outcomes. Additional
screen cases were selected by kind/PR identity and historical metadata, not
candidate grades. Other catalog entries and exclusions remain listed; none of
the five pilot cases is removed for readiness or quality.

Screen groups: PR12,14,16,17,18,19,24,33,35 (nine PRs). PR18 has bug/convergence,
PR19 clean/convergence, PR33 clean/convergence. Primary bug recall has six PR
groups. Holdout groups: PR20,21,26,38 (four PRs); PR20 has bug/convergence,
PR21 and PR26 each bug/clean/convergence. Primary holdout recall has four groups.
IDs and PR groups are disjoint across splits. Shared PR cases and repetitions
are never treated as independent trials. The existing dropped pr30 and harm-excluded clean-pr28 were removed on eligibility
metadata before freeze. Four holdout bug groups have a minimum one-sided exact
p of 1/16 and cannot pass 0.05. Thus v1 cannot support promotion: even otherwise
passing heldout point gains remain INCONCLUSIVE. This is a design limitation,
not permission to relax thresholds, add cases after results or claim a win.
A new protocol with new eligible blind data is needed for a promotable design.

Independence is an assumption, not a dataset fact: all cases share a repository,
libraries, historical bugs and ancestry. For example PR26's base is PR24's head;
later snapshots contain earlier product work. Disjoint PRs do not prove disjoint
defects or training exposure. No raw heldout findings, traces, adjudications,
bug records or judge responses may be opened for tuning. Metadata and hashes
may reserve cases. The exact v13 was implemented before this preparation.

**Exposure incident:** the implementer mistakenly requested the entire
`data/cases.json` with `cat` before projecting metadata. Returned text was
truncated, but labels/notes for several non-heldout families were displayed.
The reserved rows' labels were not visible in the displayed excerpt. We cannot
certify an untouched holdout from that fact: the entire catalog file was accessed,
and prior-session exposure is unknown. `exposure.json` preserves the incident.
Before baseline approval an independent maintainer must audit the session/tool
transcript and prior provenance, with a recorded conclusion about this limited
holdout. If supportable blindness cannot be established, v1 stops INCONCLUSIVE;
no swapping cases after results. A new dataset/protocol needs new review before
outcomes. Neither an agent assertion nor calibration PASS resolves this gate.

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

The manifest binds the calibrated 150-member runtime and 119-member protected
harness, calibration protocol/preregistration/private membership, this protocol,
flow-state template, numeric helper/tests/freezer, metadata/exposure records and
external environment inventory. Directory membership is verified against git,
including untracked nonignored files. Helpers stay here because they are new
experiment machinery, not dependencies of the calibrated runtime. They have their
own full approval gate; no runtime file is relocated and no protected inventory
is edited to evade verification. The actual calibration v4 plan must still pass.

Environment freeze binds platform/architecture, Node and Codex 0.166.0 including
companions, system tools, npm launcher/runtime, installed Matt 1.3.2 full tree,
selected newest Matt cache entry, and installed locked development dependencies.
`environment-files.json` records paths, membership and SHA256s without credentials.
Use only the declared CODEX_BIN, CODEX_EVAL_HOME and TMPDIR. No personal config,
memories, auth bytes or unrelated plugin cache are copied. The runner generates
isolated configs and uses the eval-only subscription login. Freeze does not
claim hermetic kernel, shared libraries, DNS/GitHub service, model service,
subscription availability, underlying clock or server snapshots. Record these
external limitations and per-stage timestamps; do not silently change binaries,
cache version, lockfiles, environment or requested configuration between arms.

## Execution and attempts, after approval only

Fresh restricted flows are reserved at the paths in `protocol.json`; no approved
state or real flow is created by preparation. The state template has null
`harness_sha`. The human approves each exact new flow after reviewing the complete
experiment packet. Existing calibration/historical `_state.json` approval is
never copied. Agent execution must not use `--approve-harness`. `run.mjs
--dry-run` authenticates and accesses GitHub; it is not an offline check.

Offline `plan` prints proposed argv only. Execute baseline screen first. Seal its
report/noise estimate before separately approving the sole candidate screen.
Only a provisional screen winner may receive separate paired-holdout approval.
Run fresh holdout baseline and the exact unchanged final v13, both three reps.
Baseline-first blocking is intentional; label pairing does not remove temporal
service drift. Report stage timing and any observed drift. Unexplained material
drift blocks comparability and promotion rather than prompting selective reruns.

Use one native runner invocation per key with `--cases ID --reps REP+1`.
Earlier reps must already have one valid row and sealed evidence. The unchanged
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
the adoption evidence INCONCLUSIVE under v1, even if native scoring later succeeds.
No discretionary replacement/regrading, majority vote or hidden failure pooling.

Case scoring ceiling 5,400 seconds includes replay, tests, agent and grading.
Agent allowance 4,500 seconds; each judge request at most 900 seconds and remaining
deadline minus five seconds. Host tests have existing 600-second process limits.
At most three review rounds; Update preserves legitimate human stops. Up to ten
Sol calls per app attempt, two Astra calls per grading attempt: up to 50 Sol +
10 Astra per key with native retries, not a promise of billed-request counts or
internal provider retry visibility. Baseline screen has 36 keys (at most 1,800
Sol + 360 Astra CLI invocations); both screen arms 72; both holdout arms 54;
entire future design 126 keys (at most 6,300 Sol + 1,260 Astra). Without retries
baseline screen has at most 360 Sol + 72 Astra. No token/output cap; the mandatory
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
Do not use the three pairwise differences per case as independent observations.
Freeze minimum practical gain 0.05 absolute recall. Threshold T = max(0.05,N).
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
Human stops are not an adverse score to suppress: independently verify their
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
inconclusive reasons. No later prompt revision inherits results, thresholds,
exclusions or holdout wins. No Opus/Fable/pilot/v3/v4 calibration grades are pooled.

## Readiness, retention and gate

Only the five pilot snapshots have the #45 full offline audit. Seven new screen
and all nine reserved holdout cases have metadata/object availability checks,
not a claim of passing tests or live readiness. The #45 matrix remains binding:
pr16-r1 retains protected Node/live verification human requirements; pr24 has
declared baseline failures; pr35-r0's five passing suites remain unverified;
clean-pr33 retains failing-suite/human evidence; conv-pr33 retains its third-round
cap and contradictory host/candidate test evidence. Preserve the missing rg,
empty Claude-home assumption, protected read-record denial, uppercase GH,
vendored declaration mismatch and historical timing limitations. No product
or fixture patch, guard relaxation or invented read credit is authorized here.

Preparation has zero live calls/grades, no measured baseline noise, unknown future
model/tier/usage/spend, and no exact future approval. The limited pilot-derived
v4 calibration PASS does not validate every new source context or guarantee live
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
local private checks hold only operational logs and hashes, no new raw answers.

The next gate is parent review/merge, unchanged v4 plan and experiment freeze
verification, independent exposure review, then a real human response bound to
the manifest/protocol/complete helper+environment identity for baseline-screen
only. Candidate and paired holdout approvals remain separate. Missing/stale/wrong
scope approval must stop before authentication, state/output creation or models.
The offline gate is a change detector; only actual human provenance grants
authorization. A synthetic record in tests is never a live approval.
