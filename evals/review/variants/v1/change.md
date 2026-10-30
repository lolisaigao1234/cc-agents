# v1: family A, verify before review (all on)

The post's first layer: "Most review now happens before a PR exists." The agent runs the checks and shows their output, simplifies the diff and checks behavior end to end before the bug review. Hooks catch type errors as edits land, CLAUDE.md lists the checks, and a red check blocks the PR. All seven ideas of the family are on together.

Order chosen inside the Review step: verify (checks green, end-to-end check) → `/simplify` → checks again → `/code-review` and Matt's `code-review` → `pr`. The post runs the tests, build and linter first and lists the bug hunt, simplify and end-to-end skills together. Simplify comes before the bug review here so the review sees the final diff. The checks run again after simplify because simplify changes code.

## Ideas

### run-tests-build-lint-before-review: implemented
- Quote: "Claude runs the tests, build and linter".
- On: the Review row now starts with "first verify": on a clean checkout of the branch, run the repository's full checks (the ones CLAUDE.md lists, else the test, typecheck, lint and build scripts) and fix until green. The switch's literal text names `npm run check`. The skill is generic across traced repositories, so it points to CLAUDE.md for the command instead, and claude-md-lists-checks names `npm run check` there. The row's "Done when" adds "with no check red at its head that passes at its base", which matches the carve-out below and the gate's meaning of red.
- Added on purpose: "leaving to the progress comment only failures its base already has". In every recent snapshot the replay environment fails one `npm test` case at the base, from vendored-declaration drift (verified on clean-pr33, clean-pr21 and pr35-r0). Without this line, "fix until green" would push the agent into an off-scope change on every case.
- Files: `plugin/skills/trace/SKILL.md` (Review row).

### show-output-not-claim: implemented (agent side)
- Quote: "show the output instead of saying it's done".
- On: the Update row's "Done when" now asks for each check run as the command plus the output that shows its result, never only a claim that it passed. The checks gate's Stop refusal says the same thing.
- Files: `plugin/skills/trace/SKILL.md` (Update row), `plugin/scripts/variant/checks.mjs` (refusal text).

### domain-specific-e2e-check: implemented (hook replay; no live session)
- Quote: "Verification looks different for each domain." The post also describes a pre-PR skill that "checks the behavior end to end".
- On: the Review row says to "check the behavior end to end as the repository's docs say". The domain part lives in the repository, as the post puts it, in a `## Verification` section appended to CLAUDE.md. For a hooks change, that section says to pipe the hook script the hook-input JSON Claude Code sends, for each tool and command the change judges, in a scratch git repository set up the way the hook expects. It says to show each decision printed and to cover every outcome the ADRs define, not only the allowed path.
- Wording is role-level ("the plugin's hooks", "the hook script") because legacy snapshots ship the quality-loop plugin at other paths. The section names no specific inputs, failure modes or bugs.
- Files: `plugin/skills/trace/SKILL.md` (Review row), `repo-append/CLAUDE.md` (`## Verification`).

### simplify-before-review: implemented
- Quote: "one simplifies the diff".
- On: the Review row runs `/simplify` on the diff after verifying and before `/code-review`, then runs the checks again.
- Files: `plugin/skills/trace/SKILL.md` (Review row).

### format-lint-hooks: implemented
- Quote: "plus hooks that run formatters and linters".
- On: a PostToolUse hook on Edit, Write and MultiEdit, for code or config files (`.js/.mjs/.cjs/.ts/.tsx/.mts/.cts/.jsx/.json`) inside a traced repository and outside `node_modules`. It runs the static checks package.json has: `typecheck` and `typecheck:mod`, plus `lint` and `format:check` if they exist. This repository has no linter or formatter, so tsc is the only content, as the switch says. A script that is one plain `tsc` call is run as `npm run --silent <name> -- --noEmit`: the hook runs in the agent's working tree, and a tsconfig without `noEmit` (some snapshots' `typecheck:mod` extends one) would otherwise write compiled `.js` files into the PR on every edit, which the runner grades as changes. Other scripts run as they are. On failure it returns `{"decision":"block","reason":…}` holding the errors.
- To keep it from nagging, it leaves out failures the branch's base also has. These are checked once on a clean checkout of the base and cached. For example, legacy snapshots fail `typecheck:mod` from environment drift. It also stays quiet when the failures match the last report.
- Files: `plugin/hooks/hooks.json` (new PostToolUse entry; every existing entry kept), `plugin/scripts/variant/typecheck-on-edit.mjs`, `plugin/scripts/variant/common.mjs`.

