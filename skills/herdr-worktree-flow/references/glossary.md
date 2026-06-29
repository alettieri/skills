# Glossary

## Agent launch policy

The explicit combination of approval mode, sandbox mode, and model selection used when launching a Codex agent in this workflow. For Herdr worktree flow, that means `-a never`, `-s workspace-write`, and the role-specific model flag.

## Issue orchestrator

The Codex agent in the primary issue tab that owns the end-to-end lifecycle for the issue worktree. It coordinates implementation, review, verification, commit, push, PR creation, and PR monitoring.

## Implementer agent

The Codex agent that makes repository changes in response to the issue contract or review findings. It is launched separately from the issue orchestrator and uses `codex -a never -s workspace-write -m gpt-5.4-mini`.

## Agent run

A single delegated unit of work owned by one role, identified by a run id and carried through a result artifact plus a completion notification. In this workflow, implementer and review tasks are both agent runs.

## Completion notification

The small machine-readable message that wakes the issue orchestrator after a delegated run writes its result artifact. In this workflow the message is `AGENT_RUN_COMPLETE <runId> <resultPath>`.

## Result artifact

The JSON file written by the delegated agent before it sends completion notification. It is the source of truth for the run's status, summary, and evidence.

## Deadline blocker

A run that has reached or passed its recorded deadline without an accepted completion artifact. The deadline is a recovery signal, not an autonomous timer, and it requires the issue orchestrator to treat the run as blocked until it is resolved.

## Review orchestrator

The Codex agent that runs the review pass for the worktree, either against the local diff before a PR exists or against the PR after it exists. It uses `codex -a never -s workspace-write -m gpt-5.5`.

## Silent fallback

Replacing a configured model with another model, or omitting the model flag, without explicitly surfacing the failure to the user or workflow. This is forbidden in this skill because it hides launch problems and weakens traceability.
