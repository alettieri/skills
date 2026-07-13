---
name: herdr-worktree-flow
description: Deprecated legacy worktree orchestrator for Herdr-backed Git worktrees. Use herdr-implement for new daemon-driven issue execution; keep this skill only for transitional handoff, completion utility, and PR-monitor support.
---

Deprecated: prefer `herdr-implement` for new issue execution. Use this skill only when you need the legacy live-agent orchestrator, the shared completion utility, or the PR-monitor support scripts while those helpers are still being migrated.

This is a lifecycle skill, not a planning skill. The current session is the **main orchestrator** running from the source checkout, usually on `main`. It dispatches one issue into a fresh worktree workspace and then hands ownership off. Inside that workspace, an **issue orchestrator** owns the issue until the pull request is merged or closed.

Do not create the issue here. If there is no issue number, URL, or unambiguous existing issue reference, ask for one.

## Roles

- **Main orchestrator**: verifies the issue exists, creates the Herdr worktree workspace, starts the issue orchestrator, and then steps back unless the issue orchestrator reports a blocker that needs user input.
- **Issue orchestrator**: runs in a dedicated orchestrator tab for the issue worktree and owns the implementation lifecycle end to end.
- **Implementer agent**: makes code changes. Prefer the `/implement` skill when available and appropriate.
- **Review orchestrator**: runs in the dedicated review tab, dispatches the `/review-pr` lenses internally, and reports one synthesized findings set back to the issue orchestrator.

The issue orchestrator coordinates the lifecycle but does not take over implementation work. If implementation blocks, it re-dispatches work, resolves the blocker within the worktree, or reports the blocker to the main orchestrator.

## Agent Tab Topology

The issue workspace uses three Codex agent tabs:

- Issue orchestrator tab: one dedicated tab for the issue orchestrator. The issue orchestrator manages the whole process, including verification, commit, push, PR creation, and PR monitoring coordination.
- Implementer tab: one dedicated tab for the implementer agent. Reuse this tab for implementation and fix cycles.
- Review tab: one dedicated tab for the review orchestrator. Reuse this tab for review cycles.

Start each Codex agent, capture the returned `pane_id`, then move that pane into a dedicated role tab with `herdr pane move --new-tab`. The issue orchestrator communicates with the implementer and review orchestrator. Do not launch any Codex role as a split pane inside another role's tab. Do not create a separate shipping orchestrator; shipping remains the issue orchestrator's responsibility.

PR monitor tabs and processes are not Codex agent tabs; they are dedicated script processes in the issue workspace.

## Local Agent State

The issue orchestrator maintains two local state files under `.agent/`:

- `.agent/issue-lifecycle.md`: narrative status log for handoff and recovery.
- `.agent/herdr-worktree-flow.json`: machine-readable Herdr workspace handles for tab reuse and agent communication.

The lifecycle log should record the issue reference, branch, expected and actual launch mode/model for each spawned agent, agents launched, implementation summary, review verdicts, verification outcomes, PR URL, PR feedback cycles, and the architecture-fit notes for each implementation/review loop.

The workspace state file should record the workspace id and the tab, pane, terminal, agent, and role label for the issue orchestrator, implementer, and review orchestrator. Use it to decide whether a role already has a dedicated tab, and to find the correct Herdr target when sending handoff, review, or fix instructions. Use `agentName` or `terminalId` for `herdr agent send`; use `tabId` for tab focus; use `paneId` for pane reads or pane-level input when needed.

Example workspace state shape:

```json
{
  "workspaceId": "wP",
  "tabs": {
    "issueOrchestrator": {
      "tabId": "wP:t1",
      "paneId": "wP:p1",
      "terminalId": "term_...",
      "agentName": "issue-6-orchestrator",
      "roleLabel": "orchestrator"
    },
    "implementer": {
      "tabId": "wP:t2",
      "paneId": "wP:p2",
      "terminalId": "term_...",
      "agentName": "issue-6-implementer",
      "roleLabel": "implementer"
    },
    "review": {
      "tabId": "wP:t3",
      "paneId": "wP:p3",
      "terminalId": "term_...",
      "agentName": "issue-6-reviewer",
      "roleLabel": "review"
    }
  }
}
```

These files are local agent state. Do not commit them unless the repository already tracks similar agent handoff files.

## Agent Run Completion Contract

Implementer and review handoffs use a completion contract instead of normal Herdr agent-state polling. Each delegated run writes a JSON result artifact at the recorded `resultPath`, then invokes the workflow-owned completion utility:

