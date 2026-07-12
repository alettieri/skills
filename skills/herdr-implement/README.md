# Herdr Implement

`herdr-implement` is the daemon-driven Herdr implementation lifecycle. It creates or recovers the worktree, launches the daemon, verifies startup health, and can also dry-run the selected workflow graph without creating worktrees, launching agents, committing, pushing, opening PRs, or polling external services.

Implementation lives in `src/`, thin command entrypoints live in `bin/`, built-in Workflow Scripts live in `workflow-scripts/`, and the Skill Test Harness lives in `test/`.

## Dry Run

Inspect the effective workflow for an existing issue:

```bash
node skills/herdr-implement/bin/dry-run.ts --issue <issue-number-or-url>
```

The dry-run helper selects either `skills/herdr-implement/workflows/default.yaml` or a project-level `.agent/herdr-workflow.yaml`, validates it, and prints the normalized graph.

## Implementation Lifecycle

The main `bootstrap.ts` entrypoint is for existing issues only. It is the primary implementation path, and it writes state, starts or recovers the daemon, checks health, and prints a JSON summary.

If health is `healthy`, the daemon owns the rest of the lifecycle and the caller should step back. If health is `timed-out` or `pane-exited`, the JSON diagnostics identify the worktree, workspace, pane, and state paths so the caller can treat the run as blocked.

## End-to-End Validation

Run the default workflow E2E harness with:

```bash
node --test skills/herdr-implement/test/default-workflow.e2e.test.ts
```

The harness uses a temporary repository, fake Herdr adapter, and fixture `.agent/workflow-scripts` for `gh`/git-facing phases. It validates persisted `.agent/herdr-workflow-run.json`, `.agent/herdr-implement.json`, run logs under `.agent/runs/`, and `.agent/e2e-events.log` without mutating live repositories or GitHub.

The E2E scenarios cover:

- happy path through cleanup and terminal complete
- review findings, fix dispatch, and re-review
- PR feedback polling, implementation response, and resumed polling
- blocked agent routing to terminal blocked
- mid-run daemon restart recovery without duplicate worktree creation, daemon command, role agent launches, prompts, commit, push, PR creation, or cleanup
