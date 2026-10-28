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

Moving a file **into** the archive is allowed.

Enforcement has two layers. The plugin's PreToolUse hook applies in every repository, because plugins cannot ship permission rules. In traced repositories, `/trace:setup` also adds Claude Code's own `Read(./archive/**)` deny rule to project settings.

## Considered options

- **A SubagentStart notice or injected context telling agents to stay out**: rejected. A notice is not enforcement; only a deny is.

## Consequences

- The hook reads command text. A search that reaches the archive without naming it, such as a repository-wide `rg`, must still be denied. Any route that cannot be closed is recorded here with the reason.
- That the hook fires for Workflow agents and Claude Code's `/code-review` fork is still to be verified. Until it is, those agents are not counted as covered.
- Code is never archived. Git history and tags keep it, and archived code would be exactly the context this exists to keep out.
