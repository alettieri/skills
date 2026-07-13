# Completion & Escalation Contract

Two notification channels, one artifact shape. Both channels write a JSON result artifact to a
recorded path first, then invoke a script that resolves the target's pane, delivers a short
recognizable message, presses Return, and retries delivery on failure. The artifact is always the
source of truth — the delivered message only wakes the receiving orchestrator so it goes and reads
the artifact.

## Result artifact shape

```json
{
  "schemaVersion": 1,
  "runId": "string",
  "role": "implementer | reviewer | issue-orchestrator",
  "phase": "string",
  "status": "complete | blocked | failed",
  "summary": "string",
  "payload": {}
}
```

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Fixed. Any other value is rejected. |
| `runId` | non-empty string | Identifies this delegated run. Must match the `--run-id` the notifying script was invoked with. |
| `role` | `implementer` \| `reviewer` \| `issue-orchestrator` | Which channel a role may use is fixed — see below. Must match the `--role` argument for channel 1; for channel 2 it must always be `issue-orchestrator`. |
| `phase` | non-empty string | The lifecycle phase this run belongs to (e.g. `implementing`, `reviewing`, `pr-monitoring`). Must match the `--phase` argument. |
| `status` | `complete` \| `blocked` \| `failed` | Which values are legal depends on the channel — see below. |
| `summary` | non-empty string | One or two sentences a human or the receiving orchestrator can act on without opening the payload. |
| `payload` | object | Role-specific evidence. Defaults to `{}` if omitted. |

`payload` shape guidance (not schema-enforced field by field — the receiving orchestrator reads it,
it is not validated key-by-key by the notification scripts):

- **Implementer**: changed files, checks run (or deferred, with reasons), blockers if any.
- **Reviewer**: verdict, findings grouped by severity (`Block` / `Major` / `Minor` / `Nit`).
- **Issue orchestrator** (channel 2 only): what was tried, why it couldn't be resolved, what decision
  is needed from the human.

## Channel 1 — Implementer/Reviewer → Issue orchestrator

Routine, sent once per delegated run, for `role` of `implementer` or `reviewer`.

```bash
node skills/herdr-worktree-coordinator/scripts/agent-run-complete.ts \
  --run-id <runId> --role <implementer|reviewer> --phase <phase> \
  --result <resultPath> --notify-target <issueOrchestratorAgentName>
```

Validation performed by the script before it sends anything:

- The artifact exists and parses as JSON.
- `schemaVersion` is `1`.
- `runId`, `role`, and `phase` in the artifact match the CLI arguments exactly.
- `role` is one of `implementer`, `reviewer` (both in the CLI flag and the artifact).
- `status` is one of `complete`, `blocked`, `failed`.
- `summary` is a non-empty string.
- `payload`, if present, is an object.
- `--notify-target` resolves (via `herdr agent get`) to a concrete Claude agent pane, not a shell,
  tab, or terminal id.

Delivery: `AGENT_RUN_COMPLETE <runId> <resultPath>` plus human-readable role/phase/status/summary
lines, sent with `herdr agent send`, followed by `herdr pane send-keys <pane> Return`. Up to 3
delivery attempts with a short backoff; a `.agent/runs/<runId>/notification.json` marker is written
only after a successful delivery, recording the target, resolved pane id, timestamp, and attempt
count.

The issue orchestrator, on receiving the notification, must independently re-validate `schemaVersion`,
`runId`, `role`, and `phase` against the run it is expecting, and confirm the current lifecycle state
allows that role/phase to complete, before advancing state. `blocked` and `failed` never advance
state — the issue orchestrator resolves the run itself if it can, or escalates through channel 2.

## Channel 2 — Issue orchestrator → Main orchestrator

Blockers only. Sent only when the issue orchestrator hits something it cannot resolve on its own
and needs human input. `role` is always `issue-orchestrator` — there is no `--role` flag on this
script, since only one role ever uses this channel.

```bash
node skills/herdr-worktree-coordinator/scripts/agent-run-blocked.ts \
  --run-id <runId> --phase <phase> \
  --result <resultPath> --notify-target <mainOrchestratorAgentName>
```

Validation is the same as channel 1 with two differences:

- The artifact's `role` must be exactly `issue-orchestrator`.
- `status` must be `blocked` or `failed` — **`complete` is rejected**. Reporting successful
  completion (PR merged, workspace cleaned up) through this channel is out of scope for v1; the
  human checks on finished tickets themselves.

Delivery: `AGENT_RUN_BLOCKED <runId> <resultPath>` plus phase/status/summary lines, using the same
send-then-Return-then-retry-then-marker mechanism as channel 1.

## Manual recovery

Directly typing or sending `AGENT_RUN_COMPLETE`/`AGENT_RUN_BLOCKED` into a pane is legacy/manual
recovery only — for example, if a notification script run itself failed after the artifact was
already written correctly. It is not the normal path; always prefer re-running the script, since it
re-validates the artifact and writes the notification marker.
