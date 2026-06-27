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
