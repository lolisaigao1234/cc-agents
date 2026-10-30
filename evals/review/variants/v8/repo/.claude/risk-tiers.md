# Risk tiers

How deep a change's review goes. The change sets the tier, not its author: judge it from its diff, not from what the issue, the PR or the commit messages say about it. Blast radius sets the bar: the more a missed bug would cost, the deeper the review. When a change sits between two tiers, take the higher.

| Tier | What goes here | Review |
|---|---|---|
| Low | Docs written for humans (READMEs, code comments, `docs/agents/`), and changes that only add tests | `/code-review low`; at most two rounds |
| Medium | Ordinary code changes, and changes to sensitive areas: the rest of the hook scripts' code, and text every agent is made to follow the way it follows a system prompt (skills, agent prompts, `CLAUDE.md`, `GLOSSARY.md`, the ADRs) | `/code-review medium`; at most three rounds |
| High | The highest-risk code: any change that touches one of the small set of sensitive paths below | `/code-review xhigh` and `/security-review`; at most three rounds |

## Sensitive paths

A change that touches any of these is High, whatever else it looks like:

- The hook wiring: `plugins/*/hooks/hooks.json`, `plugins/*/scripts/hook.mjs`, `plugins/*/bin/**`.
- The gates, the guard, the halt and the archive block: `plugins/*/scripts/lib/{trace,guard,halt,archive}.mjs`.
- The switches: `.claude/settings*.json`.
- The opt-in and the plugin manifests: `.claude/trace.json`, `.claude-plugin/**`, `plugins/*/.claude-plugin/**`.
- The installer: `plugins/*/skills/setup/**`.
- CI workflows: `.github/workflows/**`.

## Escalation

A second classifier asks whether this particular change needs more scrutiny than its tier gives. A yes is the exception, and it makes the change High.

## In the PR body

State the tier, the sensitive paths the change touches, and any escalation with its reason, so the human knows how closely it was reviewed and where to look.
