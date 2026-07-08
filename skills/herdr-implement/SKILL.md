---
name: herdr-implement
description: Validate the declarative workflow schema for daemon-driven issue implementation from an existing issue number or URL, then dry-run the selected workflow without creating worktrees or launching agents.
---

Use this skill only when the user has already provided an existing issue number or URL. This skill validates the workflow schema and prints the effective workflow for dry-run inspection. It does not create worktrees, launch Herdr agents, run the daemon loop, commit, push, create PRs, or perform any other side effects.

## Inputs

- An existing issue number or URL.
- Optional repository override workflow at `.agent/herdr-workflow.yaml`.

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
node skills/herdr-implement/scripts/dry-run.ts --issue <issue-number-or-url>
```

The dry-run helper only reads workflow files and prints the normalized result.

## End-to-End Validation

Run the default workflow E2E harness with:

```bash
node --test skills/herdr-implement/scripts/default-workflow.e2e.test.ts
```

The harness uses a temporary repository, fake Herdr adapter, and fixture `.agent/scripts` for `gh`/git-facing phases. It validates persisted `.agent/herdr-workflow-run.json`, `.agent/herdr-implement.json`, run logs under `.agent/runs/`, and `.agent/e2e-events.log` without mutating live repositories or GitHub.
