# Issue #44: reproducible Codex integration handoff

This packages the completed #39 Sol/Astra integration for #43. It changes no product files and starts no model calls. The implementation was copied from the read-only `/home/ubuntu/GitHub/cc-agents-eval39` checkout at base `34dc07b8879dfa175296ddcb84ee4a9296aefa65`. [Original file hashes](codex-hillclimb-44/source-files.json) identify the uncommitted source bytes. Runtime code and the regression test are unchanged from those bytes; the README and reports have packaging annotations.

Ticket branch: `44-codex-integration-handoff`. The merger handoff at `/tmp/cc-agents-43/ticket-44-result.md` records the final immutable commit, remote branch and release asset IDs. The remote commit contains this report, [integration report](codex-hillclimb-integration.md), [pilot report](codex-hillclimb-pilot-2026-11-03.md), regression checks and the evidence indexes below. The branch is based on integration branch `43-codex-hillclimb-integration`; it is not merged back by this ticket.

## Frozen provenance and human gate

Both the scored Sol/Astra pilot and the deferred matched Opus/Astra comparison pin:

```text
e2c423eb214f4e68d95cc36f9903edfcb74e6c1d4d70bfed8637ed980747c612
```

The packaged runtime recomputes that SHA256 over **115 files**, using the runner's relative-path/NUL/bytes/NUL framing and git-visible directory membership. [Harness inventory](codex-hillclimb-44/harness-files.json) records every member and byte hash. The two original `_state.json` files are retained as evidence inside the archive, byte for byte. They are historical approval records, not approval for later experiments. No approval was written to either real flow.

Run the offline verifier before any later resumption. A changed fingerprint exits **2**, says **STOP: HUMAN approval required**, and must stop the matched comparison. Do not overwrite the approved SHA, use `--approve-harness`, or claim approval for a changed harness. The existing gate regressions exercise synthetic approval only in throwaway fixtures; they never approve pilot states. The verifier was also run against the older `34dc07b` fixture and stopped at fingerprint `6442c5e74317fe8827cb55ac74294ec7473c09ca95cd09aec6a6537fbddcde6c`.

The original Opus/Astra schedule and source files remain untouched. The reported reset is **2026-11-07 12:00 UTC**, with the existing scheduled attempt at **12:05 UTC**. That schedule must use its pinned checkout and stop if its harness changes. Actual quota and human authorization still govern resumption. No historical Claude screen, reset redemption, comparison or further hillclimb is authorized by this packaging ticket.

## Evidence inventory and retention

[artifact-inventory.json](codex-hillclimb-44/artifact-inventory.json) inventories **five unique scored keys** and **eight failed attempts**, maps each to its evidence, and gives SHA256 for every exact JSONL row (including trailing LF) and all **39 retained files**. [SHA256SUMS](codex-hillclimb-44/SHA256SUMS) is usable with `sha256sum -c`. The archive includes raw agent/judge JSONL, judge inputs, scored traces, the eight original failed-attempt event captures, results/errors, refs, metrics and both flow states. Failed event captures are JSON `codex_events` records in `baseline/leaks/`; they were not originally separate JSONL sidecars. None was converted, rewritten, reclassified or inserted into a scored slot.

Scored keys, all status `ok`: `pr16-r1/0`, `pr24/0`, `clean-pr33/0`, `pr35-r0/0`, `conv-pr33/0`. Each maps to `baseline/codex-events/<case>_rep0.jsonl`, `<case>_rep0_judge.jsonl`, `baseline/judge-inputs/<case>_rep0.json` and `baseline/traces/<case>_rep0.json` beneath `review-codex-sol-astra/`.

