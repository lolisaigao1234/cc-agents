# Integrated Astra calibration v3: approval packet (#43/#46)

> **Historical packet; calibration approved and run on 2026-11-03.** The
> [actual v3 result](codex-calibration-result-v3.md) is **BLOCK / INCONCLUSIVE**:
> 75/75 attempts, 69 valid grades, six tool-attempt rejections and 138 retained
> judge invocations. #46 remains open; #48/#49 remain blocked. The original
> preparation text below is preserved as written, including its then-unapproved
> status; the bound hashes and approved calibration-only scope are unchanged.

**Prepared, UNAPPROVED; zero live grades.** The concrete implementation and
snapshot are immutable at
[`c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c`](https://github.com/lolisaigao1234/cc-agents/commit/c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c).
The parent must merge this branch, verify the same hashes and update its PR/tracker
before requesting the human response. This packet grants no approval.

[Preregistration](codex-hillclimb-46/preregistration-v3.json),
[protocol](../../evals/review/calibration/protocol-v3.json),
[commands](../../evals/review/calibration/README.md),
[private migration inventory](codex-hillclimb-46/migration-v3.json) and
[verified retention](codex-hillclimb-46/retention-v3.json) make the revision
reviewable. The separate restricted draft contains expected-label citations,
exact input/source bytes and the reproducible builder. A human may inspect that
evidence without being required to personally adjudicate every raw answer.

| Bound identity | SHA256 |
| --- | --- |
| Current combined protected harness | `096843db6d49f6687401ae74208e5703e04a7253f47b917a3932094dce3af62e` |
| Full runtime manifest (148 files) | `169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4` |
| Actual `grade.mjs` implementation | `81b28fcfb4b1419043da8d31374073cc6a542dcc5c233be53b5f389a983583d0` |
| Protocol v3 | `28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b` |
| Preregistration v3 | `ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7` |

The current manifest enumerates its own integrated protected membership (119 files), including
v13/codex-variants, retention code, calibration dependencies/tests, lockfiles,
Node, pinned Codex 0.166.0 and companion binaries, and system tools. Before any
authentication it checks exact membership/bytes, all 32 private files and binary
prerequisites. The unchanged #44 verifier still exits **2 / HUMAN stop** on the
new fingerprint. Its historical approval was never rewritten or used for v3.
V1/v2 manifests/protocols/private releases remain preserved.

## Review findings addressed

**Spec P1:** completed competitor traces, all findings/dispositions/material,
usage and original per-call requests/raw events are saved before cleanup, even
when grading fails. Each judge attempt retains every call, including successful
findings followed by rejected changes grading. Retry attempts get separate
restricted, git-ignored evidence directories; failures do not occupy scored
results or resume slots. Tool attempts remain rejected. The worker drains pending
provider evidence/cleanup after a scoring deadline before another case starts;
a late success cannot become a score. Retention excludes auth, environment,
personal config and unrelated runtime files. A retention failure preserves
original evidence and removes copied auth instead of deleting the originals.

**Standards heuristic:** writer and verifier now share canonical JSON
serialization in one calibration utility. No separate serializer remains.

**Preparation gap:** v3 replaces the unusable integrated v2 plan with a new
explicit snapshot. All **30 v2 input/source files** are byte-identical. The only
private changes are the bundle version and builder version/output filename;
expected labels, citations, exclusions, ordering and substantive input semantics
are unchanged. Rebuilding v3 reproduced all 32 members. The judge system
instruction, schemas, prompt builders, metric calculations and explanations are
byte-identical to the previous implementation. The grader implementation changes
to preserve call evidence; its new bytes are included in the runtime hash and
must be calibrated under v3. Protocol changes are version/rubric-description and
human-response transcription metadata; judgment and acceptance rules are unchanged.

## Scope and remaining gates

Approval would authorize **calibration only: 75 grades, 138 expected judge
requests**, concurrency one, requested Astra High/Fast, subscription auth,
configured-only identity. Served model/tier and API-equivalent spend remain
unknown/null unless observed. Observed substitution, tool attempts, refusals and
invalid output are rejected. There is no optional retry, fallback, competitor
run, Claude call, automatic reset redemption or dollar estimate.

Known [#45 readiness conditions](codex-readiness-45.md) remain disclosed:
historical product/test failures, protected-path and read-record guard boundaries,
missing tools and unresolved human acceptance criteria are preserved. They are
not waived by calibration approval. Node/binary hashes and real no-model sandbox
probes pass locally; shared libraries/kernel, network/DNS, subscription quota and
actual served identity remain external conditions. No live result is claimed.
#46 stays OPEN. #48/#49 must wait for actual calibration and a separately frozen,
reviewed and approved future baseline/candidate protocol. The historical deferred
Opus/Astra checkout, approvals and schedule remain unchanged.

## Verification and retention

- Final covering eval/guard checks: **83 pass, zero failures/skips**, including
  both arms and actual pinned no-model nested sandbox probes.
- Actual v3 plan: exit **0**; missing approval: exit **2 / HUMAN stop**, with no
  authentication or output directory. Disposable CLI fixtures reject changed
  approval hashes, runtime bytes/membership and private membership before auth.
- Full suite: **194 pass, two pre-existing failures, five skips**. Failures remain
  uppercase `GH` trace parsing and vendored 2.1.312 versus installed 2.1.317 Claude
  declarations. Final typecheck has the same **55 diagnostics**, byte-identical
  to the #44 saved log.
- Red/green retention and grader regressions, plan/gate logs, semantic-preservation
  checks and final raw logs are retained in the checks archive. Original 39 pilot
  files, all v2 private bytes and readiness SHA256SUMS still verify.
- Scoped working/staged diff checks pass. The full branch diff from `34dc07b`,
  excluding `**/*.log`, passes. Historical readiness raw logs retain trailing
  whitespace and their exact original bytes/hashes; a blanket branch whitespace
  check is not claimed green.

The [maintainer-only draft](https://github.com/lolisaigao1234/cc-agents/releases/tag/untagged-bf89d6e59d3411d4054e)
(release **433290736**) retains both archives; they were downloaded again and
verified. All 32 private member hashes/sizes match the public manifest. Credential
pattern scans of private inputs and checks found zero matches. Preserve this and
the v1/v2 releases; never publish answer keys automatically.

```bash
gh release download cc-agents-46-calibration-preregistration-v3 --repo lolisaigao1234/cc-agents --dir /absolute/fresh-private-download
```

Calibration archive: `astra-calibration-v3.tar.gz`, SHA256
`87d6f50e0a1ee26eab8011d7045faec5bbbf79c6f5c1f3e2765800ff54c8840a`.
Checks archive: `review-fixes-checks.tar.gz`, SHA256
`daea34b9ae1ec746b9701e7930ef4666cbad6333aa6d81f2a9d605b649fa513a`.
Extract outside git into a mode-700 directory and verify every manifest member.
Store any later transcribed approval and run output outside the frozen private
bundle, so its membership remains unchanged.

## Recommended human response (template only; no decision recorded)

> I approve calibration only for implementation revision
> c19f5c6e15cf1e4acd1e06afc64c60261a5a5e6c, runtime SHA256
> 169290c887c5657ce643c019d0962f75dadc88e718134fbd464219c5767befe4,
> protocol SHA256 28128a0fa40ef15b19c45844d21b2025f581ffe4dcafdd2def9465da90e3f06b,
> and preregistration SHA256
> ac64a64239e0c4fc69b62d2c1fcab2deb2ba7ec200026f9e7bf22ca15dc3c6b7:
> 75 grades / 138 expected Astra High/Fast requests, subscription authentication,
> concurrency one, configured-only identity with unknown served model/tier and
> unknown API-equivalent spend. I accept the disclosed readiness conditions for
> this calibration. This does not approve a baseline, candidate experiment,
> changed hashes, Claude calls or reset redemption.

An agent may faithfully transcribe a real explicit response with its author,
time and response locator into the bound record described in the README. The
human need not write JSON. The agent must never invent the decision, widen it or
approve changed hashes. No real approval record has been written.
