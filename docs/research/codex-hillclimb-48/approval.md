# #48 preparation: exact review packet, NOT APPROVED

No future baseline/candidate approval exists. This packet proposes baseline-screen
only: **12 cases × three reps = 36 keys**. The full future design is 72 paired
screen rows and 54 paired holdout rows. Zero such rows/calls have run.

Read [frozen rules](protocol.md), [membership/config](protocol.json),
[complete experiment manifest](experiment-manifest.json), [proposed argv plan](plan.json),
[exposure incident](exposure.json) and [verification](checks/summary.json).

**Do not execute this as a promotable design.** The nine reserved holdout cases
have only four primary PR groups, so their minimum exact one-sided p is 1/16:
they cannot clear the frozen 95% gate. Also the catalog-read incident prevents
certifying a blind holdout without independent provenance review. V1 can yield
REJECT or INCONCLUSIVE, never a supported PROMOTE. For an adoption-capable
experiment, prepare a new version with additional eligible blind data before
baseline outcomes; do not lower thresholds, silently replace cases or inherit
results across a changed selection. Parent review should resolve these design
limitations before asking anyone to spend a subscription run.

| Identity | SHA256 |
| --- | --- |
| Experiment manifest (complete helper/environment/config gate) | `dc42cc18e8192fbe5f7635dcf174e8dd64a17d981e55543f5a50d581815c288a` |
| Experiment protocol JSON | `12f7e74d60d582013eedce4ad0190640b68bfa24e2ee6dbf4c43d01abe88b8ba` |
| Exact generated offline plan | `a52f8cfe3e5234186062601935c95fea4b820eff6379d712b7b4e09cdb58057f` |
| Calibrated runtime, 150 members | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protected harness, 119 members | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |
| Calibration v4 protocol | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| Calibration v4 preregistration | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |
| Baseline workflow content | `e2ca7a2e86df9c78571a80952c066789affec562560f89c53e21abcbf622e3e2` |
| Sole v13 workflow content | `daf18bd39385234b4393c3a9a9c7894a77281dc4e133034b9f8dbddc23c48d8e` |

The manifest recursively binds every helper/freezer/test, normative document,
flow-state template and metadata/exposure record, installed Matt 1.3.2, npm,
locked development dependency membership and tool binaries. Calibration files,
private bytes and git-visible membership stay unchanged. `approval.md`, `handoff.md`,
`plan.json` and non-executable `checks/` are derived review/evidence artifacts,
not alternate sources of execution policy. New executable helpers or command
changes require a new manifest/complete approval gate, never an informal add-on.

Requested competitor Sol High/Fast and judge Astra High/Fast, subscription only,
configured-only identity, concurrency one. Served identity/tier, future usage and
spend remain unknown. One native invocation per key, 5,400s scoring ceiling,
4,500s app allowance, <=3 review rounds, existing bounded five app/five judge
attempts, no manual retry. For baseline screen: at most 1,800 Sol + 360 Astra
**CLI invocations** including native retries; without retries <=360 + 72.
These are not billed-request/spend guarantees. Every failure is retained and
makes adoption inconclusive. No automatic reset redemption or Claude use.

Only the five pilot cases have the complete #45 readiness audit; the other seven
screen and all nine holdout cases have metadata/object availability checks only.
Readiness failures, legitimate Node/verification/human boundaries, failing suites,
missing rg and historical timing/portability assumptions stay visible. Existing
metadata excluded dropped `pr30` and harm-excluded `clean-pr28` before freeze.
No pilot case was excluded. No source or grader changes were needed.

Reproduce offline from the repository root on this bound host:

```bash
node docs/research/codex-hillclimb-48/cli.mjs plan
node --test docs/research/codex-hillclimb-48/protocol.test.mjs
node docs/research/codex-hillclimb-48/cli.mjs gate --stage baseline-screen
node docs/research/codex-hillclimb-48/cli.mjs report --split screen
node evals/review/calibration/calibrate.mjs plan --version v4 --private /home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4
```

Expected exits: 0, 0, **2/HUMAN**, **2/INCONCLUSIVE**, 0. Offline commands make no
model or GitHub calls, read no auth bytes and create no flow/state. Strace
confirmed zero connect calls and zero credential-path opens for actual plan,
missing approval and rejection of the actual calibration approval record.
The native `run.mjs --dry-run` does access auth/GitHub and is excluded here.
The helper has no live execution or approval-writing command. Its gate is a
read-only structural match; authenticated human provenance, per-key evidence
reconciliation and the native human-approved flow gate remain separate duties.
No synthetic test approval is a real record.

After parent review/merge and independent exposure review, the parent can present
a concrete **baseline-only exploratory** request if that limited goal is still
worth measuring. Suggested wording, not a request sent or a decision recorded:

> I approve baseline-screen only for the linked #48 v1 packet and exact manifest
> SHA256 dc42cc18e8192fbe5f7635dcf174e8dd64a17d981e55543f5a50d581815c288a, protocol SHA256
> 12f7e74d60d582013eedce4ad0190640b68bfa24e2ee6dbf4c43d01abe88b8ba: 36 fresh Sol/Astra High/Fast keys,
> subscription auth, concurrency one, configured-only model identity and unknown
> served identity/tier/spend, with the stated ceilings/attempt retention. I accept
> the documented readiness conditions and exploratory-only holdout limitations.
> Independent exposure review is recorded at [real reviewer/provenance locator].
> This covers no candidate, holdout, changed hashes, Claude, resets or schedules.

Only an actual clear human response tied to this packet may later be faithfully
transcribed. The human must separately approve the fresh native flow after
review, leaving historical flow states untouched. Preparation did not create or
approve that flow. Candidate screen and paired holdout require separate later
exact scope approvals and prerequisite reports; current calibration approval is
rejected. Missing exposure clearance cannot be papered over by a synthetic JSON.

Private operational logs: `/home/ubuntu/cc-agents-artifacts/issue-48/preparation-v1`.
[Hash-only private log index](checks/private-artifact-index.json) and committed
red/green/covering/gate evidence retain the preparation. No unique model evidence
or answer-key artifact was produced, and no draft release, PR, push, comment,
watch or issue mutation was needed. Calibration evidence stays in its existing
restricted releases; see [actual v4 report](../codex-calibration-result-v4.md).
