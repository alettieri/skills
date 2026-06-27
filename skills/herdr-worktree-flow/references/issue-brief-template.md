# Issue Brief Template

Use this as the canonical handoff document the main orchestrator writes into the worktree before dispatching the issue orchestrator.

## Required fields

- Issue reference
- Repository and base branch
- Worktree path and branch name
- Goal summary
- Acceptance criteria
- Constraints and non-goals
- Launch policy and model selection
- Current state and next action

## Suggested content

```md
# Issue Brief

Issue: <issue number or URL>
Repo: <owner/repo>
Base branch: <base>
Worktree: <absolute path>
Branch: <branch name>

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

Current state:
- Main orchestrator has created the worktree and is handing off.

Next action:
- Read this file and start implementing.
```
