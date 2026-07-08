# ADR-0001: herdr-implement uses a workflow-level Herdr adapter

## Status
Accepted

## Date
2026-07-06

## Context
`skills/herdr-implement/src/runtime.ts` originally mixed workflow policy with Herdr CLI mechanics. Callers and tests had to know raw command argument shapes, output envelopes, JSON parsing details, snake-case versus camel-case variants, pane handle shapes, and missing-resource behavior.

That made the runtime module shallow: the interface to the Herdr mechanics was almost as complicated as the implementation. It also lowered locality because a Herdr CLI output change could require edits in runtime orchestration and tests.

## Decision
Use a workflow-level Herdr adapter module for all Herdr command mechanics.

The runtime asks for workflow operations such as ensuring a worktree, creating a daemon pane, running a pane command, launching a role Agent, sending/submitting a prompt, reading Agent status, and reading Agent transcripts. The adapter owns raw Herdr command arguments, JSON parsing, wrapped `result` unwrapping, output normalization, and command failure details.

Runtime keeps workflow policy: when a worktree is needed, when a daemon should be considered started, how Agent outcomes route workflow phases, and when state is persisted.

## Alternatives Considered

### Keep raw Herdr commands in runtime
- Pros: fewer files and no new module.
- Cons: runtime keeps knowing command shapes and output variants.
- Rejected: this preserves the shallow module that caused the original friction.

### Expose only a raw `runJson(args)` adapter
- Pros: centralizes command execution.
- Cons: callers still know every command shape and parse contract.
- Rejected: this creates a pass-through adapter with little depth.

### Workflow-level adapter
- Pros: a small interface gives callers leverage while Herdr mechanics have locality.
- Cons: adapter tests must cover command and output variants.
- Accepted: this gives the runtime a cleaner seam.

## Consequences
- Herdr CLI behavior belongs in `skills/herdr-implement/src/herdr-adapter.ts`.
- Runtime and Agent lifecycle modules should not build raw Herdr command arrays or parse Herdr output envelopes.
- Adapter tests are the test surface for command shapes, output variants, and malformed Herdr output.
- Recoverable command failures can be represented as adapter-level facts; malformed successful output should fail loudly.

## Implementation Notes
- Implemented by issue #31 and PR #32.
- Dead runtime-local Herdr helpers were removed by PR #33.
