# Review-step eval

Measures which ideas from Anthropic's [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/) trace's Review step should adopt (issue #39). The design, the decisions and each round's results live on the issue; this file is how to run it.

- `data/`: the cases, the ground-truth bugs, the post's ideas, and the source issues' bodies.
- `lib/`: replay, agent, judge, transcript digest, prices, and the egress guard.
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
4. **Subscription token** at `~/.config/trace-eval/oauth-token` (mode 600), from `claude setup-token`. Every agent and judge call runs on it, not on an API key.
5. **Harness approval.** The runner refuses to run while the harness files differ from what the human approved in `_state.json`. Only the human approves, after reviewing the diff:

   ```
   node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant baseline --model claude-opus-5-5 --reps 3 --approve-harness --dry-run
   ```

6. **Check the grader** before paying for agent runs: `node evals/review/selftest.mjs pr16-r1` must pass all four probes.

## Running

```
node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant baseline --model claude-opus-5-5 --reps 3 --concurrency 2
node evals/review/run.mjs --flow .claude/hillclimb/review-opus --variant v1 --model claude-opus-5-5 --cases <ids> --concurrency 2
```

- Runs resume at the (case, rep) key, so a stopped run picks up where it left off. Failed attempts go to `errors.jsonl` with a failure class and are retried on the next run.
- Long runs belong in `tmux` or a service, with the output sent to a log file.
- Each run creates and deletes private repositories in `trace-eval-rocky`. `--keep` leaves them for inspection; delete them afterwards.
- Traces and judge inputs are ignored by git for size: copy them off the machine before it is wiped.
- The report: `node <claude-api skill>/shared/evals/report/build-report-lite.mjs .claude/hillclimb/review-opus/`.
