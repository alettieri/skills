# ADR-0006: herdr-implement uses a provider launch-policy seam

## Status
Accepted

## Date
2026-07-11

## Context
Issues #57 and #58 introduced a provider-agnostic launch contract for `herdr-implement`. Workflow roles now choose an active provider with `agent`, while provider-specific launch settings live in provider blocks instead of flat top-level fields.

That split prevents workflow normalization from duplicating launch mechanics and keeps Herdr command construction separate from provider policy. It also preserves a clear boundary for future changes: workflow schema validation can evolve independently of the CLI mechanics that actually start an Agent.

## Decision
Use `skills/herdr-implement/src/provider-launch-policy.ts` as the accepted provider launch-policy seam.

The seam owns provider launch normalization, active-provider validation, launchable-role validation, and provider argv construction. `workflow.ts` delegates provider launch normalization and launchability checks to that seam. `herdr-adapter.ts` owns Herdr command mechanics and passes only the argv tail after `--` to the seam when launching an Agent.

`agent` selects the active provider for a role. Known provider blocks hold launch-specific config. Inactive known provider blocks are allowed, retained in normalized workflow data, and ignored by launch resolution.

`herdr-worktree-flow` stays Codex-specific unless a separate issue changes it. This ADR applies to `herdr-implement` workflow roles only and does not generalize the Herdr worktree-flow launch policy.

## Alternatives Considered

### Keep launch policy embedded in workflow normalization
- Pros: fewer modules.
- Cons: workflow schema, validation, and argv construction remain tangled.
- Rejected: this duplicates launch policy logic across the workflow and adapter boundaries.

### Move provider selection into the Herdr adapter
- Pros: the adapter would know the full launch story.
- Cons: provider policy would be mixed with Herdr CLI mechanics.
- Rejected: this would violate the adapter boundary established in ADR-0001.

### Keep provider launch policy in workflow only
- Pros: the workflow would own all launch validation.
- Cons: the adapter would still need to know provider argv shapes.
- Rejected: argv assembly belongs with the provider seam, not with workflow routing.

## Consequences
- Supported providers are `codex` and `claude`.
- Supported Codex launch config lives under `codex.approval` and `codex.sandbox`.
- `codex.approval` accepts `untrusted`, `on-failure`, `on-request`, and `never`.
- `codex.sandbox` accepts `read-only`, `workspace-write`, and `danger-full-access`.
- Supported Claude launch config lives under `claude.permissionMode`.
- `claude.permissionMode` accepts `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, and `plan`.
- Codex launches as `codex -a <approval> -m <model> -s <sandbox>`.
- Claude launches as `claude --model <model> --permission-mode <permissionMode>`.
- The built-in default workflow declares `roleDefaults.agent: codex`.
- Workflow normalization seeds `roleDefaults.reuse: true`, `roleDefaults.codex.approval: on-request`, `roleDefaults.codex.sandbox: workspace-write`, and `roleDefaults.claude.permissionMode: auto`.
- Flat launch fields such as `approval`, `sandbox`, and `permissionMode` are rejected.
- Unknown provider blocks are rejected.
- Launchability validation applies to roles referenced by `agent` phases. Declared but unused roles do not need to be fully launchable.

## Implementation Notes
- Implemented by issues #57 and #58.
- The seam is tested in `skills/herdr-implement/test/provider-launch-policy.test.ts`, while workflow integration is covered in `skills/herdr-implement/test/workflow.test.ts` and Herdr argv wiring is covered in `skills/herdr-implement/test/herdr-adapter.test.ts`.
