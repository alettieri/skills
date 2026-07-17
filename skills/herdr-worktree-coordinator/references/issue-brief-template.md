# Issue Brief Template

Use this as the canonical handoff document the main orchestrator writes into the worktree before
dispatching the issue orchestrator. Write one file; the issue orchestrator reads it and may reopen
it later if needed.

## Required fields

- Ticket reference
- Repository and base branch
- Worktree path and branch name
- Implementer-skill hint from kickoff (default `/implement` if the human didn't give one)
- Goal summary
- Acceptance criteria
- Constraints and non-goals
- Launch policy (the Agent Launch Policy table, verbatim)
- Completion contract for delegated implementer/reviewer runs, and the escalation channel
- Current state and next action

## Suggested content

```md
# Issue Brief

Ticket: <ticket reference>
Repo: <owner/repo>
Base branch: <base>
Worktree: <absolute path>
Branch: <branch name>

Implementer skill: <skill hint from kickoff, or `/implement` if none given>

Goal:
<one short paragraph>

Acceptance criteria:
- <criterion 1>
- <criterion 2>

Constraints:
- Stay within scope of the ticket. Touching docs/tests the ticket needs is fine; unrelated cleanup is not.
- Work only inside this worktree.

Launch policy (snapshot for this ticket's record — SKILL.md's Agent Launch Policy table is the source of truth; keep this in sync with it, not the other way around):
- Issue orchestrator: `claude --model opus --effort low --permission-mode auto`
- Implementer: `claude --model sonnet --effort high --permission-mode auto`
- Reviewer: `claude --model opus --effort medium --permission-mode auto`
- PR monitor: no model flag, it is a script process, not an agent.
- A launch failure is a blocker — report it, never silently retry with a different model or drop a flag.

Completion contract:
- The implementer and reviewer each write a JSON result artifact before signaling completion, then run
  `node skills/herdr-worktree-coordinator/scripts/agent-run-complete.ts --run-id <runId> --role <implementer|reviewer> --phase <phase> --result <resultPath> --notify-target <issueOrchestratorAgentName>`.
- The issue orchestrator waits for the `AGENT_RUN_COMPLETE <runId> <resultPath>` notification, re-validates
  `runId`/`role`/`phase`/`status` against the run it expects, and only then advances lifecycle state.
  See `references/completion-contract.md` for the full schema and validation rules.
- If the issue orchestrator hits a blocker it cannot resolve itself, it writes the same artifact shape
  with `role: "issue-orchestrator"` and `status` of `blocked` or `failed`, then runs
  `node skills/herdr-worktree-coordinator/scripts/agent-run-blocked.ts --run-id <runId> --phase <phase> --result <resultPath> --notify-target <mainOrchestratorAgentName>`.
  This channel is for blockers only — it never reports successful completion.

Current state:
- Main orchestrator has created the worktree and is handing off.

Next action:
- Read this file and start implementing.
```
