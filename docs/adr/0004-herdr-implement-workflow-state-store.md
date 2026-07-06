# ADR-0004: herdr-implement will use a workflow state store module

## Status
Accepted

## Date
2026-07-06

## Context
After extracting the Herdr adapter, Agent lifecycle, and result artifact modules, runtime still owns durable workflow state concerns: exported state types, `.agent` state paths, JSON read/write, workflow run normalization, daemon handle normalization, role Agent map normalization, script run normalization integration, and context defaults.

That state behavior is a separate reason to change from bootstrap and daemon phase routing. It is also the next dependency that makes later bootstrap/daemon orchestration splits noisy.

## Decision
Extract durable workflow state handling into a workflow state store module.

The store should own state path rules, file-backed load/save functions, durable state types, compatibility normalization, and test-facing read/write helpers. Runtime should call the store at persistence points but should not own raw JSON state file read/write or compatibility normalization.

Runtime keeps bootstrap orchestration, daemon phase routing, daemon loop behavior, summary printing, issue/reference parsing, repository detection, and calls to persist state.

## Alternatives Considered

### Split bootstrap runtime first
- Pros: reduces runtime size around startup behavior.
- Cons: bootstrap would still depend on state helpers buried in runtime.
- Rejected for order: state store makes this future split easier.

### Split daemon runtime first
- Pros: isolates daemon stepping.
- Cons: daemon routing currently persists state directly.
- Rejected for order: state store gives daemon routing a clearer seam.

### Workflow state store first
- Pros: concentrates durable compatibility behavior and simplifies later orchestration splits.
- Cons: moves widely imported types and requires careful compatibility tests.
- Accepted: it is the clearest next deepening step.

## Consequences
- Durable state shapes must remain backward compatible; this decision does not introduce migrations.
- Store tests should cover missing files, malformed state, compatibility normalization, role Agent maps, pending/accepted Agent runs, script run normalization integration, context defaults, and read/write round trips.
- Runtime tests should continue to prove bootstrap and daemon integration through the store.
- After this module lands, reconsider splitting bootstrap orchestration from daemon stepping.

## Implementation Notes
- Tracked by issue #38.
- Implementation was in progress when this ADR was written.
