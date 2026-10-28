# Rules for every step of a round

- You are the **single writer**: only you run `ql`. Subagents read the repository, run commands, and write one file each to the output path their brief names. That keeps the ledger consistent when ten agents finish at once.
- Briefs are files. `ql brief …` writes each subagent's brief and prints one line per brief, `<agent> <brief path> -> <output path>`. Prompt the subagent with just `Brief: <brief path>`; the file holds everything else. Its reply is one line; the details are in its output file. Round files live in `.quality-loop/work/round-<n>/`.
- Read a step file when `ql` names it (`step: <path>`), not before. When unsure where you are, run `ql next`. After a context compaction, read `.quality-loop/LOOP.md` — the file, never the summary.
- Keep the change the size its intent needs. Review loops grow a change one cheap-looking fix at a time: fix real defects in what the intent covers, and leave the rest (another path, a rare case, a small cost, extra compatibility) as nits for the user, each with its reason. Never accept a finding just to end the loop, and never keep code just because an agent wrote it.
