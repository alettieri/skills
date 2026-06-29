# Agent Run Completion Contract Design

Date: 2026-06-29
Status: Draft for review
Skill: `herdr-worktree-flow`

## Context

The `herdr-worktree-flow` skill uses an issue orchestrator, an implementer agent, and a review orchestrator agent inside a Herdr worktree workspace. The current flow says the issue orchestrator waits for the implementer or reviewer to become idle or blocked before advancing the lifecycle.

That wait model makes the issue orchestrator responsible for repeatedly observing sub-agent runtime state. The desired change is to preserve the current issue lifecycle and tab topology while replacing normal agent-state polling with deterministic sub-agent completion signals.

The PR monitor already follows a useful pattern: a separate process polls the external PR state and sends actionable notifications to the issue orchestrator only when relevant state changes. This design applies a similar notification model to implementer and reviewer runs, but without adding a new background process.

## Goals

- Make implementer and reviewer completion agent-pushed instead of orchestrator-polled.
- Keep the issue orchestrator as the owner of lifecycle transitions.
- Preserve the existing three-agent topology and Herdr `agent send` communication model.
- Use durable local artifacts so completion can be audited and recovered.
- Allow one bounded orchestrator verification step before advancing state.
- Avoid Herdr CLI changes in the first implementation slice.

## Non-Goals

- Do not make the full workflow event-driven in this slice.
- Do not change PR monitoring behavior.
- Do not add a general Herdr event bus.
- Do not make chat transcript prose the source of truth.
- Do not require the issue orchestrator to query Herdr agent runtime state as part of normal completion detection.

## Decision

Introduce an **agent run completion contract** for delegated implementer and reviewer work.

For each delegated task, the issue orchestrator creates an agent run with:

```json
{
  "runId": "issue-12-implement-001",
  "role": "implementer",
  "phase": "implementing",
  "resultPath": ".agent/runs/issue-12-implement-001/result.json",
  "notifyTarget": "issue-12-orchestrator",
  "deadline": "2026-06-29T18:30:00Z"
}
```

The sub-agent must:

1. Complete the delegated work or identify a blocker/failure.
2. Write the result artifact to `resultPath`.
3. Send one structured completion notification to `notifyTarget`.

The notification wakes the issue orchestrator. The result artifact is the source of truth.

## Result Artifact Schema

All role completions use one envelope with role-specific payload fields:

```json
{
  "schemaVersion": 1,
  "runId": "issue-12-implement-001",
  "role": "implementer",
  "phase": "implementing",
  "status": "complete",
  "summary": "Implemented the issue and updated tests.",
  "payload": {
    "changedFiles": ["skills/herdr-worktree-flow/SKILL.md"],
    "checksRun": ["node --test skills/herdr-worktree-flow/scripts/*.test.ts"],
    "blockers": []
  }
}
```

Allowed `status` values:

- `complete`
- `blocked`
- `failed`

The first implementation should document the schema. A validator script can be added later if result artifacts are frequently malformed.

## Completion Notification

The completion message should be small and machine-recognizable:

```text
AGENT_RUN_COMPLETE issue-12-implement-001 .agent/runs/issue-12-implement-001/result.json
```

The issue orchestrator must not parse prose from the agent transcript to decide whether a run completed. It should use the message only to identify the run and artifact path, then read and validate the artifact.

## Orchestrator Validation

When the issue orchestrator receives a completion notification, it validates:

1. The result file exists and parses as JSON.
2. `schemaVersion`, `runId`, `role`, and `phase` match the active delegated run.
3. The current lifecycle state allows that role and phase to complete.
4. `status` is one of `complete`, `blocked`, or `failed`.
5. Role-specific evidence is present.

Implementer evidence should include:

- changed files or an explicit explanation that no file changes were required
- implementation summary
- checks run, or checks explicitly deferred with a reason
- blockers, when `status` is `blocked` or `failed`

Reviewer evidence should include:

- review verdict
- findings grouped by severity
- whether Block or Major findings exist
- review scope, such as local diff or PR review

The issue orchestrator may inspect the worktree or the result fields once to verify phase evidence. It should not call Herdr agent status as part of normal completion detection.

## Lifecycle Behavior

The existing lifecycle states remain:

```text
dispatched -> implementing -> reviewing -> fixing -> verified -> pushed -> pr-monitoring -> done
```

The completion contract changes how the issue orchestrator moves between `implementing`, `reviewing`, and `fixing`:

- `implementing`: issue orchestrator dispatches an implementer run and waits for `AGENT_RUN_COMPLETE`.
- `reviewing`: issue orchestrator dispatches a reviewer run and waits for `AGENT_RUN_COMPLETE`.
- `fixing`: issue orchestrator dispatches another implementer run tied to review findings and waits for `AGENT_RUN_COMPLETE`.

After a valid implementer `complete` result, the orchestrator advances to review. After a valid reviewer `complete` result with no Block or Major findings, the orchestrator advances to verification. If the reviewer reports Block or Major findings, the orchestrator dispatches a fix run.

`blocked` or `failed` results do not advance the lifecycle. The issue orchestrator resolves the blocker if possible or reports it to the main orchestrator/user.

## Deadlines And Recovery

Each run has a deadline recorded in `.agent/issue-lifecycle.md` and `.agent/herdr-worktree-flow.json`. The deadline is a recovery contract, not an autonomous timer.

If the issue orchestrator is activated after the deadline and no valid completion notification has been accepted, it reports a blocker instead of polling agent status. Activation can come from a completion notification, a human status request, or a resume of the issue orchestrator session. This slice does not add a watchdog process.

Recovery rules:

- If the result artifact exists but no message arrived, the issue orchestrator may process it only after a human or another agent points it at the artifact.
- If the message arrived but the artifact is missing or invalid, the issue orchestrator rejects the completion and asks the same role agent to rewrite the artifact.
- If a duplicate notification arrives for the same accepted `runId`, the issue orchestrator ignores it.
- If an old run notifies after a newer run has started, the issue orchestrator rejects it as stale.

## Documentation Slice

The first implementation should be documentation-only:

- Add `skills/herdr-worktree-flow/references/agent-run-completion-adr.md`.
- Add glossary entries for `agent run`, `completion notification`, `result artifact`, and `deadline blocker`.
- Update `skills/herdr-worktree-flow/SKILL.md` so implementer and reviewer handoffs use the completion contract instead of waiting for idle or blocked agent state.
- Update `skills/herdr-worktree-flow/references/issue-brief-template.md` so the issue orchestrator is told to use the completion contract.

No Herdr CLI changes or new scripts are required in the first slice.

## Acceptance Criteria

- The skill documentation defines agent runs, result artifacts, completion notifications, and deadline blockers.
- Implementer and reviewer instructions require writing a result artifact before sending a completion notification.
- The issue orchestrator instructions validate artifacts and phase evidence before advancing lifecycle state.
- The issue orchestrator instructions avoid Herdr agent-state polling for normal implementer/reviewer completion detection.
- Recovery behavior is deterministic for missing artifacts, malformed artifacts, duplicate notifications, stale notifications, and missed notifications.
- Existing PR monitor behavior is unchanged.

## Open Follow-Ups

- Add a schema validator script if agents repeatedly produce malformed result artifacts.
- Consider a Herdr-level completion/event primitive only if workflow-level conventions prove insufficient.
