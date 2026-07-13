# herdr-worktree-coordinator — design

## Purpose

A skill that runs the full lifecycle of implementing one ticket — implement, review,
fix loop, verify, commit, push, open a draft PR, monitor PR feedback until merge or
close, then clean up — using Claude agents coordinated through herdr tabs/panes, kicked
off from a single long-lived main session on `main`.

This is a standalone skill with no dependency on any other skill's files. It is not
parameterized by agent backend today; it hardcodes Claude launch commands. Adding a
second backend later is an explicit future change, not something this design builds
support for speculatively.

## Roles

| Role | Where it runs | Spawned by |
|---|---|---|
| Main orchestrator | Human's interactive session, source checkout, `main` branch | Human |
| Issue orchestrator | Own tab, in the ticket's worktree | Main orchestrator |
| Implementer | Own tab, in the ticket's worktree | Issue orchestrator |
| Reviewer | Own tab, in the ticket's worktree | Issue orchestrator |

**Entry point:** the human gives the main orchestrator a ticket reference plus an
optional implementation-skill hint (e.g. "coordinate WEB-3756, implementer should use
`/migrate-to-src-modern`"). No hint means the implementer defaults to `/implement`.
The coordinator has no built-in knowledge of migration-specific or any other
project-specific implementation skill — that choice is always supplied by the human at
kickoff.

**Main orchestrator's job:** verify the ticket exists (ask for one if the reference is
missing or ambiguous — never create a ticket itself), create a workspace/worktree/branch
for it, spawn the issue orchestrator, hand off a briefing file, then step back. It can
do this for multiple tickets over time, each getting its own workspace, so several can
be in flight at once from one main session. It stays reachable so a ticket's issue
orchestrator can push a blocker notification to it later.

**Issue orchestrator's job:** owns the ticket end-to-end inside its worktree — spawns
implementer and reviewer, runs the coordination cycle, verifies/commits/pushes, opens
the PR, monitors it, cleans up on merge/close, and is the one that escalates to the main
orchestrator if it hits something it can't resolve itself.

Any role that needs to drive the herdr CLI directly (mainly the main and issue
orchestrators, for spawning/moving panes and reading sibling panes) should read the
`/herdr` skill first to work the CLI correctly.

## Tab Topology & Local State

Three dedicated tabs inside the ticket's workspace: issue orchestrator, implementer,
reviewer. Rule: start the agent, then move its returned pane into its own new tab.
Never split an agent into another role's tab.

Local state under `.agent/` in the worktree:

- `.agent/issue-lifecycle.md` — narrative log: ticket reference, branch, agents
  launched, review verdicts, PR URL, feedback cycles.
- `.agent/herdr-worktree-coordinator.json` — machine-readable handles (tabId, paneId,
  terminalId, agentName per role), used to reuse tabs across the lifecycle instead of
  respawning agents.

## Agent Launch Policy

| Role | Launch command | Permission mode |
|---|---|---|
| Issue orchestrator | `claude --model opus --effort high --permission-mode auto` | auto |
| Implementer | `claude --model sonnet --effort high --permission-mode auto` | auto |
| Reviewer | `claude --model opus --effort medium --permission-mode auto` | auto |

Every spawned agent launches via `herdr agent start <name> --cwd <worktree> --workspace
<id> -- <command above>`, then its pane is moved into its own dedicated tab. A launch
failure (model unavailable, command errors) is a blocker — report it; never silently
retry with a different model or drop the effort/permission flags.

These commands live in exactly one section of `SKILL.md` so that adding a second
backend later means editing one table, not rewriting the lifecycle logic.

**Deferred, explicitly out of scope for v1:** any backend-agnostic abstraction (config
table listing multiple backends, per-backend config files, etc.). Revisit only once a
second backend actually needs supporting.

## Completion & Escalation Contracts

Two separate notification channels. Both follow the same pattern: write a JSON result
artifact to a recorded path, then run a script that resolves the target pane, delivers a
short recognizable message, presses Return, and retries on delivery failure. The
artifact is always the source of truth; the message only wakes the receiving orchestrator.

**1. Implementer/Reviewer → Issue orchestrator** (routine, once per delegated run)

Result artifact shape:

```json
{
  "schemaVersion": 1,
  "runId": "string",
  "role": "implementer | reviewer",
  "phase": "string",
  "status": "complete | blocked | failed",
  "summary": "string",
  "payload": {}
}
```

