> Superseded by ADR-0005 (2026-10-28, #3). Archived: human-managed, not read by agents.

# 0002: A finding is the same finding where its lines went, not where its text looks alike

Date: 2026-10-27 · Status: accepted

## Context

The ledger must tell whether a reported finding is one it already knows, so that a rejected finding is never raised again, a fix that did not hold is counted as a reopen (which can stop the loop for oscillation), and two copies of the same code stay two findings. Two rounds of heuristics that recognised a copy by its text and its neighbourhood (fingerprint plus occurrence index, then the lines around it) never converged. Copy-pasted functions share their neighbourhoods, periodic code has no telling neighbours at all, and a long function puts its name out of view. In each of those cases, fixing copy A reopened A for copy B, or a rejected A swallowed a real bug at B.

## Decision

Follow each finding's lines through the real diff instead of guessing from text:

- **Record:** each finding stores the snapshot tree it was last seen in (the tree `ql ingest` already takes), its lines there, and how many copies of its quote the file held then.
- **Translate:** at ingest, a known finding's quote lines are carried from its tree to the current one through `git diff -U0` of that file (`track.mjs`). Lines before a hunk keep their number, lines after it shift by its delta, and lines inside a changed hunk (or with lines inserted between them) are **gone**. `ingestFindings` stays pure: `loop.mjs` passes the tree and a `translate(file, line, endLine, fromTree)` callback, and unit tests pass a fake.
- **Fallback:** when the lines are gone or there is no tree (an older ledger), the quote is relocated only if it is the one copy in the file now *and* was the one copy when last seen. Otherwise the known finding is not matched.
- **Match:** same file, the known code where translation puts it, and a report at that same place. Both line numbers are exact quote starts, so the same quote must start on the same line, a trimmed or extended quote must lie inside the other, and either must carry the same bug class or category. Different code matches only under the same bug class on overlapping lines. Status rules are unchanged: an open finding merges, a rejected or wontfix one is a repeat, a fixed one reopens.
- **Batch:** a finding is claimed by at most one report of a batch, the nearest. The same quote at different lines is different instances.
- **Ambiguity resolves to new.** A duplicate costs one more verification. A false merge swallows a real bug, and a false reopen fakes oscillation.

A reverted round re-anchors the findings it moves to the restored tree.

## Consequences

- Copy identity is git's alignment of the two versions of the file. Rewriting, adding or deleting a sibling never moves a finding onto another copy, however many copies there are.
- The design's "within ±2 lines" became an exact place, because both sides are exact quote starts and the slack merged identical adjacent lines.
- Code that is cut and pasted is followed only while its quote is unique. A moved block with copies elsewhere comes back as a new candidate, and verification settles it again.
- Deleting one of several byte-identical blocks is attributed wherever git's diff puts the deletion. The two versions of the file cannot tell those blocks apart.
- The fingerprint is kept for the record only. It no longer decides identity.
- Snapshot trees are unreferenced objects. If `git gc` prunes one, its findings fall back to unique-quote relocation.
