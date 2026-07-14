# ADR-0007: herdr-worktree-flow uses a PR host provider seam

## Status
Accepted

## Date
2026-07-13

## Context

`herdr-worktree-flow` has two PR polling call sites: the worktree-flow monitor script and the daemon-path poll helper in `herdr-implement`. Both needed the same GitHub CLI mechanics for fetching pull request state and check results.

Keeping that behavior duplicated makes future PR host support harder, because each caller would need host-specific branching, shell mechanics, and JSON normalization logic. It also makes the daemon path and the monitor path diverge when behavior changes, as happened with `gh pr checks` exit code `8` tolerance.

## Decision

Use `skills/herdr-worktree-flow/scripts/pr-host-provider.ts` as the accepted PR host provider seam.

The seam owns provider selection, GitHub CLI mechanics, and result fetching. Callers receive already-normalized `PullRequestPayload` and `CheckResult[]` values and do not shell out to `gh` directly.

`createPrHostProvider(name)` defaults to `github` when `name` is null or undefined, returns the GitHub provider for `github`, and throws `Unknown PR host provider: ${name}` for anything else. The GitHub provider preserves existing behavior, including the empty-array special case for "no checks reported", and tolerates `gh pr checks` exit code `8`.

Both PR-script call sites now go through the seam:

- `skills/herdr-worktree-flow/scripts/pr-monitor.ts`
- `skills/herdr-implement/src/pr-poll-helper.mjs`

## Alternatives Considered

### Keep GitHub CLI mechanics embedded in each caller
- Pros: no new module.
- Cons: duplicated subprocess logic, duplicated normalization, and future host support would require touching both scripts.
- Rejected: the issue is specifically about eliminating that coupling.

### Split the seam into separate fetch helpers without provider selection
- Pros: slightly smaller abstraction.
- Cons: caller-side provider branching would still leak into both scripts.
- Rejected: the provider seam needs to own the selection point as well as the mechanics.

### Generalize host normalization into a wider shared module
- Pros: possibly reusable for more than PR polling.
- Cons: this would expand scope beyond the issue and blur the existing `pr-monitor-domain.ts` boundary.
- Rejected: the issue only needs a host-provider seam, not a broader domain refactor.

## Consequences

- The GitHub-specific subprocess code exists in one place.
- Adding a future PR host means adding a new provider implementation rather than changing both callers.
- The daemon path no longer throws on `gh pr checks` exit code `8` when checks are failing.
- `pr-monitor-domain.ts` remains the shared normalization and classification surface, while host selection and shell mechanics move into the new seam.
- The new seam must remain narrow so callers keep receiving normalized shapes rather than host-specific payloads.

## Implementation Notes

- Implemented by issue #74.
- Reused `pr-monitor-domain.ts` for payload normalization and classification helpers.
- Intentionally did not reuse the old caller-local `runGh` helpers; they were deleted to avoid a third duplicate of the same mechanics.
- No ADR-owned seam was bypassed. This issue introduces the seam rather than wrapping or duplicating an existing one.
