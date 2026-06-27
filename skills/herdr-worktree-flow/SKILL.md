---
name: herdr-worktree-flow
description: Implement an already-created issue in a Herdr-backed Git worktree, using an issue orchestrator, separate implementation and review agents, automatic fix/review loops, commit/push, PR creation, and PR feedback monitoring until merge or close.
---

Use this skill when the user has already planned the work and created an issue, then wants that issue implemented in an isolated Herdr workspace.

This is a lifecycle skill, not a planning skill. The current session is the **main orchestrator** running from the source checkout, usually on `main`. It dispatches one issue into a fresh worktree workspace and then hands ownership off. Inside that workspace, an **issue orchestrator** owns the issue until the pull request is merged or closed.

Do not create the issue here. If there is no issue number, URL, or unambiguous existing issue reference, ask for one.

## Roles

- **Main orchestrator**: verifies the issue exists, creates the Herdr worktree workspace, starts the issue orchestrator, and then steps back unless the issue orchestrator reports a blocker that needs user input.
- **Issue orchestrator**: runs in the primary tab for the issue worktree and owns the implementation lifecycle end to end.
- **Implementer agent**: makes code changes. Prefer the `/implement` skill when available and appropriate.
- **Review orchestrator**: runs in the dedicated review tab, dispatches the `/review-pr` lenses internally, and reports one synthesized findings set back to the issue orchestrator.

The issue orchestrator coordinates the lifecycle and may not directly modify repo-tracked files. If implementation blocks, it must re-dispatch work, resolve the blocker within the worktree, or report the blocker to the main orchestrator. It does not take over the code change itself.

## Agent Tab Topology

The issue workspace uses three Codex agent tabs:

- Issue orchestrator tab: the primary tab for the issue. The issue orchestrator manages the whole process, including verification, commit, push, PR creation, and PR monitoring coordination.
- Implementer tab: one dedicated tab for the implementer agent. Reuse this tab for implementation and fix cycles.
- Review tab: one dedicated tab for the review orchestrator. Reuse this tab for review cycles.

The issue orchestrator communicates with the implementer and review orchestrator. Do not launch the implementer or review orchestrator as split panes inside the issue orchestrator tab. Do not create a separate shipping orchestrator; shipping remains the issue orchestrator's responsibility.

PR monitor tabs and processes are not Codex agent tabs. They may run as dedicated script processes in the issue workspace, but they do not count as orchestrators and do not receive model flags.

## Workspace State File

The issue orchestrator must maintain a local state file at `.agent/herdr-worktree-flow.json` for Herdr workspace handles that need to be reused across the lifecycle.

Record the workspace id and the tab, pane, terminal, and agent targets for the three Codex agent tabs:

- issue orchestrator
- implementer
- review orchestrator

Use the state file to decide whether to create or reuse the implementer and review tabs, and to find the correct Herdr target when sending handoff, review, or fix instructions. Use `agentName` or `terminalId` for `herdr agent send`; use `tabId` for tab reuse/focus; use `paneId` for pane reads or pane-level input when needed.

Example shape:

```json
{
  "workspaceId": "wP",
  "tabs": {
    "issueOrchestrator": {
      "tabId": "wP:t1",
      "paneId": "wP:p1",
      "terminalId": "term_...",
      "agentName": "issue-6-orchestrator"
    },
    "implementer": {
      "tabId": "wP:t2",
      "paneId": "wP:p2",
      "terminalId": "term_...",
      "agentName": "issue-6-implementer"
    },
    "review": {
      "tabId": "wP:t3",
      "paneId": "wP:p3",
      "terminalId": "term_...",
      "agentName": "issue-6-reviewer"
    }
  }
}
```

The state file is local agent state. Do not commit it unless the repository already tracks similar agent handoff files.

## Agent Launch Policy

All Codex agents in this workflow must launch with explicit flags for approval mode, sandbox mode, and model selection.

