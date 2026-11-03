# Review-step eval

Measures which ideas from Anthropic's [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/) trace's Review step should adopt (issue #39), plus family K (`v12`), three rules for settling findings from Google's [elephant-goldfish-model](https://github.com/google/elephant-goldfish-model). The design, the decisions and each round's results live on the issue; this file is how to run it.

- `data/`: the cases, the ground-truth bugs, the post's ideas, and the source issues' bodies.
- `lib/`: replay, agent, judge, transcript digest, prices, the egress guard, and cleanup of a run's directories.
- `variants/<vN>/`: one family of ideas switched on (`change.md` says what and why).
- `run.mjs`: the runner. `selftest.mjs`: the grader's oracle, null, "I don't know" and wrong-target probes.
- Results: `.claude/hillclimb/review-opus/` (`_state.json`, `baseline/`, `v<N>/`).

## Setting up a machine

Nothing below is in git. Every token stays out of chat and out of the repository.

1. **Tools.** Node 24, `gh` and git; Claude Code (2.1.314 when the pilot ran). Claude Code's sandbox must work, since every agent run sets `failIfUnavailable`: on Linux that needs bubblewrap and socat. On Ubuntu 24.04 and later, AppArmor also stops bwrap from creating a user namespace (`bwrap: loopback: Failed RTM_NEWADDR`) until `/usr/bin/bwrap` has a profile granting `userns`:

   ```
   printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n' | sudo tee /etc/apparmor.d/bwrap
   sudo apparmor_parser -r /etc/apparmor.d/bwrap
   ```

   The agent cannot read anything under the human's home, so the runner's temp dir (`TMPDIR`) must sit outside it.
   Hold the system under test still for a whole screen: turn off the `mattpocock` marketplace's `autoUpdate` in `~/.claude/settings.json` (the runner copies the newest cached version), and keep Claude Code from updating itself.
2. **Matt Pocock's skills**, installed as a plugin, so that `~/.claude/plugins/cache/mattpocock/mattpocock-skills/<version>/` exists (1.3.2 when the pilot ran). The runner copies the newest version there into each run.
3. **GitHub token** at `~/.config/trace-eval/gh-token` (mode 600): a fine-grained token whose resource owner is the `trace-eval-rocky` org, with Administration, Contents, Issues and Pull requests read and write on all its repositories, and nothing on any other owner. The runner refuses to start unless a write probe on `lolisaigao1234/cc-agents` fails.
4. **Subscription token** at `~/.config/trace-eval/oauth-token` (mode 600), from `claude setup-token`. Every legacy Claude agent and judge call runs on it, not on an API key. The Codex/Astra setup below uses a separate Codex subscription login.
5. **Harness approval.** The runner refuses to run while the harness files differ from what the human approved in `_state.json`. The harness is the runner, the lockfile and every path in `harness_paths`. A listed directory covers every file git sees in it, including files not yet committed, which `git diff` does not show, so check `git status` too. Run from the repo root. Only the human approves, after reviewing the diff:

   ```
   node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant baseline --model claude-opus-5-5 --reps 3 --approve-harness --dry-run
   ```

6. **Check the grader** before paying for agent runs: `node evals/review/selftest.mjs pr16-r1` must pass all four probes.

## Running

```
node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant baseline --model claude-opus-5-5 --reps 3 --concurrency 2
node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant v1 --model claude-opus-5-5 --cases <ids> --concurrency 2
```

- The agent runs at `--effort high` (the human's own Opus setting), or at the `effort` in the arm's `variant.json`; the judge runs at `high`. Both are pinned so Claude Code's server-side default cannot shift mid-screen. Each row records its `meta.effort`.
- Runs resume at the (case, rep) key, so a stopped run picks up where it left off. Failed attempts go to `errors.jsonl` with a failure class and are retried on the next run.
- Long runs belong in `tmux` or a service, with the output sent to a log file.
- Each run creates and deletes private repositories in `trace-eval-rocky`. `--keep` leaves them for inspection; delete them afterwards.
- Traces and judge inputs are ignored by git for size: copy them off the machine before it is wiped.
- The report: `node <claude-api skill>/shared/evals/report/build-report-lite.mjs .claude/hillclimb/review-opus/`.

## Codex Sol versus Opus with Astra

The new flows compare Codex **GPT-6.1 Sol, High, Fast** against Claude Code **Opus 5.5, High**, using **GPT-6 Astra, High, Fast** as the common judge. Astra uses Fable's existing rubric, structured findings/fixes schemas and metrics. Historical Fable results remain in their original flows. Approval remains human-only. The completed one-rep Sol/Astra pilot and the deferred Opus/Astra comparison have historical approval snapshots in the retained #44 evidence bundle; these do not approve any later changed harness or new flow.

- `.claude/hillclimb/review-codex-sol-astra`: Codex baseline with the explicit review/fix/update adapter. Only `baseline` is supported; unported Claude Workflow variants are rejected.
- `.claude/hillclimb/review-opus-astra`: Opus baseline/variants with Astra grading. Claude-dependent work is deferred until the reported **2026-11-07 12:00 UTC** reset; verify quota then. The stopped historical screen is not restarted automatically.

Use Node, gh/git, bubblewrap and the standalone Linux **Codex CLI 0.166.0**. `CODEX_BIN` may select that exact standalone installation. Configure `CODEX_EVAL_HOME` as a separately provisioned, eval-only Codex subscription login directory with a regular, mode-600 `auth.json`; never use the personal Codex home. Generate the login through Codex's normal login flow outside the runner. Tokens stay out of chat and git. Only auth bytes are copied; the adapter generates its own policy/config/hooks and preserves refreshed auth under a runner-lifetime lock. API keys are not used. Runs using Codex for either role require `--concurrency 1`. Sol/Astra does not load the Claude subscription token; Opus/Astra still needs it.

Both Codex roles set `service_tier = "fast"`, `features.fast_mode = true`, and High reasoning explicitly. Quality and speed take precedence over token efficiency: no additional Codex output/token cap is imposed. Three banked resets are recorded as available capacity; they are not automatically redeemed. Wall-clock deadlines and the three-round stop remain. `--budget-usd` is a Claude limit, not a Codex token cap.

Codex exec does not guarantee response-backed model/tier identity. The new flows explicitly select `model_verification: "configured_only"`: missing served model stays null, with requested settings and the limitation in provenance; observed mismatches still fail. Review this setting as part of human harness approval, or select `"required"` to block scoring without response-backed model evidence. Codex dollar costs remain unknown until complete tier-aware prices/usage are available. Raw events are preserved in ignored `codex-events/` directories.

After reviewing the changes, **the human** approves the two new harnesses, using the same flags below plus `--approve-harness --dry-run`. Agents must not pass the approval flag. Then validate Astra:

```bash
node evals/review/selftest.mjs pr16-r1 --judge-codex
```

Sol's five-case pilot (one rep; inspect findings/fixes, hooks, round counts, refresh, provenance and usage before expanding):

```bash
node evals/review/run.mjs --flow .claude/hillclimb/review-codex-sol-astra --agent codex --model gpt-6.1-sol --variant baseline --reps 1 --concurrency 1 --cases pr24,pr35-r0,pr16-r1,clean-pr33,conv-pr33
```

After the actual Claude usage reset, run the matching Opus pilot:

```bash
node evals/review/run.mjs --flow .claude/hillclimb/review-opus-astra --agent claude --model claude-opus-5-5 --variant baseline --reps 1 --concurrency 1 --cases pr24,pr35-r0,pr16-r1,clean-pr33,conv-pr33
```

Re-running the same command resumes at `(case, rep)` and retries failures. Resume refuses existing rows with a different judge or execution configuration. Follow the matched three-rep design before quality conclusions. No live runs or reset redemption are part of local validation. For no-model contracts and the optional real sandbox check:

```bash
CODEX_SANDBOX_TEST=1 node --test test/eval-codex.test.mjs
```

See [integration details and limitations](../../docs/research/codex-hillclimb-integration.md).

### Reproduce the packaged integration offline (#44)

[The durable handoff](../../docs/research/codex-hillclimb-handoff-44.md) records the immutable-revision locator, original source hashes, CLI prerequisites, full check results, known existing failures and draft-release evidence retrieval. From the repo root:

```bash
npm ci --ignore-scripts
node docs/research/codex-hillclimb-44/verify.mjs
CODEX_SANDBOX_TEST=1 node --test test/eval-*.test.mjs
```

These commands make no model calls and require no eval credentials. The verifier exits 2 with a HUMAN stop if the current harness differs from either pilot's pinned fingerprint. Do not use the live runner's `--dry-run` as an offline substitute: its setup checks still use authentication and GitHub. Raw events, traces and judge inputs stay outside git; the committed inventory hashes the five scored rows, eight failed attempts and all 39 retained files. Download/extract the retained bundle and pass `--artifacts DIR` to verify them. No schedule or deferred Claude run is changed by this handoff.
