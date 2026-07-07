# ADR: Agent Run Completion Contract

Status: Accepted

## Context

The Herdr worktree flow uses an issue orchestrator, an implementer agent, and a review orchestrator agent. The previous handoff model depended on the orchestrator observing sub-agent runtime state such as idle or blocked transitions.

That model is brittle because it spreads completion detection across repeated state polling. The workflow already has a good precedent in the PR monitor: a separate signal wakes the orchestrator only when there is actionable state to process. This ADR applies the same idea to delegated implementer and review runs without adding a new background service.

## Decision

Every delegated implementer or review task is represented as an agent run with a run id, role, phase, result artifact path, completion target, and deadline.

The delegated agent must:

1. Complete the work or determine that it is blocked or failed.
2. Write a JSON result artifact at the recorded `resultPath`.
3. Invoke the workflow-owned completion utility for the recorded `notifyTarget`.

```bash
node skills/herdr-worktree-flow/scripts/agent-run-complete.ts \
  --run-id <runId> \
  --role <implementer|reviewer> \
  --phase <phase> \
  --result <resultPath> \
  --notify-target <notifyTarget>
```

The utility validates that the artifact exists, parses as JSON, matches the supplied run id, role, and phase, uses schema version `1`, and has an accepted status. It resolves the notify target with `herdr agent get`, rejects targets that are not concrete Codex agents, sends the completion notification, presses Return in the resolved pane, retries delivery up to three attempts, and writes `.agent/runs/<runId>/notification.json` after successful delivery. Direct manual `AGENT_RUN_COMPLETE` messages are reserved for legacy/manual recovery.

The completion notification is intentionally small and machine-recognizable:

```text
AGENT_RUN_COMPLETE <runId> <resultPath>
```

The result artifact is the source of truth. The notification only wakes the orchestrator so it can read and validate the artifact.

## Result Artifact

All completion artifacts use the same envelope:

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
    "checksDeferred": [],
    "blockers": [],
    "architectureNotes": [
      "Reviewed ADR-0001 through ADR-0004 before changing the workflow docs."
    ],
    "reuseNotes": [
      "Reused the existing issue brief template and completion contract instead of inventing a new workflow path."
    ]
  }
}
```

Allowed `status` values are `complete`, `blocked`, and `failed`.

Implementer results should include changed files, a summary, checks run or deferred with reasons, blockers when present, and architecture/reuse notes covering reused modules, intentionally not reused modules, new seams, and seam-bypass risks. Reviewer results should include the review verdict, findings grouped by severity, whether Block or Major findings exist, the review scope, and any DRY or deep-module concerns that surfaced.

## Orchestrator Validation

When the issue orchestrator receives a completion notification, it must validate:

1. The result artifact exists and parses as JSON.
2. `schemaVersion`, `runId`, `role`, and `phase` match the active delegated run.
3. The current lifecycle state allows that role and phase to complete.
4. `status` is one of the accepted values.
5. The role-specific evidence needed for the current run is present.

The orchestrator may inspect the artifact or the worktree once for verification. It should not rely on Herdr agent-state polling as the normal completion mechanism.

For implementation runs, role-specific evidence includes the architecture/reuse notes mentioned above. For review runs, role-specific evidence includes whether the DRY/deep-module check found duplicated behavior, widened interfaces, exported internals, or a need for a new shared module.

## Lifecycle And Recovery

The issue orchestrator advances lifecycle state only after validating a matching completion artifact.

Recovery behavior:

- Missing artifact: reject the notification and ask the same role agent to rewrite the artifact.
- Malformed artifact: reject the notification and ask for a corrected artifact.
- Duplicate notification: ignore it if the same `runId` has already been accepted.
- Stale notification: reject it if a newer run has already started.
- Missed notification: if the artifact exists but no notification arrived, the orchestrator can process it only after a human or another agent points it at the artifact.

`blocked` and `failed` results do not advance the lifecycle. The orchestrator resolves the blocker if possible or reports it to the main orchestrator or user.

## Consequences

- Completion becomes deterministic and auditable.
- The orchestrator no longer needs to poll sub-agent runtime state for normal completion detection.
- Result artifacts create a local record that can be reviewed, retried, or recovered later.
- The workflow remains compatible with the existing three-agent topology and the current PR monitor behavior.
