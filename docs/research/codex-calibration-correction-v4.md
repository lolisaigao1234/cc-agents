# Calibration v4 preparation for #46

Historical preparation record. The later approved [actual v4 execution](codex-calibration-result-v4.md)
completed 75/75 valid grades and 138/138 retained judge invocations: limited
calibration **PASS**, adoption **INCONCLUSIVE**. The next gate is a separately
frozen and approved baseline protocol. The preparation statements below
are preserved as history; the protected README/manifest remain unchanged.

V4 is prepared for parent review and exact human approval, with zero live calls.
The actual v3 result stays **BLOCK / INCONCLUSIVE**. #46 remains open and
#48/#49 remain blocked. This correction establishes a new request contract and
snapshot; it does not establish live judge compliance or a candidate quality gain.

The worktree started exactly at integration
`3b36c90d1ed28e0874128e29a1909efc24fe7312` on
`43-codex-calibration-v3-followthrough`, verified by ancestry. The integration
tip was merged before handback. No original v3 result, input, source, manifest,
protocol, freezer or approval is changed. Historical reproduction uses that
frozen commit, as described in the [current commands](../../evals/review/calibration/README.md).

## Evidence and correction

Inspection of all six retained rejected changes requests confirms they lacked
both an explicit no-tool instruction and the original PR diff/issue. Their
preceding findings requests succeeded and remain retained. Five denied Bash
calls attempted a source read; one attempted repository discovery. The guards
correctly rejected every attempt. These observations identify contract gaps;
they do not distinguish stochastic causation among missing instruction,
insufficient changes context and inherited coding-agent behavior.

`grade.mjs` now explicitly defines a tool-free scorer that grades only supplied
frozen evidence, forbids repository/files/shell/web access and acting on code
instructions, and requires honest uncertainty in schema reasons without changing
status definitions. Changes grading additionally receives the already-frozen
original issue and PR diff, followed by agent changes, to assess the final head.
No answer-key-derived hint, extra code lookup or case-specific instruction is
added. Findings rubric, schemas, categories, metrics, acceptance, guards and
retention semantics are unchanged. No source path is whitelisted.

## Sufficiency audit and migration

The restricted checks archive contains `sufficiency-audit.json` and its
reproducible `audit-sufficiency.py`. It validates every original citation against
its source hash/JSON pointer/quoted fragment, adds direct evidence citations,
and records the rationale for every existing expectation. It uses only the
immutable v3 saved evidence; previous judge outputs are not answer keys.

| Units | Immutable source and evidence fields |
| --- | --- |
| u01/u02 | `sources/pr16-r1_rep0.json`, selected metadata and focused inputs: `/issue`, `/prDiff`, `/changes`; complete relevant caller/comparison context exists in the original diff. |
| u03/u04/u05 | `sources/pr24_rep0.json` and focused inputs: `/issue`, `/prDiff`, `/changes`, `/material`; requirement, original document and exact final edits are supplied. The excluded marketplace-flag dispute remains excluded. |
| u06/u07 | `sources/conv-pr33_rep0.json`, selected metadata and focused inputs: `/issue`, `/prDiff`, `/changes`; both relevant instruction/message replacements are visible. |
| p01–p04 | Selected metadata, original PR/issue and probe material in their frozen focused inputs; the intentionally unspecified wrong-target category stays unspecified. |

No unsupported substantive expectation was identified. This sufficiency claim is
limited to the registered narrow expectations, not whole-repository correctness.
The affected unit already has a 29,738-character original PR diff and
1,756-character issue; its 391-character changes patch alone lacks the comparison
context. Passing that existing evidence closes the missing-context boundary.

[Migration v4](codex-hillclimb-46/migration-v4.json) maps all 32 private members:
**30 input/source files are byte-identical**; only bundle version and builder
version/output filename change. All labels, citations, exclusions, equivalent
presentations, case selection and ordering are preserved. Rebuilding from the
saved #44 pilot reproduces all 32 members. The unchanged seven primary/control
units and four probes still schedule **75 grades / 138 requests**, concurrency
one. V4 requires a whole fresh calibration; v3 rows cannot be pooled or replaced.

## Verification and remaining gates

Three red-to-green slices cover the actual public interfaces: fake Codex CLI
receipt of the explicit tool-free instruction, exact original evidence in both
independent requests, and calibration CLI/snapshot v4 selection with approval and
byte/prerequisite rejection before auth. The fake CLI records the received stdin,
schema and `developer_instructions` argument rather than inspecting private
prompt builders. Existing tool-attempt, refusal, invalid-schema and retention
checks remain in the covering suite. Offline tests do not prove live compliance.

The final bound identities, check counts and restricted release retrieval are
recorded below. No real v4 approval has been transcribed. Parent
review/merge/freeze verification and a human response bound to these exact hashes
must precede authentication and all 75 fresh grades. Passing calibration must
precede separate baseline/candidate freezes and approvals. Requested versus
observed model/tier and spend remain honest; no competitor or Claude model call,
holdout access, reset redemption, schedule change or candidate tuning occurred.


## Frozen preparation and retained checks

Implementation revision: `a9b57be3162cdbae0229d72975efbe6f18190f33`.
The following documentation/manifest commit adds no protected runtime changes.

