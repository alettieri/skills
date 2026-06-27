# Glossary

## Agent launch policy

The explicit combination of approval mode, sandbox mode, and model selection used when launching a Codex agent in this workflow. For Herdr worktree flow, that means `-a never`, `-s workspace-write`, and the role-specific model flag.

## Issue orchestrator

The Codex agent in the primary issue tab that owns the end-to-end lifecycle for the issue worktree. It coordinates implementation, review, verification, commit, push, PR creation, and PR monitoring.

## Implementer agent

The Codex agent that makes repository changes in response to the issue contract or review findings. It is launched separately from the issue orchestrator and uses `codex -a never -s workspace-write -m gpt-5.4-mini`.

## Review orchestrator

The Codex agent that runs the review pass for the worktree, either against the local diff before a PR exists or against the PR after it exists. It uses `codex -a never -s workspace-write -m gpt-5.5`.

## Silent fallback

Replacing a configured model with another model, or omitting the model flag, without explicitly surfacing the failure to the user or workflow. This is forbidden in this skill because it hides launch problems and weakens traceability.
