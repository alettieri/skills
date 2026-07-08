# ADR-0002: herdr-implement uses a deep Agent lifecycle module

## Status
Accepted

## Date
2026-07-06

## Context
After the Herdr adapter extraction, runtime still owned Agent-specific behavior: pending run creation, role Agent launch and reuse, prompt rendering, prompt delivery, result artifact handling, rewrite requests, Agent status recovery, and phase routing for Agent outcomes.

This reduced locality. Understanding daemon stepping required also understanding Agent completion, recovery, and prompt mechanics. It also made tests couple daemon phase routing to Agent lifecycle internals.

## Decision
Extract Agent dispatch and pending run processing into one Agent lifecycle module with a workflow-level interface.

The external seam is an operation equivalent to advancing Agent work once. Runtime passes current workflow state, handle state, the Herdr adapter, `cwd`, and `now`; the Agent lifecycle module returns updated state, updated handles, and a daemon step result.

Runtime keeps daemon-level phase routing, script phases, terminal phases, bootstrap, daemon loop behavior, and persistence calls.

## Alternatives Considered

### Dispatch-only extraction
- Pros: smaller first change.
- Cons: pending run recovery and artifact rewrite handling would remain in runtime.
- Rejected: this would be a shallow module and leave the main coupling in place.

### Agent lifecycle extraction
- Pros: one deep module owns Agent-specific dispatch, recovery, and outcome interpretation.
- Cons: larger refactor and broader tests.
- Accepted: this concentrates Agent lifecycle behavior behind one interface.

### Extract result artifacts first
- Pros: narrower artifact module.
- Cons: daemon step would still know Agent recovery policy.
- Rejected for order: result artifacts became the next slice after lifecycle.

## Consequences
- Agent lifecycle behavior belongs in `skills/herdr-implement/src/agent-lifecycle.ts`.
- Runtime should delegate Agent phases and pending Agent runs to the lifecycle module.
- Runtime tests should prove daemon integration; lifecycle tests should prove Agent behavior.
- The Herdr adapter remains the only module that knows Herdr command shapes.

## Implementation Notes
- Implemented by issue #34 and PR #35.
