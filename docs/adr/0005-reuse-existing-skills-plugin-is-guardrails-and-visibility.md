---
status: accepted
date: 2026-10-28
issue: "#3"
---

# 0005: Reuse existing skills and Claude Code; the plugin is guardrails and visibility only

The quality-loop plugin grew to about 8.7k lines of Node. Most of it reimplemented review, fix and debug loops that Matt Pocock's skills and Claude Code's own tools now provide; much of the rest defended the loop's own state against the model. We replace it with a plugin, `trace`, that adds only what no existing tool does: hooks that enforce the trace and doc authority (ADRs 0006–0008), the guard on commands that destroy work or history, and a mod that shows the trace: the band and a `/trace` command.

The work itself goes through existing skills:

| Need | Use |
|---|---|
| Plan, spec, tickets | Matt's `grilling`, `domain-modeling`, `to-spec`, `to-tickets` |
| Build | Matt's `implement`, `tdd` |
| Debug | Matt's `diagnosing-bugs` |
| Review | Claude Code's `/code-review` for bugs; Matt's `code-review` for standards and drift from the issue |
| PR body | Matt's `pr` |
| Orchestration | Claude Code's Workflow tool, not custom agents |

- `plugin.json` declares `mattpocock-skills@claude-plugins-official` as a dependency, so the reused skills are always present.
- The plugin ships two skills. `trace` is model-invokable and maps the pipeline onto the skills above. `setup` is user-only. Skills stay short: they steer a capable model and do not script it.
- When sources disagree, Matt's skills and the claude.dev posts win over TStack. Nothing more is taken from TStack.

Supersedes the archived ADRs "A deterministic core decides what counts; the model decides what is wrong", "A finding is the same finding where its lines went, not where its text looks alike", "A second model reviews through GitHub Copilot CLI, as one more lens" and "full-send takes a finished loop to a merged PR, and merges on green CI".

## Consequences

- The old code is deleted, not archived, and nothing shims it. The git tag `quality-loop-v0.1.0` marks its last commit; `trace` starts at 0.2.0.
- A review step that votes on findings, as the old loop did, comes back only as a plugin `workflows/` script, and only once Claude Code's `/code-review` proves too noisy.
