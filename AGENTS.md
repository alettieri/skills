# Repository Guidelines

## Scope
This repository is a skill collection. Each skill owns its own behavior, tests, and docs in its folder.

## Skills
See [Skills Index](./skills/README.md) to learn about skills in this project.

## How to contribute
- Read the skill’s `SKILL.md` before changing its files.
- Keep edits scoped to that skill folder unless required for cross-skill dependencies.
- Prefer small, issue-driven commits (example: `Issue #2: add one-shot PR monitor notifications`).
- Add or update tests for any behavior change.

## Common commands
- `npm run pr-monitor:help`
- `npm test`
- `npm run tsx -- skills/herdr-worktree-flow/scripts/pr-monitor.ts --help`

## Style
- Match local style: ESM JavaScript/TypeScript, 2-space indentation, explicit naming.

## Security
- Don’t commit credentials or sensitive data.