```bash
node skills/herdr-worktree-flow/scripts/agent-run-complete.ts \
  --run-id <runId> \
  --role <implementer|reviewer> \
  --phase <phase> \
  --result <resultPath> \
  --notify-target <notifyTarget>
```

The utility validates the artifact and target, sends `AGENT_RUN_COMPLETE <runId> <resultPath>` with human-readable context, presses Return in the resolved Codex agent pane, retries delivery, and writes `.agent/runs/<runId>/notification.json`. Directly typing or sending `AGENT_RUN_COMPLETE` is legacy/manual recovery only, not the normal path.

The issue orchestrator treats the completion notification as a wake-up signal, reads the artifact, and validates the `runId`, `role`, `phase`, `status`, and role-specific evidence before advancing lifecycle state. Missing, malformed, duplicate, stale, or missed notifications are handled through the contract documented in `references/agent-run-completion-adr.md`.
Implementer result artifacts or lifecycle logs must also capture the architecture-fit notes for the run: which existing modules, seams, and helpers were reused, which were intentionally not reused and why, which new seams were introduced, and whether any ADR-owned seam was at risk of being bypassed or wrapped incorrectly.

## Agent Launch Policy

All Codex agents in this workflow must launch through `herdr agent start` with explicit Codex approval/model flags, then move the returned pane into a dedicated role tab.

- Approval mode: `never`
- Issue orchestrator: `codex -a on-request -m gpt-5.5`
- Implementer agent: `codex -a on-request -m gpt-5.4-mini`
- Review orchestrator: `codex -a on-request -m gpt-5.5`
- PR monitor tabs and processes do not receive model flags because `scripts/pr-monitor.mjs` is a script process, not a Codex agent.

Use this Herdr command shape for every Codex agent:

```bash
herdr agent start <agent-name> --cwd <worktree-path> --workspace <workspace-id> -- codex -a on-request -m <model>
herdr pane move <returned-pane-id> --new-tab --workspace <workspace-id> --label "<role-label>"
```

Do not pass `--tab` or `--split` when starting issue orchestrator, implementer, or review orchestrator agents. If a configured model is unavailable or the launch command fails, treat that as a blocker and report it. Do not silently fall back to another model, omit the model flag, or downgrade the launch policy without an explicit decision.

## Handoff Model

Handoff completes when the briefing is submitted with Enter and Herdr reports the issue orchestrator as `working`. From that point on, the issue orchestrator owns implementation, review, verification, PR handling, and feedback loops for that issue.

After creating the worktree and before writing the final briefing or launching the issue orchestrator, run the post-worktree setup helper:

```bash
node skills/herdr-worktree-flow/scripts/post-worktree-setup.ts <worktree-path>
```

The helper runs the committed `.agent/herdr-post-worktree-setup` hook from the issue worktree root when it exists. Missing hooks are a successful skipped setup. Present hooks must be executable. Hook startup errors, non-zero exits, the fixed 10-minute timeout, and dirty worktrees after setup are blocking. Full hook stdout and stderr are written to `.agent/post-worktree-setup.log`; the briefing records setup status and log path without embedding full logs.

Write one canonical briefing file into the worktree before handoff. The issue orchestrator reads that file for context and may reopen it later if needed.

## Workflow

### 1. Preflight in the source checkout

1. Confirm the user supplied an existing issue reference.
2. Use the `/herdr` skill to help you understand how to use the `herdr` command.
3. Verify the current directory is the intended repository and identify the base branch.
4. Check for a dirty source checkout. Do not mix source-checkout changes into the worktree.
5. Read the issue and any linked PRD/specification. Treat the issue as the implementation contract.
6. After briefing the issue orchestrator, submit the prompt with Enter and wait for Herdr to report the orchestrator as `working` before treating the handoff as complete.

### 2. Create the issue workspace

1. Derive a descriptive branch name from the issue, following repo conventions when discoverable.
3. Create a Herdr worktree workspace from the source workspace and base branch. Use `--cwd <repo>` only when no source workspace is available.
4. Run `node skills/herdr-worktree-flow/scripts/post-worktree-setup.ts <worktree-path>` from the source checkout. If setup returns `blocked`, stop before writing the final issue brief or launching the issue orchestrator and report the blocker with `.agent/post-worktree-setup.log`.
5. Confirm successful setup left the worktree clean using the helper result. The helper checks `git status --porcelain --untracked-files=normal`.
6. Write the issue brief with setup status, hook path, and log path.
7. Before implementation starts, perform an architecture-fit check:
   - read the relevant ADRs in `docs/adr/` and any other docs that define the touched boundary
   - identify the existing modules, seams, and helpers that already solve part of the change
   - decide what will be reused through its intended public surface versus what will not be reused and why
   - note any new seam that the issue truly needs
   - confirm no ADR-owned seam is being bypassed or wrapped in a way that duplicates its responsibility elsewhere
   - record the outcome in the issue brief and lifecycle log
