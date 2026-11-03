# Codex in the review hillclimb

Updated 2026-11-03 from the initial research on `cc-agents-eval39`. The runner and judge adapters are implemented. The one-rep, concurrency-1 Sol/Astra pilot completed with five scored keys and eight preserved failures; see the [pilot report](codex-hillclimb-pilot-2026-11-03.md). Issue #44 packages those original bytes and reports with reproducible offline checks and external artifact retention in the [durable handoff](codex-hillclimb-handoff-44.md). The later sections preserve the implementation history. #44 made no model calls, reset redemption or service/schedule changes and did not modify the original source checkout, historical flow evidence or `HANDOFF.md`.

## Selected configuration

| Role | Backend/model | Effort | Speed | Flow |
| --- | --- | --- | --- | --- |
| Competitor | Codex, `gpt-6.1-sol` (GPT-6.1 Sol) | High | Fast | `.claude/hillclimb/review-codex-sol-astra` |
| Comparison candidate | Claude Code, `claude-opus-5-5` (Opus 5.5) | High | Existing Claude setting | `.claude/hillclimb/review-opus-astra` |
| Shared judge | Codex, `gpt-6-astra` (GPT-6 Astra) | High, preserving Fable's effort setting | Fast | Frozen in both new flows |

Astra serves Fable 5.1's existing role: identify and classify findings, check fixes and regressions, and feed the existing metrics. The rubric, schemas, ground truth and metric calculations are unchanged. Both competitors must be graded with this same Astra configuration. Existing Fable-graded Opus results remain historical evidence; they must not be pooled with the new Astra-graded comparison. Legacy flows continue to default to Fable.

Fast is a service setting, independent of reasoning effort. Both Codex roles explicitly generate:

```toml
model_reasoning_effort = "high"
service_tier = "fast"

[features]
fast_mode = true
```