- Implementer payload: changed files, checks run (or deferred, with reasons), blockers
  if any.
- Reviewer payload: verdict, findings grouped by severity (Block / Major / Minor / Nit).

Delivery message: `AGENT_RUN_COMPLETE <runId> <resultPath>`.

The issue orchestrator validates `schemaVersion`, `runId`, `role`, and `phase` match the
run it's expecting, and that the current lifecycle state allows that role/phase to
complete, before advancing state. `blocked`/`failed` do not advance state — the issue
orchestrator resolves it if it can, or escalates via channel 2.

**2. Issue orchestrator → Main orchestrator** (blockers only — narrow scope)

Same artifact/script pattern, delivery message `AGENT_RUN_BLOCKED <runId> <resultPath>`,
sent only when the issue orchestrator hits something it cannot resolve on its own and
needs human input.

Explicitly out of scope for v1: reporting successful completion (PR merged, cleaned up)
through this channel. The human checks on finished tickets themselves; only blockers
push a notification.

## Workflow

1. **Preflight (main orchestrator).** Confirm the ticket reference. Derive a branch name
   from it. Run a single `herdr worktree create --cwd <repo> --branch <name> --base
   <base> --label <ticket>` call — this creates the workspace and the worktree/branch
   together, not as two separate steps.
2. **Handoff.** Write a briefing file into the worktree (ticket reference, branch,
   worktree path, base branch, the implementer-skill hint from kickoff). Spawn the issue
   orchestrator per the Launch Policy; move its pane to a dedicated tab; send it the
   briefing path; wait for herdr to report it `working`; step back.
3. **Implement** (issue orchestrator). Spawn the implementer; instruct it to do the
   ticket's work using whichever skill was specified at kickoff (default `/implement`).
   Implementer scopes itself to the ticket — it may touch docs/tests the ticket needs,
   but avoids unrelated cleanup. On finish, it writes its result artifact and signals
   completion (channel 1).
4. **Review** (issue orchestrator). Spawn the reviewer; it runs `/code-review` against
   the diff. On finish, signals completion with its verdict and findings by severity.
   (`/code-review` vs. an alternative review skill is provisional — flagged for possible
   change later, not settled permanently by this design.)
5. **Fix loop.** Block/Major findings go back to the implementer; re-review; repeat until
   clean. Minor findings fixed at the issue orchestrator's discretion. Nits are
   non-blocking.
6. **Verify, commit, push, open draft PR.** Run the repo's required checks, discovered
   from package scripts/CI config/project docs/issue instructions — never hardcoded.
   Commit tied to the ticket. Push. Open the PR in draft mode. Record the PR URL in the
   lifecycle log.
7. **PR review cycle.** A PR-monitor script (its own tab — a script loop, not an agent,
   no model needed) polls for actionable PR state changes and notifies the issue
   orchestrator when there's something to act on. New review comments are treated as
   fresh implementation input and go through the same fix loop as step 5, then push.
   Once there are no new/high/medium actionable items, move the PR out of draft.
8. **End state.** Stop polling once the PR is merged or closed. The agent never merges
   the PR itself. On merge: close the herdr workspace, remove the worktree and branch,
   pull latest `main`. Any unresolved blocker at any step triggers channel 2 instead of
   silent retries.

## File Layout

```
herdr-worktree-coordinator/
  SKILL.md
  scripts/
    agent-run-complete.ts     — writes/validates completion artifacts, delivers AGENT_RUN_COMPLETE
    agent-run-blocked.ts      — same shape, delivers AGENT_RUN_BLOCKED to the main orchestrator
    pr-monitor.ts             — polls PR state, notifies issue orchestrator on actionable change
    *.test.ts                 — one test file per script above
  references/
    completion-contract.md    — result-artifact schema + validation rules
    issue-brief-template.md   — template for the handoff briefing file
```

No post-worktree-setup-hook equivalent for v1 — nothing in this design calls for a
project-specific post-checkout hook yet; add it later if a real project needs one.

## Testing

Each script gets a plain `node --test` unit test (schema validation, retry behavior,
target resolution). No integration test against a live herdr instance for v1 — that
needs a running herdr server, and the goal right now is to prove the design out, not
build a full test harness for it.

## Explicitly deferred / out of scope

- Backend-agnostic abstraction for non-Claude agent runtimes.
- "Done" reporting from issue orchestrator to main orchestrator.
- Post-worktree setup hook mechanism.
- Final choice of `/code-review` vs. an alternative review skill for the reviewer role.
