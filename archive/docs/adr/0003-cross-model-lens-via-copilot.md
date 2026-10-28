> Superseded by ADR-0005 (2026-10-28, #3). Archived: human-managed, not read by agents.

# 0003: A second model reviews through GitHub Copilot CLI, as one more lens

Date: 2026-10-28 · Status: proposed (to be built and first run on the main test machine)

## Context

Every bug hunter and verifier is a Claude subagent, so their blind spots are correlated: a defect one misses, the others tend to miss too. tstack's `sol-loop` and `council` address this with reviewers from other providers. The main test machine has a GitHub Copilot subscription that includes the Sol 6.1 model, and GitHub Copilot CLI can run a prompt non-interactively with a chosen model and a restricted set of tools (`copilot -p`, `--model`, `--allow-tool`, `--deny-tool`, `--no-ask-user`; [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)).

Three things in that reference shape the design. Deny rules beat allow rules, and a tool call needing approval is denied when nothing allows it. The model that served a reply is shown in non-silent output, but no JSON field for it is documented. And the exit codes of `-p` runs are not documented.

## Decision

Sol 6.1 reviews as **one more lens**, never as a judge.

- **Same pipeline.** `ql brief hunters` writes the external lens a brief like any other lens's. A runner, `scripts/runners/copilot-review.sh <brief> <output>`, runs Copilot CLI on it, and the result goes through `ql ingest --lens sol`. The quote-at-line evidence check, the dedupe and the Claude verifiers' quorum apply to its findings as to any hunter's. Sol finds; it does not vote and does not fix. This is stricter than `sol-loop`, where the author agent judges the other model's findings alone.
- **Read-only by construction.** Our guard sees only Claude's tool calls, not Copilot's, so the runner enforces read-only itself. Copilot runs in a disposable `git worktree` holding the round's snapshot, never the user's tree. It may read; its shell is limited to read-only `git` commands (`--allow-tool='read' --allow-tool='shell(git diff:*)' …`), with `--deny-tool='write'` and `--no-ask-user`. Its findings come back on stdout as the JSON array the brief asks for, and the runner writes them to the output path. The worktree is removed afterwards.
- **Never substitute a model.** The runner passes `--model` from configuration and checks the served model in the non-silent output. A missing `copilot`, no subscription, a different model, a timeout, or output that is not the JSON array means the lens is **blocked**, never "found nothing". `ql ingest --blocked --lens sol --reason "<why>"` records that, and the report lists it under **Blocked on me**. This depends on recording a lens that never answered as blocked rather than clean (`docs/research/tstack.md`, proposal 4), which is built first.
- **Opt-in per machine.** Only the main test machine has the subscription, so the lens is switched on in a machine-local file, `.quality-loop/config.local.json` (git-ignored, merged over `config.json`): `{ "review": { "externalLenses": [{ "name": "sol", "runner": "copilot", "model": "<Copilot's id for Sol 6.1>", "timeoutSec": 900 }] } }`. Machines without it run the Claude lenses only, and no committed config names a model one machine lacks. The model id is whatever `copilot` lists on that machine; it is configured, never guessed.
- **Measured.** `ql eval run` gains a way to run with and without the external lens on the same cases, so the tuning loop shows whether Sol catches what the Claude lenses miss and what its false positives cost the verifiers.

## Consequences

- Sol's false positives cost verifier votes, not wrong fixes: nothing it says is acted on until Claude verifiers confirm it with evidence.
- A run on the main machine needs Copilot CLI installed and signed in to the account with the subscription. The rest of the plugin keeps working without it.
- Copilot's flags and output are outside our control. The runner is the only place that knows them, and it is tested against a fake `copilot`, the way `ql ship` is tested against a fake `gh` (ADR 0004).
- Not decided here: Sol as a verifier stance, and the council's score table. Both wait for eval results from this lens.
