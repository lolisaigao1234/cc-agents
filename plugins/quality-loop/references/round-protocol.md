# Round protocol

One round of the quality loop. `ql` below means the command the calling skill defined (`<plugin>/bin/ql`, by its full path). Round files live in `.quality-loop/work/round-<n>/`.

You are the **single writer**: only you run `ql`. Subagents read the repository, run commands, and write one JSON file each to a path you give them. That keeps the ledger consistent when ten agents finish at once.

When unsure where you are, run `ql next`. After a context compaction, read `.quality-loop/LOOP.md` — the file, never the summary.

## 1. Begin

`ql round begin`. It checkpoints the working tree and prints the review **scope**: the diff file, the changed files, the lenses, and the path of `REVIEW.md`. Round 1 reviews the whole change against the base; later rounds review only what changed since the last kept round (diff-only re-review), so old code is not re-litigated every round.

Done when: the round number and scope are printed.

## 2. Review: parallel bug hunters

Empty scope: `ql ingest --none --lens scope` and go to step 3.

Otherwise spawn one `bug-hunter` subagent per lens, **all in one message** so they run in parallel. Each brief holds:

- the lens name and its one-line focus, both printed by `ql round begin` (again with `ql scope --json`)
- the scope diff path, and that the hunter may read any file for context
- the change's intent (the user's words, the PR description, or the commit messages)
- the paths of `REVIEW.md` and `CLAUDE.md` if present
- the output path: `.quality-loop/work/round-<n>/hunter-<lens>.json`
- in rounds after the first: the open and fixed findings (`ql export --all`), so the hunter looks for what is new

As each hunter reports back, `ql ingest <its file> --lens <lens>`. Read the rejected lines: `quote-not-found` and `file-missing` are hallucinations the evidence check caught; `skip-path`, `dropped-category` and `nit-cap` are policy. A hunter whose file is missing or invalid gets one re-run with the error message.

Done when: every lens has been ingested (or recorded with `--none`).

## 3. Verify: quorum vote

`ql pending --json` lists candidates with how many votes each still needs (`verifiers` per finding, `quorum` to confirm). For each candidate spawn that many `finding-verifier` subagents, each with a **different stance**, cycling `reproduce`, `trace`, `intent`, `counterexample`, `blast-radius`. Send all of them in one message (batch past ten). Each brief holds the finding's full JSON, its stance, the voter name `<stance>-<id>`, and the output path `.quality-loop/work/round-<n>/vote-<id>-<stance>.json`.

Record the vote files with `ql vote <file> [file ...]` (several at once is fine; votes arriving after a finding settled are kept and change nothing). A candidate left `undecided` (a verifier failed or wrote nothing) gets its missing votes re-spawned with new stances.

Done when: `ql pending` shows no candidates.

## 4. Fix: one bug class at a time

`ql open --json` groups confirmed findings by bug class. Give each class to one `fixer` subagent; classes run in parallel only when their files do not overlap, otherwise one after another. The brief holds every finding of the class (all instances get fixed, not one line), the repository's test command from `ql config`, and the output path `.quality-loop/work/round-<n>/fix-<class>.json`.

**Check the evidence before you accept it.** For each finding the fixer claims, read the diff (`git diff`) at the cited place and the test it added, and confirm the command output it quotes. Then:

- `ql mark <id> fixed --reason "<what changed; regression test name; command and result>"`
- `ql mark <id> wontfix --reason "<why>"` only when the behaviour is intended (REVIEW.md, CLAUDE.md or the user says so) or out of the change's scope. Getting to green is never a reason.

A finding the fixer could not fix stays confirmed; the loop counts its attempts and escalates it as stuck.

Done when: every confirmed finding is marked or explicitly left for the next attempt.

## 5. Validate and decide

`ql round end`. It runs every configured check, re-runs a newly failing one once to rule out flakiness, compares against the round's start, scans the round's own diff for weakened tests (skips, `.only`, deleted test files, dropped assertions), and **reverts the round to its checkpoint** on any regression. It prints the check output; read the failures.

| Decision | What you do |
|---|---|
| `CONTINUE` | Next round from step 1. |
| `REVERTED` (with `CONTINUE`) | The round's edits are gone. Read the reasons; the next attempt takes a different approach — the same fix reverts again. |
| `DONE` | The finish line is met. `ql report`, present it. |
| `CAPPED` | Stop. Report, and ask the user to reconsider the approach. Only the user can extend (`! ql extend`). |
| `STALLED` | Stall analysis: read every remaining open or stuck finding and bucket it by root cause (wrong approach, ambiguous requirement, flaky check, finding that is really a false positive, needs a design decision). Make no edits. Report the buckets. |

Done when: `ql round end` has printed a decision and you have acted on it.

## The report

`ql report` writes the final report: a count line first, then **Blocked on me**, **Changed**, **Found**. Present it as written, adding anything you could not confirm, marked as unconfirmed with where you looked.
