# Issue Brief Template

Use this as the canonical handoff document the main orchestrator writes into the worktree before dispatching the issue orchestrator.

## Required fields

- Issue reference
- Repository and base branch
- Worktree path and branch name
- Goal summary
- Acceptance criteria
- Constraints and non-goals
- Preferred agent model
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

Preferred agent model:
- Implementer: gpt-4o-mini
- Reviewers: gpt-4o-mini

Current state:
- Main orchestrator has created the worktree and is handing off.

Next action:
- Read this file and start implementing.
```
