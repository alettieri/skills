---
name: herdr-implement
description: Promote an existing issue into a daemon-driven Herdr implementation run that creates or recovers the worktree, starts the daemon, verifies startup health, and prints a JSON summary.
---

Use this skill when the user references an existing issue, ticket, or URL and wants the implementation lifecycle started inside Herdr. The skill creates or recovers the worktree, writes the durable state, launches the daemon that owns the lifecycle, confirms startup health, and prints a JSON summary.

`herdr-implement` is the daemon-driven deterministic state-machine lifecycle. `herdr-worktree-flow` is the live-agent orchestrator.

## When to use

- Use it only for an existing issue reference.
- If the user has not provided an issue reference, ask for one and do not create a new issue.
- Extract the tightest identifier you can from the user's reference and pass that to `bootstrap`.

## Lifecycle

- `bootstrap.ts` requires `HERDR_ENV=1` and a non-empty `--issue`.
- `--help` works without `HERDR_ENV` and should describe the side effects up front.
- `dry-run.ts` stays read-only and can be used for workflow inspection and validation.
- Example:
  ```bash
  HERDR_ENV=1 node skills/herdr-implement/bin/bootstrap.ts --issue 70
  ```
- `bootstrap` normalizes the issue reference, detects the repository, loads the workflow, and either recovers an existing worktree by branch or creates a new one after preflight.
- After launch or recovery, `bootstrap` waits for daemon health, then prints a JSON summary with `slug`, `mode`, `health`, `currentPhase`, and `nextInspectionCommand`.
- The recovery summary is the JSON written to stdout; run `nextInspectionCommand` to inspect the active workflow run without opening the state file by hand.
  ```json
  {
    "mode": "recovered",
    "health": "healthy",
    "currentPhase": "implement",
    "nextInspectionCommand": "node skills/herdr-implement/bin/status.ts --worktree \"/path/to/worktree\""
  }
  ```
- If health is `healthy`, step back after reporting the summary. The daemon now owns the lifecycle.
- If health is `timed-out` or `pane-exited`, surface the diagnostics as a blocker instead of blindly re-running.
- Re-invoking the same issue reference should recover a stalled or dead daemon when the worktree already exists.

Operator note: `bootstrap.ts --help` must remain available without `HERDR_ENV=1`. Running `bootstrap` again for the same issue is the recovery path for an existing run, not a request to fork duplicate work.

## Inputs

- An existing issue number, ticket key, or issue URL.
- Optional project workflow override at `.agent/herdr-workflow.yaml`.

## Workflow Source

- Built-in default workflow: `skills/herdr-implement/workflows/default.yaml`
- Project override: `.agent/herdr-workflow.yaml`

If the project override exists, it fully replaces the built-in default workflow for that repository.

## Validation Rules

- `start` is required and must reference an existing phase.
- `type` must be `herdr.issue`.
- Role defaults are inherited into each role and normalized into an effective role configuration.
- Agent phases must reference declared roles.
- Transition targets in each phase `on` map must reference existing phases.
- Invalid workflow documents are rejected before any side effects.

## Dry Run

Run the workflow dry-run helper to inspect the selected workflow, normalized roles, phases, named outcome transitions, and the transition graph:

```bash
node skills/herdr-implement/bin/dry-run.ts --issue <issue-number-or-url>
```

The dry-run helper only reads workflow files and prints the normalized result.
