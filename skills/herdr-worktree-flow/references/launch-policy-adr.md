# ADR: Explicit Codex Agent Launch Policy

Status: Accepted

## Context

Herdr worktree agents need predictable launch settings so the issue orchestrator can create implementer and review agents without guessing at approval mode, sandbox mode, or model selection.

Silent model fallback creates hidden behavior changes and makes failures harder to diagnose. The PR monitor is a script process, so it should not be treated like a Codex agent.

## Decision

Use an explicit launch policy for every Codex agent in this workflow:

- Approval mode: `never`
- Sandbox mode: `workspace-write`
- Issue orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- Implementer agent: `codex -a never -s workspace-write -m gpt-5.4-mini`
- Review orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- PR monitor: no model flag, because it is a script process

If a configured model is unavailable or fails to launch, the issue orchestrator must report a blocker instead of substituting another model.

## Consequences

- Launches become deterministic and auditable.
- The issue orchestrator must preserve the same policy for every implementer, reviewer, and follow-up Codex agent it spawns.
- Model availability issues surface immediately instead of being masked by fallback.
- The workflow becomes slightly stricter to operate, but review and lifecycle logging can now record the exact expected and actual launch mode for each spawned agent.
