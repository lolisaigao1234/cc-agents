# cc-agents

This repository ships **trace**, a Claude Code plugin that keeps a model's work tied to the reason for it and to the project's decisions.

## The trace

**Trace**:
The chain of records that ties a change to its reason: an issue, its branch, its commits, its pull request, and the progress comments on the issue.
_Avoid_: audit trail, traceability chain

**Pipeline step**:
One stage of producing a traced change. The steps are listed in ADR 0006.
_Avoid_: phase, stage

**Traced repository**:
A repository whose owner has opted it in to the trace.
_Avoid_: enabled repo

**Linked issue**:
The open issue that the current branch belongs to.
_Avoid_: current ticket

**Ticket**:
An issue describing one vertical slice of work, under a parent issue.
_Avoid_: story

**Parent issue**:
The issue that holds an effort's goal and decisions, whose tickets are its sub-issues.
_Avoid_: epic

**Progress comment**:
A comment on the linked issue recording a round of work's progress, decisions and verification results.
_Avoid_: status update, round comment

**Bypass**:
The human's switch for turning the trace off for a session.
_Avoid_: override, escape hatch

## Doc authority

**Related docs**:
The docs an agent must have read before it may change a file. Which docs these are is decided by ADR 0007, not by the agent.
_Avoid_: governing docs, authoritative docs, relevant docs

**Full read**:
An agent's own read of every line of a file in its current form.
_Avoid_: skim, partial read

**Stale read**:
A read of a file that has changed since it was read.

**Active ADR**:
A decision record still in force.

## Archive

**Archive**:
The human's store of superseded docs, outside every agent's reach.
_Avoid_: attic, old docs, deprecated folder

**Superseded**:
Replaced by a newer decision.
_Avoid_: deprecated, obsolete

## Guardrails and view

**Hard block**:
A refusal of an agent's tool call, which the agent cannot proceed past.
_Avoid_: warning, notice

**Nudge**:
A hard block that applies once, and lets the next attempt through.

**Guard**:
The hard block on commands that destroy work or history, or that write the switches (Claude Code's settings and installed plugins).
_Avoid_: safety hook, git guard

**Archive block**:
The hard block on agents touching the archive.

**Band**:
The plugin's at-a-glance view of the trace.
_Avoid_: status bar