| Error line | Key | Recorded failure | Interpretation | Failed capture basename (`baseline/leaks/`) |
| ---: | --- | --- | --- | --- |
| 1 | pr16-r1/0 | answer_key_leak | Nested sandbox initialization | pr16-r1_rep0_1793734440762.json |
| 2 | pr24/0 | answer_key_leak | Nested sandbox initialization | pr24_rep0_1793734517508.json |
| 3 | pr35-r0/0 | answer_key_leak | Nested sandbox initialization | pr35-r0_rep0_1793734601875.json |
| 4 | clean-pr33/0 | answer_key_leak | Nested sandbox initialization | clean-pr33_rep0_1793734689386.json |
| 5 | conv-pr33/0 | answer_key_leak | Nested sandbox initialization | conv-pr33_rep0_1793734771449.json |
| 6 | pr16-r1/0 | answer_key_leak | Replay author false positive | pr16-r1_rep0_1793735581922.json |
| 7 | pr35-r0/0 | grader | Judge attempted tool; rejected | pr35-r0_rep0_1793737463400.json |
| 8 | conv-pr33/0 | grader | Judge attempted tool; rejected | conv-pr33_rep0_1793739221484.json |

The first five failures occurred under an earlier development harness; the pinned SHA describes the final scored pilot and deferred comparison, not every failed development attempt. No per-failure harness SHA was recorded, so none is invented. Preserving raw bytes and error order makes that provenance limitation inspectable.

Retention decision: keep raw evidence **outside git**, in a **draft GitHub release** named `cc-agents-44-evidence-20261103` in `lolisaigao1234/cc-agents`. It contains model/tool text, so it remains restricted to repository maintainers; do not publish it automatically. Repository write access through an existing `gh` login is required to retrieve draft assets. No token needs to be sent to another agent. An unauthenticated reader cannot retrieve a draft. The remote code branch and reports are public. The final merger handoff records verified upload/download results; if upload fails, this criterion remains incomplete.

The local retained archive is `/home/ubuntu/cc-agents-artifacts/issue-44/codex-hillclimb-44-pilot.tar.gz` with an extracted `pilot/` alongside it. [bundle.json](codex-hillclimb-44/bundle.json) records the archive hash and size. Archive SHA256:

```text
ada8cad455f614aadb10f7b2e2d1789c2fc5aafe3b3ab88709463b74b57d10ce
```

The deterministic archive uses sorted paths, fixed tar ownership/timestamps/modes and gzip mtime zero. Allowlist sanitization excludes authentication, personal configuration, runtime homes, progress files, unrelated historical flows and `tstack/`; all retained files remain byte-identical to the original evidence. A scan for JWTs, GitHub/API tokens, bearer credentials, private keys, credential URLs and credential assignments found zero matches. The only `Authorization` occurrences are ordinary prose about human authorization. No credential files were opened. This retention is not permission to expose credentials in future artifacts.

Keep the release assets and remote revision at least until #43 and its matched comparison have a final decision and a maintainer has confirmed another durable copy. Deleting a worktree or `/tmp` must not delete the only evidence. Before any replacement or migration, download, verify, and retain the original SHA256; update the handoff with the new locator without mutating these historical files.

## Reproduce without models

Obtain the immutable commit from the merger handoff or the draft release notes, fetch `origin/44-codex-integration-handoff`, and check out that exact SHA. From its repository root:

```bash
npm ci --ignore-scripts
node docs/research/codex-hillclimb-44/verify.mjs
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs
npm test
npm run typecheck
```

The first verifier command needs no authentication or CLI. The eval tests use dummy authentication and fake CLI responses except for the real pinned CLI's **sandbox command only**. They verify outer isolation, nested auth/control denial, `/proc/1/root` alias denial, replay/git writes, and full-plugin-layout reviewer/fixer isolation without contacting any model. Do not skip the two opt-in nested probes. Bubblewrap must work on the host; a skip is not proof of sandbox isolation. The live `selftest.mjs --judge-codex` and runner commands in the README **call models** and are excluded from this ticket's reproduction.

For retained evidence, with an existing maintainer login:

```bash
mkdir -p /tmp/ticket44-download /tmp/ticket44-pilot
gh release download cc-agents-44-evidence-20261103 --repo lolisaigao1234/cc-agents --pattern 'codex-hillclimb-44-pilot.tar.gz' --dir /tmp/ticket44-download
echo 'ada8cad455f614aadb10f7b2e2d1789c2fc5aafe3b3ab88709463b74b57d10ce  /tmp/ticket44-download/codex-hillclimb-44-pilot.tar.gz' | sha256sum -c -
tar -xzf /tmp/ticket44-download/codex-hillclimb-44-pilot.tar.gz -C /tmp/ticket44-pilot
node docs/research/codex-hillclimb-44/verify.mjs --artifacts /tmp/ticket44-pilot
```

