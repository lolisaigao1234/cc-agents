# #48 correction implementation handoff

Branch `t3/codex-v2-audit-pinning` starts at requested parent
`7b475390ef377fd978dc53598b7cb4cfcd2a81a1`. No subagents, model runs,
eval authentication, replay, push, PR mutation, issue comment/watch/closure,
reset, schedule, real approval or native first-key flag was used. Parent owns
PR #52 and final review/merge/execution approval. A new unpublished restricted
retention draft is the sole GitHub write; all downloads verify.

Review the concrete [approval packet](approval.md), [check ledger](checks-v3/summary.json),
[protocol](protocol.md), [complete v3 manifest](experiment-manifest.json),
[exact proposed plan](plan.json), [v5 manifest](../codex-hillclimb-46/preregistration-v5.json),
[version-only migration](../codex-hillclimb-46/migration-v5.json) and
[private retention](../codex-hillclimb-46/retention-v5.json).

The two runtime corrections are narrow:

- `runCodexAgent` renders a typed grader-only workflow copy with exactly audit
  `active_model` / `token_usage` removed. Raw workflow turns/events/provenance,
  all substantive fields/records/tool evidence, outputs and GitHub collection
  remain. Competitor instructions/control flow and judge prompt/schema/rubric/
  metric bytes are unchanged. `grade` locally retains a genuine oversize native
  failure without fabricating a provider call.
- Native runner preflight selects an explicitly env/state/manifest-bound Matt
  source before auth or harness approval writes and verifies the copied run
  input. Pinned flows never fall back to newest cache. Relative links stay
  relative. Legacy flows declaring neither pin option retain old behavior.
  The offline builder checks source type/mode/target before reading content and
  constructs only the immutable original EXPECTED 176 members outside git;
  installed settings/cache/leases/auto-update are untouched.

Public regressions use real `runCodexAgent -> grade/request`, native runner
preflight, `prepareCodex` discovery and `codexBwrap` mount/config seams. Both arms
exercise roughly one megabyte of semantic tool evidence with realistic diagnostic
metadata, rejected/fixed/unresolved dispositions, failing verification, human
stops, tool-only and GitHub-only evidence, unknown fields and adversarial markers.
A one-character Unicode oversize boundary is retained with zero transport calls.
Raw retained metadata remains equal. Pin fixtures survive source/cache/version
mutations and reject missing/added/changed members, mode changes, hardlinks,
escaping links, missing/unbound declarations and root indirection before auth.
The actual 176-member source and run copy verify all file kinds/modes/links.

All four retained SCREENED request envelopes fit after the production projection.
The happened failure is 1,068,777 -> 1,040,422 characters, retaining all 513 audit
records, 213 tool inputs and 205 tool responses. Headroom is 8,154 characters;
future capacity is not guaranteed. All semantic values and raw v2 hashes remain.
Original red/new green are captured at the actual public grade/request boundary
with synthetic tool-free output, never a new grade of the case. Restricted raw
projection is hash-only in public git. See `checks-v3/screened-projection-proof.json`.

Stable runtime validation: 89/89 eval/guard checks, zero skips; 15/15 protocol
checks. Full suite: 204 passes, the two historical failures and one intentional
interactive-session skip. Typecheck: all 55 historical diagnostics unchanged,
none introduced. No unrelated fixes. Nine actual frozen CLI probes and the
projection probe have zero network connect calls and zero credential-path opens.
Missing/stale approvals, historical v4 selection, changed pin environment and
missing actual v5 PASS stop before authentication/output. Explicit synthetic test
records are disposable fixtures, never real approvals or approved flow state.

V5 preserves all 30 v4 input/source files and substantive labels/exclusions/
presentations/order, changing only bundle/builder version metadata. It requires
75 wholly fresh grades and 138 expected Astra High/Fast requests, concurrency one.
New CLI defaults/selects v5; historical v4 reproduction uses its frozen old commit.
The baseline v3 manifest binds v5 actual PASS, the source pin/builder/verifier,
full current runtime/helper/membership/prerequisites, installed dependencies/npm
and binaries, exact source objects, fresh experiment-v3 paths and null template.
All v2 IDs, PR split, reps/order, treatment identity, metrics/noise floor/exact
95% sign flips/.05 threshold/harm/round/fix/test/failure gates are unchanged.
A complete new 33-key baseline is required; no 29-key resume, replacement or pooling.

V4 PASS and v3 calibration BLOCK remain historical. V2 remains INCONCLUSIVE:
three scored, one failed, 29 unstarted, 17 native model CLI calls. The old installed
cache gate still fails 177 vs 176 members with all original bytes unchanged.
Historical manifests/protocols/checks/approvals/native flag history, raw snapshots,
reports and releases are preserved at their original commits. The new preparation
is after observed partial v2 outcomes, not a wholly blind pre-outcome design.
There is no outcome-based selection, threshold/workflow change or quality tuning.
All exposure/shared-source/low-power/readiness limits remain in the packet.

Private artifacts are under `issue-48/correction-v3-*`. New draft assets include
version-only calibration, source pin plus external manifest and restricted offline
proof. Every archive/member verifies after fresh download. Exact directory modes
must be preserved when extracting the pin; Python's data filter drops directory
modes, so the verified safe archive was additionally extracted with faithful
modes and independently passed the production pin verifier. No auth/personal
configuration/runtime archive or original catalog/heldout answers were retained.

Remaining human gates: parent review/merge; exact calibration-v5-only approval;
whole new actual v5 PASS; separate exact baseline-screen-v3 approval (which may
be requested conditionally alongside calibration); fresh explicit delegation if
the agent should execute the first native `--approve-harness` command. The old
v2 delegation cannot apply. No agent writes an approved state directly.
Offline tests establish neither live compliance nor grader quality. Same-uid
racing writers are outside the pin's operator-controlled/no-concurrent-writer
assumption. Served identity/tier/spend remain unknown without observed evidence.