- Approval mode: `never`
- Sandbox mode: `workspace-write`
- Issue orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- Implementer agent: `codex -a never -s workspace-write -m gpt-5.4-mini`
- Review orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- PR monitor tabs and processes do not receive model flags because `scripts/pr-monitor.mjs` is a script process, not a Codex agent.

If a configured model is unavailable or the launch command fails, treat that as a blocker and report it. Do not silently fall back to another model, omit the model flag, or downgrade the launch policy without an explicit decision.

## Handoff Model

Handoff completes when the briefing is submitted with Enter and Herdr reports the issue orchestrator as `working`. From that point on, the issue orchestrator owns implementation, review, verification, PR handling, and feedback loops for that issue.

Write one canonical briefing file into the worktree before handoff. The issue orchestrator reads that file for context and may reopen it later if needed.

## Workflow

### 1. Preflight in the source checkout

1. Confirm the user supplied an existing issue reference.
2. Inspect `herdr -h` plus relevant subcommand help if the CLI surface may differ from prior runs.
3. Verify the current directory is the intended repository and identify the base branch.
4. Check for a dirty source checkout. Do not mix source-checkout changes into the worktree.
5. Read the issue and any linked PRD/specification. Treat the issue as the implementation contract.
6. After briefing the issue orchestrator, submit the prompt with Enter and wait for Herdr to report the orchestrator as `working` before treating the handoff as complete.

### 2. Create the issue workspace

1. Derive a descriptive branch name from the issue, following repo conventions when discoverable.
2. Create a Herdr worktree workspace from the base branch.
3. Create or use the primary tab for the issue orchestrator in that workspace.
4. Start an issue orchestrator agent in the primary tab.
5. Pass the issue orchestrator:
   - the path to the worktree briefing file, usually `.agent/issue-brief.md` or `.codex/issue-brief.md`
   - issue number/URL
   - base branch
   - worktree path
   - expected branch name
   - any PRD/spec links
   - instruction to keep a local lifecycle log

Use Herdr primitives such as:

```bash
herdr worktree create --cwd <repo> --branch <branch> --base <base> --label "<issue label>" --focus --json
herdr tab create --workspace <workspace-id> --cwd <worktree-path> --label "orchestrator" --focus
herdr agent start issue-orchestrator --cwd <worktree-path> --workspace <workspace-id> --tab <orchestrator-tab-id> -- codex -a never -s workspace-write -m gpt-5.5
herdr agent send issue-orchestrator "Read <worktree>/.agent/issue-brief.md and start."
```

Use tabs, not split panes, all orchestrators. When you split panes, split down.

```bash
herdr pane split --direction down ...
```

Always prefer current Herdr help over these examples if the CLI has changed.
If the briefing is staged with `pane send-text`, follow it immediately with `pane send-keys ... Return`; `agent send` alone only writes text.

### 3. Issue orchestrator lifecycle

The issue orchestrator works through these states:

`dispatched -> implementing -> reviewing -> fixing -> verified -> pushed -> pr-monitoring -> done`

For durable state, maintain a short local lifecycle log in the worktree, under `.agent/issue-lifecycle.md`. The log should record:

- issue reference and branch
- expected launch mode and model for each spawned agent
- actual launch mode and model for each spawned agent
- agents launched
- implementation summary
- review verdicts and blocking findings
- verification commands and outcomes
- PR URL
- PR feedback cycles

Do not commit the lifecycle log unless the repo already tracks similar agent handoff files.

### 4. Implement

1. Create or reuse the dedicated implementer tab in the issue workspace.
2. Start a separate implementer agent in that tab, with `--cwd` set to the worktree path.
3. Launch with: `codex -a never -s workspace-write -m gpt-5.4-mini`.
4. Instruct to use `/implement` when available.
5. Scope implementation to the issue. It may update tests, docs, migrations, and supporting code required by the issue, but should avoid unrelated cleanup.
6. Wait for the implementer to become idle or blocked.
7. If blocked, the issue orchestrator resolves the blocker when possible or reports it to the main orchestrator.

