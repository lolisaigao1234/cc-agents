# cc-agents

This repository ships **trace**, a Claude Code plugin that keeps a model's work tied to its reason and to the project's decisions. It does this with hard-blocking guardrails and a view of where the work stands, and leaves the work itself to existing skills.

## The trace

**Trace**:
The chain that ties a change to its reason: issue → branch → commits → pull request → progress comments → close.
_Avoid_: audit trail, traceability chain

**Pipeline step**:
One of the trace's seven steps, in order: Read, Track, Branch, Implement, Review, Update, Close.
_Avoid_: phase, stage

**Traced repository**:
A repository whose owner opted it in to the trace. Outside one, only the archive block and the guard apply.
_Avoid_: enabled repo

**Linked issue**:
The open issue the current branch belongs to, named by the number the branch starts with.
_Avoid_: current ticket

**Ticket**:
An issue describing one vertical slice of work, published as a sub-issue of a parent issue.
_Avoid_: task, story

**Parent issue**:
The issue that holds an effort's goal and decisions; its tickets are its sub-issues.
_Avoid_: epic, map

**Progress comment**:
The comment on the linked issue after each round of work, giving progress, decisions and verification results.
_Avoid_: status update, round comment

**Bypass**:
The switch the human sets when launching Claude Code to turn the trace off. Nothing the model can write sets it.
_Avoid_: override, escape hatch

## Doc authority

**Related docs**:
The docs an agent must have read before it edits: the glossary, the linked issue with its comments, the active ADRs that apply to the edit, and the docs the issue links.
_Avoid_: governing docs, authoritative docs, relevant docs

**Full read**:
An agent's own read of every line of a file as it is now.
_Avoid_: skim, partial read

**Stale read**:
A read of a file whose content has changed since.

**Active ADR**:
An accepted decision record in the ADR folder, as opposed to a superseded one in the archive.

## Archive

**Archive**:
The human-only folder holding superseded docs. Agents may move files into it but never read, change or take anything out.
_Avoid_: attic, old docs, deprecated folder

**Superseded**:
Replaced by a newer decision. A superseded doc lives in the archive with a header naming its successor.
_Avoid_: deprecated, obsolete

## Guardrails and view

**Hard block**:
A hook's refusal of a tool call, which the model cannot proceed past, as opposed to a notice it may ignore.
_Avoid_: warning, nudge (a nudge blocks once, then lets go)

**Guard**:
The hard block on destructive git and file commands.
_Avoid_: safety hook

**Band**:
The line above the prompt that shows the trace: linked issue, pipeline step, related docs read, and pull-request state.
_Avoid_: status bar
