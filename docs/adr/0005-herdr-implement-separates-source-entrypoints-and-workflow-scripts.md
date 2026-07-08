# ADR-0005: herdr-implement separates source, entrypoints, and Workflow Scripts

## Status
Accepted

## Date
2026-07-08

## Context
`herdr-implement` currently keeps TypeScript orchestration modules, process-invoked TypeScript files, TypeScript tests, shell Workflow Scripts, and helper executables together under `scripts/`. That makes the directory name ambiguous and hides the distinction between daemon implementation, command entrypoints, and workflow assets intended for project override.

## Decision
Separate `herdr-implement` into explicit directories: `src/` for orchestration implementation, `bin/` for thin TypeScript Command Entrypoints, `workflow-scripts/` for built-in executable Workflow Scripts, and `test/` for the Skill Test Harness. Built-in workflow commands should use `workflow-scripts/...` paths with no legacy `scripts/...` compatibility alias. Project overrides live under `.agent/workflow-scripts/` for Workflow Scripts and `.agent/prompts/` for prompts, with workflow-relative assets and built-in assets as fallbacks. Asset lookup belongs in focused resolver code rather than being spread through orchestration modules.

## Consequences
The migration is intentionally structural and behavior-preserving, but it will touch imports, workflow command paths, documentation, and tests. Existing copied workflows that still use `scripts/...` must update to the new `workflow-scripts/...` convention.
