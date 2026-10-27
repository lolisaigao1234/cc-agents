# Rules for every step of a round

- You are the **single writer**: only you run `ql`. Subagents read the repository, run commands, and write one file each to the output path their brief names. That keeps the ledger consistent when ten agents finish at once.
- Briefs are files. `ql brief …` writes each subagent's brief and prints one line per brief, `<agent> <brief path> -> <output path>`. Prompt the subagent with just `Brief: <brief path>`; the file holds everything else. Its reply is one line; the details are in its output file. Round files live in `.quality-loop/work/round-<n>/`.
- Read a step file when `ql` names it (`step: <path>`), not before. When unsure where you are, run `ql next`. After a context compaction, read `.quality-loop/LOOP.md` — the file, never the summary.
