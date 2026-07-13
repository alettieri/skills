# Skills Index

This directory contains the repository’s skills.

## Herdr-Worktree-Flow

- Folder: `skills/herdr-worktree-flow`
- Purpose: Deprecated legacy live-agent orchestrator for an isolated Herdr worktree; use `herdr-implement` for new daemon-driven issue execution.
- Inputs: issue number/URL and PR workflow context from the project.
- Primary docs:
  - `SKILL.md` (handoff and lifecycle contract)
  - `scripts/pr-monitor.ts` (monitoring and one-shot notification behavior, run with direct `node`)
- Notes: Keep modifications inside the skill folder unless a shared repository policy change is required. Existing completion/monitoring helpers remain as transitional infrastructure until separate issues retire them.

## Herdr-Implement

- Folder: `skills/herdr-implement`
- Purpose: Drive the daemon-oriented Herdr issue workflow that creates or recovers the worktree, starts the daemon, and verifies startup health. It also offers dry-run inspection of the selected workflow graph.
- Inputs: existing issue number or URL.
- Primary docs:
  - `SKILL.md` (daemon-driven lifecycle contract and dry-run entry points)
  - `README.md` (developer commands, dry-run inspection, and E2E validation)
  - `workflows/default.yaml` (built-in issue-to-PR workflow graph)
  - `bin/dry-run.ts` (workflow selection, validation, and graph output)
- Notes: A project-level `.agent/herdr-workflow.yaml` fully replaces the built-in workflow when present.
