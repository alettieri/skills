# Issue Brief Template

Use this as the canonical handoff document the main orchestrator writes into the worktree before dispatching the issue orchestrator.

## Required fields

- Issue reference
- Repository and base branch
- Worktree path and branch name
- Post-worktree setup status, hook path, and setup log path
- Goal summary
- Architecture fit notes
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

Architecture fit:
- Relevant ADRs reviewed:
- Existing modules/seams/helpers reused:
- Existing modules intentionally not reused and why:
- New seams introduced, if any:
- ADR-owned seams that must not be bypassed or wrapped incorrectly:
- Notes on acceptable reuse through public surfaces versus forbidden seam bypassing:

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
- Delegated implementer and review runs must invoke `node skills/herdr-worktree-flow/scripts/agent-run-complete.ts --run-id <runId> --role <implementer|reviewer> --phase <phase> --result <resultPath> --notify-target <notifyTarget>` after writing the artifact.
- The issue orchestrator uses the artifact plus the utility-delivered `AGENT_RUN_COMPLETE <runId> <resultPath>` instead of normal agent-state polling.
- The orchestrator validates `runId`, `role`, `phase`, `status`, and role-specific evidence before advancing lifecycle state.
- Implementer result artifacts or lifecycle logs must also record the architecture-fit notes from the run.
- Direct manual `AGENT_RUN_COMPLETE` messages are legacy/manual recovery only.

Current state:
- Main orchestrator has created the worktree and is handing off.

Next action:
- Read this file and start implementing.
```
