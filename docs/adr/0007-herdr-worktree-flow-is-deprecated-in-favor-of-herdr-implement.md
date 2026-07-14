# ADR-0007: herdr-worktree-flow is deprecated in favor of herdr-implement

## Status
Accepted

## Date
2026-07-13

## Context
`herdr-worktree-flow` was originally the repository's live-agent issue orchestration skill: create a worktree, brief an issue orchestrator, dispatch implementer and review agents, and monitor PR feedback. That path was useful before the daemon-driven `herdr-implement` workflow existed.

`herdr-implement` now provides the supported issue implementation lifecycle. Keeping two active issue-execution stories creates avoidable documentation drift and invites new work to land on the older orchestrator even though the daemon-driven path is the one we want to standardize on.

At the same time, a few workflow-owned utilities still live under `herdr-worktree-flow`, including the completion utility and PR-monitor support scripts. Those pieces remain useful as transitional infrastructure and do not justify keeping the full orchestrator story as an equal path.

## Decision
Deprecate `herdr-worktree-flow` as the primary issue-implementation workflow.

New issue execution should use `herdr-implement`. `herdr-worktree-flow` remains available only as legacy workflow documentation and as the home for transitional helper scripts until separate follow-up issues retire or relocate them.

The intended migration path is:

1. Use `herdr-implement` for daemon-driven issue execution, recovery, and verification.
2. Keep `herdr-worktree-flow` only for legacy handoff guidance, the shared completion utility, and the PR-monitor support scripts that have not yet been replaced.
3. Remove or relocate remaining `herdr-worktree-flow` helpers only through separate issues once their replacements exist.

## Alternatives Considered

### Keep both workflows equally supported
- Pros: no immediate documentation churn.
- Cons: leaves two active stories for the same work and weakens the standard path.
- Rejected: the daemon-driven workflow is the clearer default.

### Remove `herdr-worktree-flow` immediately
- Pros: simplest end state.
- Cons: would force a broader cleanup of references, scripts, and recovery guidance.
- Rejected: the repository still depends on a few transitional helper scripts.

### Deprecate `herdr-worktree-flow`
- Pros: records the new default, preserves transitional helpers, and keeps migration explicit.
- Cons: leaves two sets of docs in the repo temporarily.
- Accepted: this matches the current state without pretending the migration is already complete.

## Consequences
- New issue work should point to `herdr-implement`, not `herdr-worktree-flow`.
- `skills/herdr-worktree-flow` should be treated as legacy/deprecated documentation.
- The completion utility and PR-monitor scripts may remain temporarily, but their continued presence should be justified by separate issues.
- No `herdr-implement` runtime, provider-launch, lifecycle, or state-store seam changes are required by this decision.
