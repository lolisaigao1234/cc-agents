# Round step 2: Review with parallel bug hunters

Run `ql brief hunters` now; the first time, add `--intent "<intent>"` with the change's intent (the user's words, the PR description, or the commit messages). It rewrites the round's scope diff, so it includes any edit made since `ql round begin` (debug's fix), and writes one brief per lens holding:

- the lens name and its focus
- the intent and the finish line
- the scope diff path and the changed files; the hunter may read any file for context
- the paths of `REVIEW.md` and `CLAUDE.md` if present
- in rounds after the first: the file of earlier findings, so the hunter looks for what is new
- the output path `.quality-loop/work/round-<n>/hunter-<lens>.json`

Empty scope (it prints `scope is empty`): `ql ingest --none --lens scope` and go to step 3.

Otherwise spawn one `bug-hunter` subagent per printed line, **all in one message** so they run in parallel, each prompted `Brief: <brief path>`.

As each hunter reports back, `ql ingest <its output path> --lens "<lens>"`, with the lens its brief line names (`lens "<name>"`). Read the rejected lines: `quote-not-found` and `file-missing` are hallucinations the evidence check caught; `skip-path`, `dropped-category` and `nit-cap` are policy. A hunter whose file is missing or invalid gets one re-run with the error message.

Done when: every lens has been ingested (or recorded with `--none`).
