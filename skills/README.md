# Skills Index

This directory contains the repository’s skills.

## Herdr-Worktree-Flow

- Folder: `skills/herdr-worktree-flow`
- Purpose: Execute one existing issue in an isolated Herdr worktree with implementation, review, verification, and PR-monitor feedback loops.
- Inputs: issue number/URL and PR workflow context from the project.
- Primary docs:
  - `SKILL.md` (handoff and lifecycle contract)
  - `scripts/pr-monitor.ts` (monitoring and one-shot notification behavior, run with direct `node`)
- Notes: Keep modifications inside the skill folder unless a shared repository policy change is required.

## Herdr-Implement

- Folder: `skills/herdr-implement`
- Purpose: Validate and dry-run the daemon-oriented Herdr issue workflow before any worktree, agent, command, commit, push, PR, or polling side effects occur.
- Inputs: existing issue number or URL.
- Primary docs:
  - `SKILL.md` (validation-only workflow contract)
  - `workflows/default.yaml` (built-in issue-to-PR workflow graph)
  - `scripts/dry-run.ts` (workflow selection, validation, and graph output)
- Notes: A project-level `.agent/herdr-workflow.yaml` fully replaces the built-in workflow when present.