### claude-md-lists-checks: implemented
- Quote: "listed in a short CLAUDE.md".
- On: a `## Checks` section appended to CLAUDE.md: "`npm run check` runs every check this repository has: the type checks, the tests, the plugin's own tests and its validation (`package.json` defines exactly which)." The parenthesis is there because older snapshots have fewer scripts.
- Files: `repo-append/CLAUDE.md` (`## Checks`).

### checks-block-pr: implemented (as a local required check; see the limits below)
- Quote: "Red blocks the merge".
- On: `checks.mjs` runs the full suite as CI would. That means each step of package.json's `check` script run separately, so an early failure cannot hide a later one, on a clean detached worktree of the commit with a copy of the clone's `node_modules`. A symlink would trip the repository's own test that tsc reads nothing outside the tree.
- "Red" means a failure the branch's merge-base with the default branch does not also have. A step can be red at the head and green at the base. Or both can be red and the head has failure lines the base lacks; lines are compared with paths, timings, positions and runner counts stripped. Results are cached per commit under `.git/trace-variant-checks/`.
  - PreToolUse (Bash): denies `gh pr create` and `gh pr ready` (not `--undo`) while red, as the switch says. It matches them only at a command's start, after quoted text is taken out, so a commit message or comment body that mentions them is not denied. A handoff wrapped in `sh -c '…'` is not seen; the Stop gate still covers it.
  - Stop: blocks handing the PR over while HEAD is red, with the failing steps, the new failure lines and the output tail. It blocks once per head commit. A head the agent cannot make green can still stop and explain, and every new red head is refused again. An unconditional block would loop until the budget runs out on any case whose red cannot be fixed inside the PR.
- Why Stop: the replay opens the PR ready (not draft) before the agent starts, so the agent never runs `gh pr create` or `gh pr ready`. Ending the session is how it hands the PR to the human, and that is the moment a required check guards.
- Deviation from the switch: the switch has the agent run `npm run check` itself, inside its sandbox, with a PostToolUse hook recording a pass at the HEAD sha for the gate to consult. Here the hooks run the checks themselves, as Claude Code hook subprocesses, outside the sandbox. Why: "red" must leave out what the base already fails (the replay's drift failure is at the base of most recent snapshots), and that needs a clean run at the base, which the agent never makes; a record of the agent's own run also could not tell a pass on uncommitted changes from a pass at the commit. The effects are under "Choices that need sign-off".
- Files: `plugin/hooks/hooks.json` (new PreToolUse and Stop entries), `plugin/scripts/variant/checks.mjs`, `plugin/scripts/variant/common.mjs`.

## Conflicts and choices
- run-tests (prose) and checks-block-pr (gate) overlap: the prose asks for green before review, and the gate enforces it when the agent stops. Both are kept. The gate also catches fix rounds that break checks after the last run.
- run-tests and format-lint-hooks both run tsc: the hook gives edit-time feedback, the suite is the final word. Both are kept.
- Both hooks fail safe: any unexpected input or internal error exits 0 with no output. Each has an internal deadline (Stop/PreToolUse 1100 s of a 1200 s timeout; edit hook 270 s of 300 s). A hook cut short returns nothing rather than being killed by Claude Code, whose timeout message could name the plugin copy's path, which the runner treats as an answer-key leak.

## Choices that need sign-off
- **Both check hooks run repository code outside the sandbox.** `checks.mjs` runs each step of the commit's `check` script, and `typecheck-on-edit.mjs` runs the static scripts in the working tree, as hook subprocesses: no sandbox, full network, full file reads. Two effects:
  - The gate's verdict comes from a different environment than the agent's own runs (which are limited to GitHub and npm and denied reads of this checkout), so the two can disagree, e.g. on a check that needs the network.
  - Code the agent writes (a package.json script, a test file, a tsconfig) runs unsandboxed at its next edit or stop, and its output comes back to the agent in the block reason. That crosses the answer-key boundary the sandbox's read-deny draws. Leak detection covers it only partly: `R.leak` catches the checkout path only where it appears literally in a tool input, and `R.seen` scans tool results, not hook reasons. Verified: a package.json `typecheck` script set to `cat <file>; exit 1` put the file's text in the edit hook's block reason.
  - If this is not accepted, switch to the design the switch describes: a PostToolUse(Bash) hook records the exit status and HEAD sha of the agent's own `npm run check`, and the PreToolUse and Stop gates consult that record. The base comparison is then lost (the gate would block on the base's drift failure unless the record keeps failing test names and a base run is made some other way), and format-lint-hooks would need the same treatment or be dropped.

