---
name: verify
description: Verify a change to this repository with evidence. Runs the repository's checks, then drives the trace plugin's real hooks the way Claude Code calls them. Use before committing a change here, and when asked to prove that one works.
---

# Verify

A change is verified by **evidence**: the commands that ran on the tree as it will be committed, and what they returned.

## Steps

1. **Checks.** Run `npm run check`, after `npm ci` when `node_modules` is missing. Done when it has exited and you hold its exit code and its output.
2. **Hooks.** Run `node .claude/skills/verify/drive-hooks.mjs`, whatever step 1 returned, so that one round shows every failure. It runs the hook commands registered in `plugins/trace/hooks/hooks.json` the way Claude Code calls them, in scratch repositories with the real git and a stand-in `gh`, and prints each call, what it returned, and whether that is what `CALLS` in the script expects of it. When the change alters what a hook returns for a call that `CALLS` lacks, add that call first: the change's own behaviour belongs among the calls printed. Done when it has exited and you hold its exit code and its output.
3. **Report** in this form, wherever you say the change is verified (your reply, the progress comment):

   ```
   verify: PASSED or FAILED
   1. `npm run check`: exit <code>
      <its result: each test run's `ℹ tests`, `ℹ pass`, `ℹ fail` and `ℹ skipped` lines and each `✖` line, or the failing step's error, as printed but without timings>
   2. `node .claude/skills/verify/drive-hooks.mjs`: exit <code>
      <its output from the line "verify hooks: summary" to the end, as printed>
   ```

## What the verdict rests on

- `PASSED` rests on both exit codes being 0 in this run, and on the report carrying both outputs. Anything else is `FAILED`: a non-zero exit, a command that did not run or was cut off, an output you no longer hold.
- For each failure, the report also quotes what failed, as printed: the failing test with its assertion, or the failing step's error; the whole block of each hook call marked `NOT AS EXPECTED`.
- A failure the change did not cause is still `FAILED`. Report it, with what shows that it is not the change's.
- The evidence is of one tree. After any further edit, run both steps again. A step whose result differs between two runs of one tree is `FAILED`, reported with both outputs. Timings (`duration_ms`, a test's `(…ms)`) are not part of a result.