8. Start an issue orchestrator agent in the issue workspace.
9. Move the returned issue orchestrator pane into a new dedicated orchestrator tab.
10. Pass the issue orchestrator:
   - the path to the worktree briefing file, usually `.agent/issue-brief.md` or `.codex/issue-brief.md`
   - issue number/URL
   - base branch
   - worktree path
   - expected branch name
   - post-worktree setup status and log path
   - any PRD/spec links
   - instruction to keep the local agent state files

Use Herdr primitives such as:

```bash
herdr workspace list
herdr worktree create --branch <branch> --base <base> --label "<issue label>" --json
node skills/herdr-worktree-flow/scripts/post-worktree-setup.ts <worktree-path>

herdr agent start issue-orchestrator --cwd <worktree-path> --workspace <workspace-id> -- codex -a on-request -m gpt-5.5
herdr pane move <returned-pane-id> --new-tab --workspace <workspace-id> --label "orchestrator"
herdr agent send issue-orchestrator "Read <worktree>/.agent/issue-brief.md and start."
```

Use tabs, not split panes, for all Codex agents. Start the agent first, then move its returned pane into a new role tab. Do not pass `--tab` or `--split` when starting issue orchestrator, implementer, or review orchestrator agents. When you split panes for non-agent helper work, split down.

```bash
herdr pane split --direction down ...
```

If the briefing is staged with `pane send-text`, follow it after a brief delay (500ms) with `pane send-keys ... Return`; `agent send` alone only writes text.

### 3. Issue orchestrator lifecycle

The issue orchestrator works through these states:

`dispatched -> implementing -> reviewing -> fixing -> verified -> pushed -> pr-monitoring -> done`

Keep `.agent/issue-lifecycle.md` and `.agent/herdr-worktree-flow.json` current as described in Local Agent State.

### 4. Implement

1. Reuse the existing implementer agent recorded in `.agent/herdr-worktree-flow.json` when it exists and is usable; otherwise start a new implementer agent with the full launch policy.
2. Move the returned implementer pane into a new dedicated implementer tab:

```bash
herdr agent start <issue-label>-implementer --cwd <worktree-path> --workspace <workspace-id> -- codex -a on-request -m gpt-5.4-mini
herdr pane move <returned-pane-id> --new-tab --workspace <workspace-id> --label "implementer"
```

3. Record the implementer `tabId`, `paneId`, `terminalId`, `agentName`, and `roleLabel` in `.agent/herdr-worktree-flow.json`.
4. Instruct to use `/implement` when available and to follow the agent run completion contract for the delegated run by writing the result artifact and running `scripts/agent-run-complete.ts`.
5. Scope implementation to the issue. It may update tests, docs, migrations, and supporting code required by the issue, but should avoid unrelated cleanup.
6. Wait for `AGENT_RUN_COMPLETE` and the result artifact instead of waiting for the implementer to become idle or blocked.
7. If the run is blocked or failed, the issue orchestrator resolves the blocker when possible or reports it to the main orchestrator after inspecting the artifact.

### 5. Review before committing

Reuse the existing review orchestrator recorded in `.agent/herdr-worktree-flow.json` when it exists and is usable; otherwise start a new review orchestrator before the final commit with the full launch policy and move its returned pane into a new dedicated review tab:

```bash
herdr agent start <issue-label>-reviewer --cwd <worktree-path> --workspace <workspace-id> -- codex -a on-request -m gpt-5.5
herdr pane move <returned-pane-id> --new-tab --workspace <workspace-id> --label "review"
```

Record the review orchestrator `tabId`, `paneId`, `terminalId`, `agentName`, and `roleLabel` in `.agent/herdr-worktree-flow.json`. Before a PR exists, it runs the `/review-pr` lenses internally against the local diff; once a PR exists, it uses `/review-pr` directly. Review passes when there are no Block or Major findings. Minor findings may be fixed at the issue orchestrator's discretion. Nits are non-blocking.
The review run uses the same completion contract: write the result artifact first, run `scripts/agent-run-complete.ts`, and validate the artifact before advancing lifecycle state.
The review pass must include a DRY and deep-module check: look for duplicated behavior, widened interfaces, exported internals, whether a new shared module is warranted, and whether reuse respects accepted seams instead of bypassing or re-wrapping them.