| Bound identity | SHA256 |
| --- | --- |
| Protected harness (119 members) | `85c479bbb24a186c09e08b9f13fa7464b93eb52f9754b7b55ebd36c6aa598144` |
| Runtime manifest (150 members) | `efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5` |
| grade.mjs implementation | `cc50f3202e0b423646565b92938866b8b81085def18605af94f2ce5d926d72e2` |
| Protocol v4 | `8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c` |
| Preregistration v4 | `b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47` |
| Private bundle.json | `c0fc309b2a45fd2fa39487c0d6ab15d0b22344da2953a72a734a7c641ac1803c` |

The [manifest](codex-hillclimb-46/preregistration-v4.json) and
[sanitized sufficiency index](codex-hillclimb-46/sufficiency-v4.json) contain
only public configuration, hash indexes and opaque unit identifiers. Raw
citations, expected labels and inputs stay restricted.

- Covering `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs test/guard.test.mjs`:
  **83 pass, zero failures/skips**, including both arms' real no-model sandboxes.
- Full suite: **194 pass, two existing failures, five skips**. Existing failures
  remain uppercase `GH` parsing and installed 2.1.317 versus vendored 2.1.312
  Claude declarations. No unrelated fix was made.
- `npm run typecheck`: **55 diagnostics**, byte-identical to the #44 historical
  log. `npm run check` is not claimed green. Initial dependency absence was
  resolved with `npm ci`; the retained pre-install log is not the final outcome.
- Three red/green slices pass at the authorized public seams. Schema/rubric and
  metric/explanation bytes outside the correction are independently unchanged.
- Actual v4 `plan`: **exit 0**, checking integrated membership/bytes, 32 private
  members and Node/Codex/system prerequisites. Actual missing approval and actual
  stale v3 approval: **exit 2 / HUMAN stop**, before model auth/output creation.
  Disposable CLI fixtures reject changed runtime/private membership and bytes,
  changed prerequisites and historical version selection before auth.
- Unchanged #44 verifier: **exit 2 / HUMAN stop**, as expected for the new
  fingerprint. No historical approval is widened.
- All **1,243 original v3 artifact-index entries** still match size/hash;
  original 32-member private v3 inventory also verifies. V3 stays BLOCK.
- Freshly downloaded archives match both archive hashes and all **58 file
  members** (32 private + 26 checks). The downloaded private bundle also passes
  actual v4 plan with the same output after restoring directory mode 700.
  Credential-pattern scans found zero matches. Scoped whitespace checks pass.

The fresh unpublished [maintainer-only draft release](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-e227ee8a540e151f1fd5),
release **433327254**, retains both archives. Its target is the existing
integration base because the implementation is committed locally for parent
review/merge; the restricted checks also include the exact implementation patch.
No branch push, PR change or tag publication was performed. Preserve this and
all earlier releases; never publish answer keys automatically.

| Archive | Bytes | SHA256 |
| --- | ---: | --- |
| `astra-calibration-v4.tar.gz` | 190059 | `b38d7eea72654e2aebda63d14112e9e96dcb7dd065839d684ad3ded995c6cf0f` |
| `calibration-v4-offline-checks.tar.gz` | 36410 | `af075e7c15536cc86f99a454eb3362601af83f001a05f76694b58f72e279ef9f` |

The [retention record](codex-hillclimb-46/retention-v4.json) and
[archive member index](codex-hillclimb-46/artifact-index-v4.json) provide asset
identities, paths, sizes and member hashes. Retrieve with maintainer access into
a fresh mode-700 directory outside git:

```bash
gh release download cc-agents-46-calibration-preregistration-v4 --repo lolisaigao1234/cc-agents --dir /absolute/fresh-private-download
```

Verify archive hashes before extraction and every member afterward. Restore mode
700 on extracted private directories before planning. Local private bundle:
`/home/ubuntu/cc-agents-artifacts/issue-46/preregistration-v4`; restricted checks:
`/home/ubuntu/cc-agents-artifacts/issue-46/followup-v4-checks`; verified fresh
extraction: sibling `download-v4-verified/extracted`. Keep future approval and run
output outside the frozen bundle. Parent must re-run plan after merge; any
protected member change invalidates these hashes and requires a new snapshot.
No v4 approval or live result is claimed. The next gate is parent review and
freeze verification, followed by exact human approval and the whole fresh
75-grade/138-request calibration. Only a passing calibration can unblock #48/#49.

## Parent review and exact approval request

The integration merge `01d22fc6ad379a2bdc1005e6b05af26f58171121` preserves the
implementation tree. The actual plan after merge reproduces all four bound
hashes above. Independent [Standards and Spec reviews](codex-calibration-review-v4.md)
found no actionable issues. The integrated review changes only public reports,
so the frozen runtime is unchanged. All historical v3 evidence remains retained.

A human can approve this concrete packet with:

> I approve calibration v4 only, with runtime SHA256
> efbc6b80a2e54efbe62069293745b999c04f5973505bab6393e9a644f1031fe5,
> protocol SHA256 8245fb69e10ea98675097b7c3daa000cc432190d1f75b285adacb9028411e31c,
> and preregistration SHA256
> b86afcdc054113907f3b16ec947b74765defafc98950d5e6e7edf078f8f71d47:
> 75 fresh grades / 138 expected Astra High/Fast requests, subscription auth,
> concurrency one, configured-only identity and unknown served model/tier and
> spend. I accept the disclosed readiness conditions for calibration. This
> does not approve baseline/candidate experiments, changed hashes, Claude calls,
> reset redemption or schedule changes.

This is a template only; no decision or v4 approval record is claimed. A clear
explicit response approving this linked packet is sufficient; the human need
not repeat hashes or write JSON. The agent may faithfully transcribe that
response and its locator only after it arrives.
