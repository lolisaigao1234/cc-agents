# #48 implementation handoff: preparation complete, execution unapproved

This worktree began clean and exactly at parent merge
`bd1ce2c4d6823fd4d0306c845aa2c5551788b513` (merged PR #51). Required ancestry
was checked before work. Both local and freshly fetched
`43-codex-calibration-v3-followthrough` tips at
`7d3d2a7b818b14045a7a6ccf0eb8991bed489339` were merged before handoff:
both were already ancestors. No other branch, tstack work, source eval checkout,
credentials, personal configuration, schedules or prior artifacts were changed.

Deliverables are [exact review/approval packet](approval.md),
[frozen rules](protocol.md), [membership/config](protocol.json),
[complete manifest](experiment-manifest.json), [offline plan](plan.json),
[read-only CLI](cli.mjs), [numeric analysis](protocol.mjs),
[public-interface tests](protocol.test.mjs) and [check ledger](checks/summary.json).
No protected README or calibrated runner/grader/schema/metrics/v13 bytes changed.

## Sample and material limits

- Screen: 12 cases, 6 bug / 3 clean / 3 convergence; three reps per arm, 36
  baseline keys, later 36 candidate keys. Nine PR groups, six primary bug groups.
  All five pilot cases remain, including their human stops and failing tests.
- Reserved holdout: nine IDs, 4 bug / 2 clean / 3 convergence; three reps per
  arm, later 27 + 27 keys. Four PR groups, all disjoint from screen groups.
- The full proposal has 126 keys; none has run. Known-eligible dropped/harm
  flags excluded pr30/clean-pr28 before freeze; no outcome-dependent exclusions.
- **The holdout is underpowered for promotion:** four primary PR groups give
  minimum exact p=1/16, exceeding .05. V1 cannot support PROMOTE. A new version
  with additional eligible blind data must precede any adoption-capable baseline.
- **Blindness is uncertified:** the implementer accidentally requested the full
  catalog before projecting metadata. The displayed truncated excerpt exposed
  labels/notes outside reserved IDs, but full-file access conservatively taints
  the catalog. See [incident/provenance gate](exposure.json). Independent review
  is required before baseline approval; if unsupported, stop INCONCLUSIVE.
  No raw heldout findings, traces, bug records, adjudications or judge outputs
  were inspected. No candidate instructions were changed or calibration answers
  used for tuning. Shared repository ancestry/defect exposure remains a limit.
- Only five cases have #45's full readiness audit. Seven additional screen and
  all nine reserved holdout cases have metadata/full commit-object availability
  checks. Future failing tests cannot justify dropping them or waiving criteria.

The protocol fixes macro aggregation by PR, a baseline repeat-range noise floor,
minimum five-percentage-point recall gain, exact cluster sign flips/common-shift
lower confidence bound, strict paired clean-harm/round/fix/regression/test gates,
and validation of the sole exact final v13 identity. Missing/invalid evidence or
failed attempts blocks adoption; no dependent pair is counted as an independent
trial. Raw human-stop/test/disposition review remains mandatory. Requested Sol
High/Fast and Astra High/Fast use subscription auth and concurrency one;
configured-only identity and unknown served identity/tier/spend remain explicit.

## Frozen identities

| Identity | SHA256 |
| --- | --- |
| Experiment manifest | `dc42cc18e8192fbe5f7635dcf174e8dd64a17d981e55543f5a50d581815c288a` |
| Experiment protocol JSON | `12f7e74d60d582013eedce4ad0190640b68bfa24e2ee6dbf4c43d01abe88b8ba` |
| Generated plan | `a52f8cfe3e5234186062601935c95fea4b820eff6379d712b7b4e09cdb58057f` |
| Calibrated runtime (150) | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| Protected harness (119) | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |
| Baseline workflow content | `e2ca7a2e86df9c78571a80952c066789affec562560f89c53e21abcbf622e3e2` |
| V13 workflow content | `daf18bd39385234b4393c3a9a9c7894a77281dc4e133034b9f8dbddc23c48d8e` |

Full helper, config and external environment identities are recursively bound in
the manifest. The original v4 private bundle and git-visible calibrated membership
still verify. The derived approval packet/plan/checks cannot change runtime policy.

## Verification and next gate

Nine offline tests pass, zero skips. Retained red/green slices cover independent
worked inference, native-prefix planning, paired aggregation, baseline noise,
failure/gap/harm rejection, exact scoped approval, native-row normalization and
missing evidence/substitution, and incomplete denominators/candidate summaries.
A regression checks both extra helper membership and changed-byte rejection.
The unchanged eval/guard suite passes **83/83**, zero failures/skips, including
actual pinned no-model sandboxes. No full-suite or typecheck rerun was needed for
this isolated preparation; two historical broad failures and 55 diagnostics
remain disclosed and no all-green check claim is made.

Actual offline plan exits 0 and reproduces its frozen output. Actual missing
approval and the actual calibration-only approval both exit 2/HUMAN. Strace
shows **zero network connect calls and zero credential-path opens** for all
three checks; the future flow remains absent. Empty report exits 2/INCONCLUSIVE,
zero baseline rows and null noise. Actual unchanged calibration v4 plan exits 0.
Protected `evals/`, plugin, test and package diff against bd1ce2c is empty.

Operational logs are fresh outside git at
`/home/ubuntu/cc-agents-artifacts/issue-48/preparation-v1`, with a committed
[hash-only index](checks/private-artifact-index.json). Reproducible checks and
normative inputs are committed; no new private answer/model artifact requiring a
draft release was produced. Previous restricted calibration releases are retained.

Parent should review the exposure and power limits before presenting any spending
request. Exact future approval is absent. If a limited exploratory baseline is
still wanted after independent exposure review, the packet contains a concrete
baseline-only request and native unapproved state template. An adoption-capable
design instead needs new eligible blind data and a fresh pre-outcome freeze.
No run/approval-writing helper exists, no approved state was written, and no
models, remote replays, reset redemption, PR/push/comment/watch or issue closure
occurred. #48's live-baseline acceptance remains pending; #49 remains blocked,
#43 remains open, and adoption remains **INCONCLUSIVE**.