Use a fresh extraction directory. The inventory also supports verification directly in that directory with `sha256sum -c <absolute-checkout>/docs/research/codex-hillclimb-44/SHA256SUMS`. No CLI secrets, model calls, GitHub replay creation, or approval are needed to inspect the downloaded evidence.

## Prerequisites, configuration and limitations

- **Offline checks:** Node 24 (verified `v24.22.2`), npm dependencies from the lockfile, git, Linux bubblewrap with user namespaces enabled, and standalone Linux **Codex CLI 0.166.0**, with sibling `codex-code-mode-host` and `codex-exec-server`. `CODEX_BIN` may select that exact ELF installation. The verified host was Linux aarch64; [prerequisites.json](codex-hillclimb-44/prerequisites.json) records versions and runtime binary hashes. No browser or model authentication is required for these checks.
- **Later live replay prerequisites:** `gh`, org-scoped eval token, separately provisioned eval-only Codex subscription login with private regular single-link mode-600 `auth.json`, `CODEX_EVAL_HOME`, a temp root outside HOME, working nested sandbox/network proxy/DNS, and pinned Matt Pocock plugin **1.3.2** in the Claude plugin cache. The runner selects the newest installed plugin cache, so freeze that cache; external installed dependencies are outside the harness digest. Never copy personal Codex config, MCP servers, memories or auth into the repository. Sol/Astra does not require Claude OAuth. Opus/Astra additionally requires Claude Code, its subscription token and actual reset availability. The README documents org permissions, token location and Ubuntu AppArmor prerequisites. No provisioning or auth refresh was performed for #44.
- **Frozen Sol baseline:** `gpt-6.1-sol`, High, Fast; judge `gpt-6-astra`, High, Fast; concurrency **1**; baseline only; existing findings/fixes rubric; at most three review rounds. State records subscription authentication, no automatic banked-reset redemption, and quality/speed priority. Trace guards, answer-key isolation, tool-free judge rejection and failure preservation are unchanged.
- **Identity:** the historical human approval explicitly accepted `configured_only`. Requested model/effort/tier are configured provenance. Missing response-backed served model and tier remain unknown/null, and any observed substitution fails. This is not independently observed server identity. Do not pool historical Fable-graded results with Astra results or claim a matched Opus comparison already happened.
- **Prices:** Sol/Astra API-equivalent dollar costs remain null/unknown, not zero. No unsupported price was added. Cached input is counted once and reasoning is part of output. Five one-rep integration cases establish integration evidence, not model superiority, a repeated baseline or adoption readiness.

## Verification recorded for #44

[Check logs](codex-hillclimb-44/checks/) are committed with this revision.

- `CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs`: **47 pass, zero failures, zero skips**, including all 18 Codex tests and actual pinned no-model sandbox probes.
- Offline verifier: both pinned fingerprints match, **39 artifact SHA256s**, **five unique scored keys**, **eight failed attempts**. Older-base mismatch probe: expected exit **2**, HUMAN stop.
- `npm test`: **168 pass, two failures, three skips** (173 total). The failures are `test/trace.test.mjs:1076` (uppercase `GH pr create` parsing) and `test/typecheck.test.mjs:33` (vendored Claude declarations **2.1.312**, installed **2.1.317**). Two opt-in sandbox skips in this broad invocation were exercised without skips by the covering command above; the third skip is absent interactive-generated declarations.
- `npm run typecheck`: **55 existing diagnostics**, byte-identical to `34dc07b` with the same dependency versions, in replay/transcript/prices and Copilot tests. No new diagnostics. `npm run check` stops at that existing typecheck failure before its later steps; it is not reported green.
- The base was materialized from `git archive 34dc07b` into a disposable fixture with its own git index and local dependencies, leaving the source checkout untouched: **152 pass, the same two failures, one skip** (155 total). Full-suite base results and the exact diagnostic diff are retained under `checks/`. Initial fixture-only setup failures (missing git index and dependency layout) were corrected before the recorded comparison.

The ticket's final handoff records remote persistence and remaining blockers. It does not close #44, post tracker communications, create a PR, merge integration, or restart deferred work; those belong to the parent.
