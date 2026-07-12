# Repository Guidelines

## Scope
This repository is a skill collection. Each skill owns its own behavior, tests, and docs in its folder.

## Skills
See [Skills Index](./skills/README.md) to learn about skills in this project.

## How to contribute
- Read the skill’s `SKILL.md` before changing its files.
- Check `docs/adr/` for accepted architecture decisions before revisiting module boundaries.
- Keep edits scoped to that skill folder unless required for cross-skill dependencies.
- Prefer small, issue-driven commits (example: `Issue #2: add one-shot PR monitor notifications`).
- Add or update tests for any behavior change.

## herdr-implement architecture
- Before changing `skills/herdr-implement/src/runtime.ts` or adjacent runtime modules, read the ADRs in `docs/adr/`.
- Current accepted seams: `herdr-adapter.ts` owns Herdr CLI mechanics, `agent-lifecycle.ts` owns Agent dispatch/recovery, `result-artifact.ts` owns Agent result artifacts, `capture.ts` owns shared capture helpers, and `script-phase.ts` owns script execution.
- Before changing provider launch behavior in `skills/herdr-implement/src/workflow.ts` or `skills/herdr-implement/src/herdr-adapter.ts`, read ADR-0006 and the provider launch-policy seam in `skills/herdr-implement/src/provider-launch-policy.ts`. That contract is provider-agnostic: `agent` selects the active provider, provider blocks hold launch-specific config, inactive known provider blocks are allowed, and `herdr-worktree-flow` remains Codex-specific unless a separate issue changes it.
- The next accepted seam is `workflow-state-store.ts` for durable state paths, read/write, state types, and compatibility normalization; see ADR-0004 before implementing or revising it.
- Layout changes for `herdr-implement` should follow ADR-0005: source in `src/`, thin command entrypoints in `bin/`, built-in Workflow Scripts in `workflow-scripts/`, and tests in `test/`.

## Common commands
- `node skills/herdr-worktree-flow/scripts/pr-monitor.ts --help`
- `node --test skills/herdr-worktree-flow/scripts/*.test.ts`
- `cd skills/herdr-worktree-flow && node scripts/pr-monitor.ts --help`

## Style
- Match local style: ESM JavaScript/TypeScript, 2-space indentation, explicit naming.

## Security
- Don’t commit credentials or sensitive data.
