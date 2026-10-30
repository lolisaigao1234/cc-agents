# Review

What a review of this repository reports, and how.

- Report defects only. Drop a finding that is only about style, diagnostics or cleanup: formatting, naming taste, code smells, refactors, dead code, or linter and type-checker warnings that leave the build and tests passing.
- Cite a file and line as the evidence for each finding, and name the input or path that fails. A guess from a name or a signature is not evidence: read the code it calls.
- Tag each finding:
  - **Important**: a defect this branch introduces. It is fixed before merge.
  - **Nit**: a minor defect this branch introduces. Report at most 2 Nits.
  - **Pre-existing**: a defect the branch did not introduce: the same failure happens on the base. It is not the author's to fix here; it goes to a new issue.
- Sort findings by severity, most severe first.
- Open the summary with the count, such as "3 findings: 2 Important, 1 Nit". When there is none, say "Nothing to fix."
- Skip these paths: `vendor/` (declarations Claude Code writes), `package-lock.json`, `node_modules/`.
