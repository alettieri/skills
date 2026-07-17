---
name: herdr-worktree-coordinator
description: Run the full lifecycle of implementing one ticket — implement, review, fix loop, verify, commit, push, open a draft PR, monitor PR feedback until merge or close, then clean up — using Claude agents coordinated through herdr tabs/panes, kicked off from a single long-lived main session on `main`.
---

Use this skill when the user gives a ticket reference and wants it carried through implementation, review, and PR feedback to merge or close, coordinated through herdr.

This is a standalone skill with no dependency on any other skill's files. It hardcodes Claude launch commands; it is not parameterized by agent backend. Do not build backend-agnostic abstractions for this — that is an explicit future change, not something to speculate about now.

Do not create the ticket here. If the reference is missing or ambiguous, ask for one.

## Roles

| Role | Where it runs | Spawned by |
|---|---|---|
| Main orchestrator | Human's interactive session, source checkout, `main` branch | Human |
| Issue orchestrator | Own tab, in the ticket's worktree | Main orchestrator |
| Implementer | Own tab, in the ticket's worktree | Issue orchestrator |
| Reviewer | Own tab, in the ticket's worktree | Issue orchestrator |

**Entry point:** the human gives the main orchestrator a ticket reference plus an optional implementation-skill hint (e.g. "coordinate WEB-3756, implementer should use `/migrate-to-src-modern`"). No hint means the implementer defaults to `/implement`. This skill has no built-in knowledge of migration-specific or any other project-specific implementation skill — that choice is always supplied by the human at kickoff.

**Main orchestrator's job:** verify the ticket exists (ask for one if the reference is missing or ambiguous — never create a ticket itself), create a workspace/worktree/branch for it, spawn the issue orchestrator, hand off a briefing file, then step back. It can do this for multiple tickets over time, each getting its own workspace, so several can be in flight at once from one main session. It stays reachable so a ticket's issue orchestrator can push a blocker notification to it later.

**Issue orchestrator's job:** owns the ticket end-to-end inside its worktree — spawns the implementer and reviewer, runs the coordination cycle, verifies/commits/pushes, opens the PR, monitors it, cleans up on merge/close, and escalates to the main orchestrator if it hits something it can't resolve itself.

Any role that drives the herdr CLI directly (mainly the main and issue orchestrators, for spawning/moving panes and reading sibling panes) should read the `herdr` skill first to work the CLI correctly.

## Tab Topology & Local State

Three dedicated tabs inside the ticket's workspace: issue orchestrator, implementer, reviewer. Start the agent, then move its returned pane into its own new tab. Never split an agent into another role's tab.

The PR-monitor process gets its own tab too, but it is a script loop, not an agent — no model, no launch policy entry.

Local state under `.agent/` in the worktree:

- `.agent/issue-lifecycle.md` — narrative log: ticket reference, branch, agents launched, review verdicts, PR URL, feedback cycles.
- `.agent/herdr-worktree-coordinator.json` — machine-readable handles (`tabId`, `paneId`, `terminalId`, `agentName` per role), used to reuse tabs across the lifecycle instead of respawning agents.

Example shape for `.agent/herdr-worktree-coordinator.json`:

```json
{
  "workspaceId": "wP",
  "ticket": "WEB-3756",
  "branch": "web-3756-thing",
  "tabs": {
    "issueOrchestrator": { "tabId": "wP:t1", "paneId": "wP:p1", "terminalId": "term_...", "agentName": "web-3756-orchestrator" },
    "implementer": { "tabId": "wP:t2", "paneId": "wP:p2", "terminalId": "term_...", "agentName": "web-3756-implementer" },
    "reviewer": { "tabId": "wP:t3", "paneId": "wP:p3", "terminalId": "term_...", "agentName": "web-3756-reviewer" }
  }
}
```

These are local agent state, not lifecycle artifacts to commit unless the repository already tracks similar files.

## Agent Launch Policy

| Role | Launch command | Permission mode |
|---|---|---|
| Issue orchestrator | `claude --model opus --effort low --permission-mode auto` | auto |
| Implementer | `claude --model sonnet --effort high --permission-mode auto` | auto |
| Reviewer | `claude --model opus --effort medium --permission-mode auto` | auto |

This table is the single place these commands live — adding a second backend later means editing this table, not rewriting the lifecycle logic below.

Every spawned agent launches via:

```bash
herdr agent start <name> --cwd <worktree> --workspace <id> -- <launch command from the table above>
herdr pane move <returned-pane-id> --new-tab --workspace <id> --label "<role>"
```

A launch failure (model unavailable, command errors) is a blocker — report it via the escalation channel below. Never silently retry with a different model, drop the effort flag, or drop the permission-mode flag.

## Completion & Escalation Contracts

Two separate notification channels. Both follow the same pattern: write a JSON result artifact to a recorded path, then run a script that resolves the target pane, delivers a short recognizable message, presses Return, and retries on delivery failure. The artifact is always the source of truth; the message only wakes the receiving orchestrator. Full schema and validation rules are in `references/completion-contract.md`.

### 1. Implementer/Reviewer → Issue orchestrator (routine, once per delegated run)

The implementer or reviewer writes a result artifact (`schemaVersion`, `runId`, `role`, `phase`, `status`, `summary`, `payload`) to the recorded result path, then runs:

```bash
node skills/herdr-worktree-coordinator/scripts/agent-run-complete.ts \
  --run-id <runId> --role <implementer|reviewer> --phase <phase> \
  --result <resultPath> --notify-target <issueOrchestratorAgentName>
```

This delivers `AGENT_RUN_COMPLETE <runId> <resultPath>` to the issue orchestrator's pane and presses Return.