For Block or Major findings:

1. Send the findings to an implementer agent.
2. Have it fix only those findings unless the issue orchestrator explicitly expands scope.
3. Run the review loop again.
4. Continue until review passes or the issue is genuinely blocked.

### 6. Verify, commit, push, and open PR

After review passes:

1. Run the repository's required checks. Discover them from package scripts, CI config, project docs, or issue instructions.
2. If checks fail, return to implementation and review.
3. Commit the changes with a message tied to the issue.
4. Push the branch.
5. Open a PR if one does not exist.
6. Record the PR URL in the lifecycle log.

The user has authorized automatic commit and push once review passes and required checks succeed. Still stop before destructive actions, secret exposure, force-pushes, or any operation that would overwrite user work.
Never merge the PR. Opening it and monitoring feedback are the end of the agent's role; merge is a human action only.

### 7. Monitor PR feedback

After the PR exists, wait to be notified that the PR is merged or closed. Once notified, cleanup the workspace, worktree and branch.

Use the bundled PR monitor script as the authoritative loop:

```bash
node skills/herdr-worktree-flow/scripts/pr-monitor.ts --pr <pr-ref> --state-file <worktree>/.agent/pr-monitor.json --notify-target <herdr-target>
```

Run it in a dedicated Herdr tab inside the issue workspace. The `--notify-target` value must be the issue orchestrator agent target recorded at `.agent/herdr-worktree-flow.json` under `tabs.issueOrchestrator.agentName`, not the PR monitor tab id, pane id, terminal id, or another shell target.

```bash
herdr agent list
```

Treat its output and state file as the source of truth for the PR lifecycle. For open PRs, notify only when the actionable state changes, then keep polling. For merged or closed PRs, write state, send one final notification if needed, and exit.
`agent send` is submitted with a return so the target receives it as an actionable prompt.

1. Treat the feedback as new implementation input.
2. Dispatch the implementer agent in the dedicated implementation tab to address it.
3. Have the review orchestrator rerun its internal review cycle.
4. Run required checks.
5. Commit and push fixes when review passes.
6. Keep the existing monitor running after each fix cycle; restart it only if the monitor process failed or was intentionally stopped.

Stop when the PR is merged, closed, or the loop is blocked by missing credentials, ambiguous feedback, failing external systems, or a requested human decision.

## Operating Rules

- Keep implementation isolated in the worktree; do not mix it back into the source checkout.
- Consume an existing issue. Planning and issue creation belong to the main orchestrator before this skill starts.
- Keep the issue orchestrator, implementer, and review orchestrator in their dedicated tabs.
- Do not launch a Codex role directly into another role's tab with `--tab`.
- For each Codex role, start the agent, move the returned pane into a new role tab, and record the resulting Herdr handles.
- Preserve the Agent Launch Policy for every Codex agent, and treat configured model launch failure as a blocker.
- The issue orchestrator owns verification, commit, push, PR creation, and PR monitoring coordination. Do not spawn a separate shipping orchestrator.
- Treat review as an independent pass, not a second look by the implementer.
- Use `/review-pr` as the internal review contract.
- Treat Nits as non-blocking. Treat Block and Major findings as required fixes.
- Use `scripts/pr-monitor.ts` with direct `node` for PR lifecycle polling instead of a passive `gh pr checks --watch` loop.
- Prefer the repository's existing branch naming and worktree conventions when they are discoverable.
- If the Herdr command surface changes, use the current help output instead of assuming old flags.
- Poll PR feedback until merge or close, unless blocked.
- Do not force-push, rewrite shared history, delete branches, or remove worktrees unless the user explicitly asks.
- Do not edit repo-tracked files from the main orchestrator after the handoff; all implementation changes belong to the issue orchestrator and its implementer/reviewer agents.
- Never merge the PR or invoke any merge command; stop after opening the PR and monitoring feedback.

## Practical Defaults

- Use a descriptive branch name derived from the issue or task.
- Use the three-tab topology and local state files described above.
- Surface blockers immediately if the environment cannot support the requested workflow.
- Report the worktree path, branch, PR URL, latest commit, and final PR state when the lifecycle stops.
