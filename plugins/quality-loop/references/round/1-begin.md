# Round step 1: Begin

Rules for every step of a round:

- `ql` is the command the calling skill defined (`<plugin>/bin/ql`, by its full path). Round files live in `.quality-loop/work/round-<n>/`.
- You are the **single writer**: only you run `ql`. Subagents read the repository, run commands, and write one file each to the output path their brief names. That keeps the ledger consistent when ten agents finish at once.
- Briefs are files. `ql brief …` writes each subagent's brief and prints one line per brief, `<agent> <brief path> -> <output path>`. Prompt the subagent with just `Brief: <brief path>`; the file holds everything else. Its reply is one line; the details are in its output file.
- Read a step file when `ql` names it (`step: <path>`), not before. When unsure where you are, run `ql next`. After a context compaction, read `.quality-loop/LOOP.md` — the file, never the summary.

## Begin

`ql round begin`. It checkpoints the working tree and prints the review **scope** in short: the diff file, how many files changed, and the lens names. Round 1 reviews the whole change against the base; later rounds review only what changed since the last kept round (diff-only re-review), so old code is not re-litigated every round.

Done when: the round number and scope are printed.
