---
status: accepted
date: 2026-10-28
issue: "#3"
---

# 0008: Superseded docs live in a human-only archive that no agent can read

A superseded ADR or doc in the model's context is a stale spec it may follow. Deleting it loses the human's record. So superseded docs move to `archive/` at the repository root, mirroring their original paths, each with a one-line "Superseded by ADR-NNNN" header. Active docs name an archived doc by title, never by link.

The archive is managed by the human alone. Every model and agent, subagents and workflow agents included, is hard-denied:
- reading, searching or listing inside it;
- editing, writing or deleting there;
- moving or copying anything out of it;
- Bash commands that read a path inside it.

Moving a file **into** the archive is allowed, and so are creating the directories it needs and staging and committing the move.

Enforcement has two layers. The plugin's PreToolUse hook applies in every repository, because plugins cannot ship permission rules. In traced repositories, `/trace:setup` also adds Claude Code's own `Read(./archive/**)` deny rule to project settings.

## Considered options

- **A SubagentStart notice or injected context telling agents to stay out**: rejected. A notice is not enforcement; only a deny is.

## Consequences

- The hook reads command text. A search that reaches the archive without naming it, such as a repository-wide `rg` or Grep, is still denied, unless the command excludes the archive. Without the hook, both return archive content (verified live, #5).
- A root `.ignore` that lists `/archive/` counts as excluding it for the tools that honour it: `rg`, `fd`, `ag` and the Grep tool (verified live for Grep). Flags that turn ignore files off or follow symlinks void that. The Glob tool does not honour `.ignore` (verified live), so a Glob over the whole repository stays denied.
- Git commands that print history (`log -p`, `show`, `diff` between revisions) are denied when what they print touches `archive/`. The hook asks git which paths they would print.
- A search that starts outside any repository may reach other repositories and their archives. It is denied unless the repositories below it can be found quickly.
- Verified live (#5): the hook fires in the main session, in subagents, in Workflow agents and in the `/code-review` fork.
- Routes that stay open, and why:
  - A path built at run time, from variables or a script, is not visible in the command text.
  - Git history still holds superseded docs at their old paths (`git show <old-rev>:CONTEXT.md`). Blocking that would mean refusing reads of history altogether.
  - A git object named by its hash (`git cat-file -p <sha>`) does not say where it lives.
  - The hook knows how the common search, copy and archive tools walk directories. A tool it does not know, such as a formatter or linter run through `npx`, can walk into the archive unseen.
  - An archive in a repository nested inside another repository is protected only when named or reached through its own repository.
- Code is never archived. Git history and tags keep it, and archived code would be exactly the context this exists to keep out.
