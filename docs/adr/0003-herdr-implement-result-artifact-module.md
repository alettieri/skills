# ADR-0003: herdr-implement separates Agent result artifacts

## Status
Accepted

## Date
2026-07-06

## Context
The Agent lifecycle module initially owned Agent orchestration and result artifact details. That included reading `result.json`, parsing JSON, validating required fields, checking pending-run contracts, classifying stale artifacts, building accepted run records, merging capture into context, and formatting accepted-run summaries.

Those artifact rules are stable durable-state behavior. Keeping them inside Agent lifecycle made the lifecycle module wider than necessary and made artifact schema changes harder to localize.

## Decision
Extract Agent result artifact handling into a focused module.

The result artifact module owns the artifact interface: file read, JSON parse, required field validation, schema and outcome checks, stale versus invalid classification, capture and payload validation, accepted-run construction, context capture merge, and accepted-run summary text.

Agent lifecycle keeps lifecycle policy: dispatching phases, recovering pending runs, delivering rewrite requests, interpreting Agent status, and deciding when to ask for a rewrite.

## Alternatives Considered

### Keep artifact handling in Agent lifecycle
- Pros: fewer modules.
- Cons: lifecycle remains responsible for durable artifact schema details.
- Rejected: artifact schema bugs and compatibility rules should have locality.

### Generic artifact module for scripts and Agents
- Pros: shared shape for all phase outputs.
- Cons: script phases and Agent completion artifacts have different contracts.
- Rejected: this would couple script execution to Agent result artifacts.

### Agent result artifact module
- Pros: small interface and high locality for artifact schema behavior.
- Cons: another module and test file.
- Accepted: this keeps Agent lifecycle focused.

## Consequences
- Result artifact behavior belongs in `skills/herdr-implement/src/result-artifact.ts`.
- Generic capture helpers can live in `capture.ts` when they are not Agent-specific.
- Script phase capture handling should remain independent from Agent result artifacts.
- Existing durable state shapes must remain backward compatible.

## Implementation Notes
- Implemented by issue #36 and PR #37.