The issue orchestrator validates `schemaVersion`, `runId`, `role`, and `phase` match the run it's expecting, and that the current lifecycle state allows that role/phase to complete, before advancing state. `blocked`/`failed` do not advance state — the issue orchestrator resolves it if it can, or escalates via channel 2.

### 2. Issue orchestrator → Main orchestrator (blockers only)

Only sent when the issue orchestrator hits something it cannot resolve on its own and needs human input. The issue orchestrator writes the same artifact shape with `role: "issue-orchestrator"` and `status` of `blocked` or `failed` (never `complete` — reporting successful completion through this channel is out of scope, see below), then runs:

```bash
node skills/herdr-worktree-coordinator/scripts/agent-run-blocked.ts \
  --run-id <runId> --phase <phase> \
  --result <resultPath> --notify-target <mainOrchestratorAgentName>
```

This delivers `AGENT_RUN_BLOCKED <runId> <resultPath>` to the main orchestrator's pane and presses Return.

**Out of scope for v1:** reporting successful completion (PR merged, cleaned up) through this channel. The human checks on finished tickets themselves; only blockers push a notification.

## Workflow

### 1. Preflight (main orchestrator)

Confirm the ticket reference. Derive a branch name from it. Create the workspace and the worktree/branch together in one call:

```bash
herdr worktree create --cwd <repo> --branch <name> --base <base> --label <ticket> --json
```

### 2. Handoff (main orchestrator)

Write a briefing file into the worktree using `references/issue-brief-template.md` — ticket reference, branch, worktree path, base branch, and the implementer-skill hint from kickoff (default `/implement` if none given). Spawn the issue orchestrator per the Launch Policy; move its pane to a dedicated tab; send it the briefing path; wait for herdr to report it `working` (`herdr agent wait <target> --status working --timeout <ms>`); step back.

### 3. Implement (issue orchestrator)

Spawn the implementer per the Launch Policy; move its pane to its own dedicated tab; record the handles in `.agent/herdr-worktree-coordinator.json`. Instruct it to do the ticket's work using whichever skill was specified at kickoff (default `/implement`). The implementer scopes itself to the ticket — it may touch docs/tests the ticket needs, but avoids unrelated cleanup. On finish, it writes its result artifact and signals completion via channel 1.

### 4. Review (issue orchestrator)

Spawn the reviewer per the Launch Policy; move its pane to its own dedicated tab; record the handles. Instruct it to run `/code-review` against the diff. (`/code-review` vs. an alternative review skill is provisional — flagged for possible change later, not settled permanently here.) On finish, it signals completion with its verdict and findings grouped by severity (Block / Major / Minor / Nit) via channel 1.

### 5. Fix loop

Block/Major findings go back to the implementer; re-review; repeat until clean. Minor findings are fixed at the issue orchestrator's discretion. Nits are non-blocking.

### 6. Verify, commit, push, open draft PR

Run the repo's required checks, discovered from package scripts, CI config, project docs, or issue instructions — never hardcoded. Commit tied to the ticket. Push. Open the PR in draft mode. Record the PR URL in `.agent/issue-lifecycle.md`.

### 7. PR review cycle

Start the PR monitor as its own tab — a script loop, not an agent, no model needed:

```bash
node skills/herdr-worktree-coordinator/scripts/pr-monitor.ts \
  --pr <pr-ref> --state-file <worktree>/.agent/pr-monitor.json \
  --notify-target <issueOrchestratorAgentName>
```

It polls for actionable PR state changes (new/changed review feedback, failing checks) and notifies the issue orchestrator only when the actionable state changes, retrying delivery on failure. New review comments are treated as fresh implementation input and go through the same fix loop as step 5, then push. Once a draft PR has no actionable feedback outstanding (no requested changes, no failing/canceled checks, no unaddressed comments or reviews), the monitor takes the PR out of draft itself.

### 8. End state

The monitor stops polling once the PR is merged or closed — the agent never merges the PR itself. On merge: close the herdr workspace, remove the worktree and branch, pull latest `main`. Any unresolved blocker at any step triggers channel 2 instead of silent retries.

## Operating Rules

- Keep the issue orchestrator, implementer, and reviewer in their dedicated tabs. Never launch a role directly into another role's tab.
- For each role, start the agent, then move the returned pane into a new tab, then record the resulting handles in `.agent/herdr-worktree-coordinator.json`.
- Preserve the Agent Launch Policy for every agent; treat a configured model launch failure as a blocker, never a silent fallback.
- The issue orchestrator owns verification, commit, push, PR creation, and PR monitoring coordination — do not spawn a separate shipping role.
- Treat review as an independent pass, not a second look by the implementer.
- Treat Block and Major findings as required fixes; Minor is discretionary; Nits are non-blocking.
- Use `scripts/pr-monitor.ts` for PR lifecycle polling instead of an ad hoc `gh pr checks --watch` loop.
- Never merge the PR or invoke any merge command — opening it and monitoring feedback is the end of the agent's role.
- Do not force-push, rewrite shared history, delete branches, or remove worktrees except during the merge/close cleanup in step 8.
- Only the issue orchestrator escalates through channel 2, and only for blockers it cannot resolve itself — not for routine status updates.

## Explicitly deferred / out of scope

Do not build any of the following for this skill:

- A backend-agnostic abstraction for non-Claude agent runtimes (config table listing multiple backends, per-backend config files). Revisit only once a second backend actually needs supporting.
- "Done" reporting from the issue orchestrator to the main orchestrator. Only blockers use channel 2.
- A post-worktree setup hook mechanism. Nothing here calls for a project-specific post-checkout hook yet.
- A final choice between `/code-review` and an alternative review skill — the reviewer uses `/code-review` provisionally.
- An integration test against a live herdr instance.
