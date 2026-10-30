## What this project is

A Claude Code plugin that keeps a model's work tied to its reason (a GitHub issue) and to the project's recorded decisions (the ADRs). Where this file and an active ADR disagree, the ADR wins.

### Stack

Node ESM (`.mjs`) with no runtime dependencies; types in JSDoc, checked by `tsc`; tests with `node:test` under `test/`; a Claude Code mod, where the plugin has one, in TSX; GitHub through `gh`.

### Goals

- Hooks enforce with hard blocks, not notices, and every deny says what to do next.
- When git or GitHub gives no answer, a hook never guesses and never lets the call through; the ADRs say what it does instead.
- The work itself goes through existing skills and Claude Code's own tools. The plugin adds guardrails and visibility only.
- Merging is the human's step, and only the human can switch the hooks off.

### Non-goals

- A sandbox. The hooks read command text: they are a seatbelt against drift, not a defence against a model working to defeat them.
- Parsing every Bash command for writes. The commit gate catches what Bash changed.
- Merge automation, a local task file, or plugin state the model must be kept from.
- Reimplementing review, fix or debug loops that existing skills provide.

### More

The root `README.md` and the plugin's `README.md` give the exact rules for each part. `REVIEW.md` says what matters when reviewing each part of the code. A review flags code that breaks a convention in these docs, and any line in them that a change makes untrue.
