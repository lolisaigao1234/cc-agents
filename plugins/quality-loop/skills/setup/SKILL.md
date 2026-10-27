---
name: setup
description: Set up the quality loop in this repository — detect checks, verify they run, and draft REVIEW.md.
disable-model-invocation: true
---

# Setup

`ql` in this skill means `"${CLAUDE_PLUGIN_ROOT}/bin/ql"`: write that full path in every command (a shell variable holding it is lost between commands and does not split under zsh). Run it from the repository root.

## 1. Detect and run the checks

`ql init`, then `ql checks`. The checks are what make the loop safe: every round is compared against them and reverted on regression. Each check is `{ "name", "cmd", "required", "timeoutSec" }` in `.quality-loop/config.json`.

Fix what you see, with the user's agreement: a check that cannot run here (missing tool, service, credentials) becomes `"required": false` or goes; a check the repository clearly has but detection missed (CI workflow steps in `.github/workflows/`, a `justfile`, `tox.ini`) gets added. Prefer the fast commands CI runs on every PR. Run `ql checks` again until each required check runs to a result.

Done when: every required check runs, and the user has seen which ones pass and fail today.

## 2. Draft REVIEW.md

`.quality-loop/REVIEW.md` is read by every bug hunter. Draft it from what the repository already says — `CLAUDE.md`, contributing docs, lint configs, and the subjects of recent reverts and fixes (`git log --format=%s -n 300 | rg -i 'revert|fix'`) — then let the user edit it. Good entries:

- what failure looks like here, concretely ("a handler that returns 200 after a failed write")
- what to always flag, and what never to flag
- paths to skip (also as globs in `review.skipPaths`)

Keep it under forty lines; every line costs every hunter.

## 3. Wire the rest

Tell the user, and do each they agree to:

- Commit `.quality-loop/config.json`, `.quality-loop/REVIEW.md` and `.quality-loop/.gitignore`; runtime files stay ignored.
- Sessions here compact at `loop.maxContextTokens` (300k): `ql init` set `autoCompactWindow` in `.claude/settings.local.json`, which stays personal. `null` turns the cap off.
- `review.depth` is `standard`; `deep` (six lenses, five voters) pays off where one missed bug costs more than the review time.
- To tune the reviewer against this repository's own past incidents: `/quality-loop:tune-reviewer`.
- Lines worth adding to `CLAUDE.md` for long runs:
  `When a step doesn't need my input, keep going. Put status notes in the same message as your next action.`
  `End every run with three headings: Blocked on me, Changed, Found.`
