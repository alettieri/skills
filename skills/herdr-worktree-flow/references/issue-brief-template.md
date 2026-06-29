# Issue Brief Template

Use this as the canonical handoff document the main orchestrator writes into the worktree before dispatching the issue orchestrator.

## Required fields

- Issue reference
- Repository and base branch
- Worktree path and branch name
- Post-worktree setup status, hook path, and setup log path
- Goal summary
- Acceptance criteria
- Constraints and non-goals
- Launch policy and model selection
- Completion contract for delegated implementer/reviewer runs
- Current state and next action

## Suggested content

```md
# Issue Brief

Issue: <issue number or URL>
Repo: <owner/repo>
Base branch: <base>
Worktree: <absolute path>
Branch: <branch name>

Post-worktree setup:
- Status: <skipped|succeeded|blocked>
- Hook path: <worktree>/.agent/herdr-post-worktree-setup
- Log path: <worktree>/.agent/post-worktree-setup.log or <not written>
- Exit code or timeout: <value when applicable>
- Failure summary: <short tail summary for blocked setup; omit full logs>

Goal:
<one short paragraph>

Acceptance criteria:
- <criterion 1>
- <criterion 2>

Constraints:
- Stay within scope.
- Use the worktree only.

Launch policy:
- Approval mode: `never`
- Sandbox mode: `workspace-write`
- Issue orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- Implementer: `codex -a never -s workspace-write -m gpt-5.4-mini`
- Review orchestrator: `codex -a never -s workspace-write -m gpt-5.5`
- PR monitor: no model flag because it is a script process
- Silent fallback is forbidden; treat launch failure as a blocker.

Completion contract:
- Delegated implementer and review runs must write a JSON result artifact before notifying completion.
- The issue orchestrator uses the artifact plus `AGENT_RUN_COMPLETE <runId> <resultPath>` instead of normal agent-state polling.
- The orchestrator validates `runId`, `role`, `phase`, `status`, and role-specific evidence before advancing lifecycle state.

Current state:
- Main orchestrator has created the worktree and is handing off.

Next action:
- Read this file and start implementing.
```