### 5. Review before committing

Create or reuse the dedicated review tab before the final commit. Start the review orchestrator with `codex -a never -s workspace-write -m gpt-5.5`. Before a PR exists, it runs the `/review-pr` lenses internally against the local diff; once a PR exists, it uses `/review-pr` directly. Review passes when there are no Block or Major findings. Minor findings may be fixed at the issue orchestrator's discretion. Nits are non-blocking.

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

After the PR exists, monitor until the PR is merged or closed.

Use the bundled PR monitor script as the authoritative loop:

```bash
node scripts/pr-monitor.mjs --pr <pr-ref> --state-file <worktree>/.agent/pr-monitor.json --notify-target <herdr-target>
```

Run it in a dedicated Herdr tab inside the issue workspace. The `--notify-target` value must be a concrete Herdr target from `herdr agent list` (agent name, terminal id, or detected label), not a tab id. Do not attach a model flag here because the PR monitor is a script process, not a Codex agent.

```bash
herdr agent list
```

Treat its output and state file as the source of truth for the PR lifecycle. The monitor polls until the PR becomes actionable or terminal, writes the latest JSON state file before notifying, sends exactly one Herdr message, and exits.
`agent send` is submitted with a return so the target receives it as an actionable prompt.

1. Treat the feedback as new implementation input.
2. Dispatch an implementer agent in an implementation tab to address it.
3. Have the review orchestrator rerun its internal review cycle.
4. Run required checks.
5. Commit and push fixes when review passes.
6. Restart the monitor after each fix cycle so it can notify again on the next actionable or terminal state.

Stop when the PR is merged, closed, or the loop is blocked by missing credentials, ambiguous feedback, failing external systems, or a requested human decision.

## Operating Rules

- Keep implementation isolated in the worktree; do not mix it back into the source checkout.
- Consume an existing issue. Planning and issue creation belong to the main orchestrator before this skill starts.
- Keep the issue orchestrator separate from the implementer by default.
- All Codex agents spawned by this workflow must be launched with `codex -a never -s workspace-write`.
- The issue orchestrator must spawn or reuse one implementer tab and one review tab within the issue workspace.
- The issue orchestrator must preserve this same launch policy for the implementer and review orchestrator, including the explicit model selection for each role.
- The issue orchestrator owns verification, commit, push, PR creation, and PR monitoring coordination. Do not spawn a separate shipping orchestrator.
- The issue orchestrator must treat a configured model launch failure as a blocker and must never silently fall back to another model.
- Treat review as an independent pass, not a second look by the implementer.
- Use `/review-pr` as the internal review contract.
- Treat Nits as non-blocking. Treat Block and Major findings as required fixes.
- Use `scripts/pr-monitor.mjs` for PR lifecycle polling instead of a passive `gh pr checks --watch` loop.
- Prefer the repository's existing branch naming and worktree conventions when they are discoverable.
- If the Herdr command surface changes, use the current help output instead of assuming old flags.
- Poll PR feedback until merge or close, unless blocked.
- Do not force-push, rewrite shared history, delete branches, or remove worktrees unless the user explicitly asks.
- Do not edit repo-tracked files from the main orchestrator after the handoff; all implementation changes belong to the issue orchestrator and its implementer/reviewer agents.
- Never merge the PR or invoke any merge command; stop after opening the PR and monitoring feedback.

## Practical Defaults

- Use a descriptive branch name derived from the issue or task.
- Use one primary tab for the issue orchestrator.
- Use one dedicated implementer tab and reuse it for implementation and fix cycles.
- Use one dedicated review orchestrator tab and reuse it for review cycles.
- Use a single local lifecycle log for handoff and recovery.
- Surface blockers immediately if the environment cannot support the requested workflow.
- Report the worktree path, branch, PR URL, latest commit, and final PR state when the lifecycle stops.
