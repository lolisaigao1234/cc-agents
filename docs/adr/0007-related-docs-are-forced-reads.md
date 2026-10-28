---
status: accepted
date: 2026-10-28
issue: "#3"
---

# 0007: The related docs are forced reads, for every agent, before any edit

Stale specs and invented terms enter when a model edits before it has read what the project already decided. Leaving the choice of what to read to the model means a relevant doc can be skipped. So the **related docs** are decided mechanically, and reading them is enforced:

- `GLOSSARY.md`.
- The linked issue with its comments (`gh issue view <n> --comments`).
- Every active ADR in `docs/adr/`. An ADR may narrow itself with an `applies-to:` list of path globs in its frontmatter. It is then related only to edits of matching paths. An ADR without one is related to every edit.
- Every file under `docs/` that the issue body links.

A doc counts as read only when the agent has read **the whole file itself**:
- Reads in chunks add up to the whole file.
- A partial view does not count.
- A read goes stale when the file's content changes after it.
- A subagent's reads are its own: its parent's context is not its context.

A hard deny on Edit, Write, MultiEdit and NotebookEdit, and on `git commit` as the backstop for changes made through Bash, lists exactly which docs are unread or stale. Where the hook's input is uncertain or undocumented, the check requires a re-read and never skips one.

## Considered options

- **The model chooses the relevant ADRs, with hooks only reminding it**: rejected by the user. A doc left to judgement is a doc that can be ignored.
- **Parsing every Bash command for writes**: rejected. That is what made the old guard 1,445 lines. The commit gate catches Bash-made changes before they land.

## Consequences

- Forced reads apply where the trace does: in traced repositories, to files inside the repository's working tree (ADR 0006).