This requests Fast, not Ultrafast. Official OpenAI documentation confirms both model slugs, support for Fast on Sol and Astra, and that `fast` maps to the request value `priority`. Account availability and the served tier are not inferred from these settings. Sources: [Models](https://learn.chatgpt.com/docs/models), [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Quality and speed take precedence over token savings. No additional Codex token/output cap is imposed; High effort and Fast remain pinned. The state records three banked usage resets as available capacity, not a dollar cap or permission for automatic redemption. Normal process deadlines and the trace's three-round stop remain. The Claude `--budget-usd` flag retains its existing meaning and is not misrepresented as a Codex cap.

## Claude usage and resumption

Claude usage is exhausted. The new Sol/Astra pairing needs no Claude subscription token or Claude model calls. The Opus/Astra flow is deferred until the reset recorded in the reference issue comment: **2026-11-07 12:00 UTC**. This timestamp is reported status, not a live quota check. Its frozen `claude` configuration rejects Claude-dependent execution before that time; after it, confirm the actual reset and resume with the same flow, variant, cases and reps. Completed `(case, rep)` rows are skipped; failures remain retryable.

The prior screen was stopped deliberately and still requires a human restart. This integration does not start that service or redeem any banked reset. The human-only harness approval boundary in the original source checkout's `HANDOFF.md` also remains in force. The relevant instruction is: “the human must re-approve with `--dry-run --approve-harness`. Never pass that flag yourself.” The user subsequently instructed the agent to start the run; that go-ahead was recorded for the reviewed new Sol/Astra harness only. Historical approvals remain unchanged. The obsolete source handoff's read-only packaging restrictions are superseded only by #44's explicit scoped packaging authorization; the source checkout itself remains read-only.

## Implemented adapter

- [codex.mjs](../../evals/review/lib/codex.mjs): pinned standalone Linux CLI **0.166.0**, generated configuration, eval-only subscription authentication, outer bubblewrap plus Codex's inner permission profile, JSONL capture, structured output validation, deadlines and process-group cleanup.
- [codex-agent.mjs](../../evals/review/lib/codex-agent.mjs): explicit baseline workflow. Each round runs an independent bug reviewer and standards/spec reviewer, followed by fixes/dispositions and tests. It re-reviews incrementally, stops after at most three rounds, then updates the replay PR and issue. Sessions are fresh and ephemeral; findings are passed explicitly. It does not invoke Claude, Copilot, Workflow or slash commands.
- [codex-hooks.mjs](../../evals/review/lib/codex-hooks.mjs): translates lifecycle, tool, patch and full-file-read evidence to the pinned trace runtime; applies the eval egress guard. Every patch source/destination is checked. Only a complete, verified `cat` result earns file-read credit; partial/truncated output does not. Hook errors invalidate the attempt.
- [codex-digest.mjs](../../evals/review/lib/codex-digest.mjs): separate event normalization, operation deduplication, leak scans, terminal-success checks and provider-aware usage. Unknown fields remain in raw events. Reasoning is excluded from judge findings material.
- [config.mjs](../../evals/review/lib/config.mjs), [run.mjs](../../evals/review/run.mjs), [grade.mjs](../../evals/review/lib/grade.mjs): backend dispatch, frozen judge selection, separate requested/served identity, resume configuration checks, and Astra grading through the existing findings/fixes schemas.
- [selftest.mjs](../../evals/review/selftest.mjs): `--judge-codex` runs the existing oracle, null, “I don't know” and wrong-target probes through Astra without reading Claude authentication.

The Codex workflow currently supports **baseline only**. Claude Workflow/band-dependent variants fail explicitly until individually ported. This is a CLI + model + adapted workflow comparison, not a claim that equal effort labels imply equal compute or identical native review behavior. No Codex support was added to the trace product itself.

## Authentication, isolation and provenance

Set `CODEX_EVAL_HOME` to a **separately provisioned eval-only** Codex subscription login directory with a mode-600, regular `auth.json`. Do not point it at the human's personal Codex home. The adapter copies only authentication bytes into the generated per-attempt home; it does not read/log token contents or copy personal configuration, memories, MCP servers or plugins. It never falls back to API billing. A runner-lifetime lock and concurrency 1 serialize refreshes, which are copied back atomically. After a crash, remove a stale `.hillclimb.lock` only after confirming its runner is gone. The eval-only ChatGPT subscription login was provisioned with Codex device sign-in and verified without displaying credential contents.

Outer bubblewrap exposes system runtime, the pinned CLI and its code-mode/exec companion executables, this replay/home/temp and the required trusted plugin runtime. It does not mount the host `/`, home, shared temp root, harness or other replays. The resolved `/etc/resolv.conf` file is mounted read-only when it points outside `/etc`; the rest of `/run` stays hidden. The Codex executable is mounted at a fixed runtime path outside the hidden home. The inner profile denies credentials, control/policy files, trace state and plugin source to model-controlled tools, permits replay `.git` writes, and runs the command network proxy with explicit GitHub/npm domains. Hosted search and unrelated apps are disabled; no MCP configuration is inherited. The eval's repository-scoped egress guard and tool evidence scans remain additional checks, not substitutes for OS isolation.

Generated hooks use the documented automation-only `--dangerously-bypass-hook-trust` after the human reviews/pins the harness. This does not bypass the command sandbox. Required SessionStart and PostModelRequest audit records must exist, and hook errors invalidate the attempt. Live model-driven hook delivery still needs the gated pilot; fake-CLI execution verifies the local contract, not server behavior. Sources: [Permissions](https://learn.chatgpt.com/docs/permissions), [Hooks](https://learn.chatgpt.com/docs/hooks).

The judge has an empty working directory, no plugin, no command networking, and a hook denying every tool. Any attempted tool call invalidates grading. Repository and agent text remains untrusted data under the existing judge system instruction.

**Model evidence limitation:** exec JSONL does not guarantee a server response model or served tier. New presets explicitly record `model_verification: "configured_only"` and explain this limitation for human review with the harness. Missing served identity stays `null`; requested model/effort/tier are separate provenance. Diagnostic active-model slugs are not promoted to server evidence. Any observed response-model mismatch still fails. Change to `"required"` to refuse scoring without response-backed model evidence. No silent substitution or standard-speed fallback is implemented. Sources: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Model request hooks](https://learn.chatgpt.com/docs/hooks#premodelrequest-and-postmodelrequest).

## Usage, artifacts and comparison

Completed-turn usage is authoritative; per-request hook diagnostics are retained but never added again. Cached input is split out of total input, and reasoning remains part of output. Missing usage stays unknown. Fast subscription usage and three banked resets are not translated into fabricated API-dollar budgets. Unpriced Codex agent/judge costs and incomplete total cost remain `null`, with coverage recorded. No unsupported OpenAI prices were added to Claude's price table.

Raw Codex agent/judge JSONL is saved under each arm's ignored `codex-events/`; traces, judge inputs, audit provenance and failed/partial attempts remain reviewable. Resume rejects a different judge or execution configuration in the same flow. New flow states have no inherited harness approval or results. Preserve the win condition: recall above the measured noise floor, no increased harm on clean cases, and no increased rounds.

## Validation and next run

Local validation uses fake CLI responses and dummy auth only. It covers configuration freezing, Fable compatibility, Claude deferral, response identity, success/failure/partial/malformed streams, usage deduplication, patch/read translation, judge tool denial and schema failures, round limits, and findings/fixes metrics. An opt-in check with the actual pinned CLI's **sandbox command only** verifies nested isolation of auth/control files (including `/proc/1/root` aliases) and allowed replay/git writes. No model is contacted by that check.

```bash
CODEX_SANDBOX_TEST=1 node --test test/eval-codex.test.mjs
```

The eval regression suite passes. Repository typecheck still reports the same pre-existing replay/transcript/prices/Copilot-test errors as before; the new adapters add no diagnostics. See [the runner README](../../evals/review/README.md#codex-sol-versus-opus-with-astra) for exact provisioning and pilot commands.

Before live scoring: provision eval authentication; review the diff and the explicit model-evidence limitation; have the human approve each new flow's harness; run the Astra selftest; then run the one-rep, concurrency-1 five-case pilot (`pr24`, `pr35-r0`, `pr16-r1`, `clean-pr33`, `conv-pr33`). Inspect actual hook delivery, findings/fixes, round counts, auth refresh, tier/model evidence and usage before a full three-rep comparison. Resume Opus after Claude resets. Five cases validate integration and do not establish superiority.

## First live startup and sol-loop corrections

The first Astra selftest failed before grading with `workspace routing discovery failed`. A no-model reproduction showed that `/etc/resolv.conf` points into the hidden `/run/systemd/resolve/` directory. Binding only that resolved file fixes CLI DNS without exposing the host run directory. Startup also reported a missing `codex-code-mode-host`; the pinned install's two companion executables are now mounted individually and checked before launch.

Sol-loop round 1 requested three fixes, all covered by regressions: translate Claude trace halts into supported Codex deny-only PreToolUse output; pass preceding findings/dispositions/verification into the fresh Update session; and give both incremental reviewers the HEAD captured before the preceding fix phase, including multi-commit fixes. All 16 Codex checks pass after these corrections. Sol-loop round 2 returned APPROVE with S1–S3 resolved and no additional finding. The repeat live Astra selftest passed oracle, null, “I don’t know” and wrong-target probes. The Sol/Astra harness sha begins `79adcb6c649d`; its first five-case pilot finished with zero scored rows and five failed attempts. See the runtime correction below; the failed evidence remains intact.

## First pilot: nested plugin-layout correction

All five first-pilot attempts failed before meaningful review or grading. The real plugin layout exposed a nested-bubblewrap initialization failure: the inner blanket `/tmp` deny hid ancestors needed to create read-only deny mounts for the plugin and reviewer workspace. A no-model matrix reproduced the exact failure for both reviewer and fixer roles; removing only that redundant inner `/tmp` deny made both pass while credentials, plugin source, control files and other replay sentinels remained hidden. The outer sandbox still provides a private `/tmp`, and the inner profile still limits writes to the attempt.

A full-layout regression now covers both roles. Bootstrap errors from command items or trusted PostToolUse output are classified as `sandbox_unavailable` before leak scanning. The five original failed rows, originally classified as `answer_key_leak` because their error text named a protected plugin path, are preserved rather than rewritten. No failed row occupies a `(case, rep)` success slot. Sol-loop re-review and a single-case retry precede resuming the remaining pilot cases.

## First retry: replay-author leak classification

The single-case retry ran shell commands, completed bug and standards/spec review, and performed Update. The leak scan then rejected a legitimate `gh issue view` response because its comment author login matched the source owner's bare name. The Codex digest had applied the broad tool-input pattern to complete items, including output metadata, unlike the existing Claude digest.

The correction applies the broad pattern only to command, argument, input, query and file-change fields. The source-repository evidence pattern still checks full items, including output and hook feedback. A regression covers allowed replay authorship and forbidden source commands, paths, file changes, MCP arguments and source-repository output. Replaying the saved 1,076-event failed transcript with the exact run patterns produces no false leak after the correction. Six failed attempts remain preserved; no success row has been fabricated or backfilled. A fourth security-focused Sol review precedes the next single-case retry.

## Pilot completion

The Sol/Astra one-rep pilot is complete: all five requested case/rep slots are scored. Eight failed attempts remain preserved; the two rejected Astra tool-call grades were retried successfully under the same frozen settings. Score keys, artifacts, round counts and per-call token totals were verified. Diagnostic replay repositories and matching runtime/temp directories were cleaned up. See [the pilot report](codex-hillclimb-pilot-2026-11-03.md) for scores, quality concerns and coverage limitations. The matched Opus/Astra pilot remains deferred until the reported Claude reset; the historical stopped screen is not restarted.

The matched Opus/Astra five-case pilot is scheduled for **2026-11-07 12:05 UTC** after the reported Claude reset. Its frozen harness approval is recorded; later code changes still trip the gate. The scheduled task preserves the completed Sol pilot and disables itself after completion.