## Not implemented (what harness support it would need)
- **show-output-not-claim, grader half.** "A grader compares claims with the harness log of commands actually run" is a metric, not something a variant can add. It needs a grading step that pulls the Bash commands and exit statuses from the transcript (`traces/<id>_rep<k>.json`) and compares them with the verification the progress comment claims, counting unverified "done" claims per case.
- **domain-specific-e2e-check, live headless session.** Driving a real `claude -p` session inside the agent's sandbox needs `api.anthropic.com` in the sandbox's `allowedDomains` and a credential for the nested session. Neither is given to the agent, and both would widen the answer-key boundary. Hook replay with crafted JSON is implemented instead.
- **checks-block-pr, real CI.** A GitHub required status check would need an Actions workflow and branch protection in each replay repository, and a runner with the `claude` CLI that `npm run check` calls for `test:mod` and `validate`. It would also need the agent to wait on CI. The local gate stands in for it.

## Tests run
- `node --check` on every `.mjs` here; `hooks.json` parses.
- After the fixes above, on a scratch build of the pr20-r1 snapshot (440c807, no `archive/`, `.claude/trace.json`, bare `origin`, `npm ci`):
  - Edit hook, base and head failing alike: quiet, and `git status --porcelain --untracked-files=all` shows nothing new (before the fix, `plugins/trace/hooks/band.js` and `plugins/trace/test/band.test.js` appeared).
  - Edit hook with a planted type error the base lacks: blocks with `npm run typecheck:mod` failed and the errors; nothing new in `git status`; the same failures again stay quiet; the base worktree is removed.
  - PR gate on a head red against its base: `gh pr ready` denied; `git commit -m '… gh pr ready …'`, `gh pr comment … --body "… gh pr create"` and `gh pr ready --undo` allowed.
  - Table tests: the plain-tsc pattern (10 cases: `tsc -p …` rewritten; `tsc -b`, `--build`, chained, piped and non-tsc scripts left alone) and the handoff pattern (12 cases) pass. tsc accepts a repeated `--noEmit`.
- 64 crafted-input tests piped into both hooks in a scratch traced repository with a bare `origin`: malformed and unexpected inputs, green and red heads, deny and allow, once-per-head Stop, pre-existing base failures, caching, worktree clean-up, bypass, deadlines.
- Real snapshots built like the replay (no `archive/`, CLAUDE.md appended, `npm ci`): clean-pr33, clean-pr21, pr35-r0 and legacy-ql-06b80d8 all pass the gate (the drift failure is at the base too) and the edit hook stays quiet. A failing test planted in pr35-r0's head is blocked, and only that test is named as new.
