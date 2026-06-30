# Orchestrator Daemon And Dynamic Workflow Design

Date: 2026-06-30
Status: Planning draft, updated with initial decisions
Proposed skill: `herdr-implement`
First implementation issue: https://github.com/alettieri/skills/issues/15
Second implementation issue: https://github.com/alettieri/skills/issues/16
Third implementation issue: https://github.com/alettieri/skills/issues/17
Fourth implementation issue: https://github.com/alettieri/skills/issues/18
Fifth implementation issue: https://github.com/alettieri/skills/issues/19
Sixth implementation issue: https://github.com/alettieri/skills/issues/20
Seventh implementation issue: https://github.com/alettieri/skills/issues/21
Eighth implementation issue: https://github.com/alettieri/skills/issues/22
Ninth implementation issue: https://github.com/alettieri/skills/issues/23
Tenth implementation issue: https://github.com/alettieri/skills/issues/24

## Issue Plan

The implementation should continue with a dedicated artifact slice after the schema/runtime foundation. The default workflow references prompt templates and shell scripts, so `herdr-implement` should ship those artifacts as first-class skill resources rather than leaving project authors to create them from scratch.

Recommended default artifact layout:

```text
skills/herdr-implement/
  prompts/
    implement.md
    simplify.md
    review.md
    fix.md
    verify.md
    handle-pr-feedback.md
  scripts/
    post-worktree-setup.sh
    run-checks.sh
    commit-changes.sh
    push-branch.sh
    create-pr.sh
    check-pr-review.sh
    check-pr-merged.sh
    cleanup-worktree.sh
```

The default prompt templates should instruct agents to produce result artifacts with `outcome`, optional `capture`, `summary`, and role-specific `payload`. The default scripts should emit either single-token outcomes or JSON outcomes with capture.

## Result Schemas

Agent result artifacts should be validated against named result schemas. The workflow role declaration lists which schemas a role may emit, and an agent phase declares the expected schema for that run.

Default schema files should live under:

```text
skills/herdr-implement/schemas/
  implementer-result-v1.json
  simplifier-result-v1.json
  reviewer-result-v1.json
  verifier-result-v1.json
```

Every result schema should share the common envelope fields:

- `schemaVersion`
- `runId`
- `phase`
- `role`
- `status`
- `outcome`
- `capture`
- `summary`
- `payload`

Schema-specific validation should focus on `payload` evidence. For example, reviewer payloads should include verdict/findings, while implementer payloads should include changed files, checks run or deferred, and blockers.

## Source Inputs

- `docs/superpowers/specs/orchestrator-sidea.pdf`
- Current `skills/herdr-worktree-flow` documentation and scripts as reference material
- Reference workflow shape from `linuxlewis/another-orchestrator` `workflows/standard.yaml`

## Problem

The current `herdr-worktree-flow` skill is mostly a written lifecycle contract. It tells the main orchestrator how to create a Herdr worktree, start an issue orchestrator, and delegate implementation and review. The issue orchestrator then owns the lifecycle through agent prompts, local state files, completion artifacts, PR monitoring, and manual judgement.

The desired direction is to introduce a workflow daemon that makes the lifecycle explicit and durable. The daemon should use Herdr as its execution and visibility layer: Herdr creates worktrees, starts agent tabs, sends prompts, and gives the user a TUI for observing projects and tasks. The daemon owns workflow state transitions and invokes Herdr as a tool.

This should be implemented as a new skill named `herdr-implement` that lives side by side with `herdr-worktree-flow`, not as an in-place replacement. The existing skill remains available as the manual/lifecycle-contract workflow while the new skill owns daemon-driven execution.

## Proposed Direction

Introduce an orchestrator daemon for each skill invocation, backed by a declarative workflow definition. The user-facing skill entrypoint should run a bootstrap script that prepares the Herdr workspace and then starts `daemon.ts` inside a dedicated Herdr pane.

The bootstrap script should:

- create or attach to the Herdr worktree workspace
- create canonical issue and workflow state files
- create the daemon pane and start `daemon.ts` inside it

The daemon should:

- start or reuse phase executor agents through Herdr
- send phase-specific prompts to agents
- process agent completion artifacts and PR monitor notifications
- advance workflow state only through declared transitions
- expose enough state for Herdr tabs and local files to remain understandable to humans

The first implementation should avoid becoming a general distributed scheduler. It should automate the existing issue lifecycle before adding arbitrary workflow power.

## Decisions So Far

- The daemon replaces the current issue orchestrator role. It is not a supervisor around a separate issue orchestrator agent.
- The default workflow lives in the new daemon skill folder. A target repository may replace it with a project-owned workflow file.
- Workflow phases are deterministic and owned by the daemon. Agents execute the task for the active phase and report completion through artifacts.
- The skill invocation starts one bootstrap script, and the bootstrap script starts one daemon process for the session in a Herdr pane.
- Bootstrap creates only the daemon pane. Role tabs/agents are created lazily by the daemon when the workflow first reaches a phase that needs that role.
- Role agents default to `reuse: true`. When a role opts into reuse, the daemon keeps using the same role tab/agent across phases and loops. If `reuse: false`, each phase run starts a fresh one-off agent.
- Recovery is required. A restarted daemon must reconstruct the active run from durable state and Herdr/worktree artifacts.
- Project workflows may define new agent roles. Roles are not limited to built-in implementer/reviewer names.
- Role launch settings such as approval mode and sandbox mode are defined by the authoritative workflow. The daemon validates supported values but does not impose an additional policy cap.
- Role declarations may inherit workflow-level defaults. This keeps project overrides small when they only need to change one setting, such as model.
- The first version requires an existing issue number or URL. Free-form task execution is deferred to a later workflow type such as `herdr.task`.
- The daemon runs continuously after skill invocation until it reaches a terminal phase or a workflow-defined cleanup/stop phase.
- The default workflow should include the full intended issue-to-PR graph from the first schema slice, even before every phase type is executable. Early issues validate and dry-run the full graph, then later issues make phase types executable.

## Domain Model

### Workflow Definition

A checked-in or skill-provided YAML/JSON file that declares workflow type, start phase, phases, prompt templates, commands, capture rules, retry limits, and transitions.

Candidate paths:

- `skills/herdr-implement/workflows/default.yaml`
- repository override: `.agent/herdr-workflow.yaml`
- issue override: passed explicitly by the user or issue brief

The skill-folder default is authoritative when no project override is present. If a repository override exists, it becomes the new source of truth for that project. It is not merged with the default workflow and is not treated as a partial patch. The expected authoring model is: copy the default workflow into the project, then modify it for that project's needs.

Because project overrides are authoritative, validation is the main guardrail. The daemon must reject invalid overrides before creating worktrees, launching agents, or running commands.

### Workflow Type

The workflow type selects the execution semantics available to the phase graph. A workflow type is not just a label; it determines which phase types, prompt templates, command names, captures, and transitions are valid.

Initial candidate workflow types:

- `herdr.issue`: the standard issue-to-PR workflow using worktrees, implementer/reviewer agents, checks, PR monitoring, and cleanup
- `herdr.task`: a lighter task workflow that may not create a PR
- `custom`: deferred until the built-in types are stable

For the first implementation, `herdr.issue` should be the only executable type.

### Workflow Run

One durable execution of a workflow for one issue or task. It has an id, issue reference, repository, base branch, worktree path, branch name, active state, context values, attempts, role handles, and terminal outcome.

Candidate state path:

```text
.agent/herdr-workflow-run.json
```

The workflow run file stores lifecycle state: current phase, phase history, issue reference, branch, selected workflow path, normalized workflow snapshot, context, attempts, timestamps, pending runs, and terminal outcome.

Herdr integration handles should live in a separate file:

```text
.agent/herdr-implement.json
```

That file stores Herdr workspace, worktree, tab, pane, terminal, and agent identifiers so the daemon can recover and route work after restart without confusing this new skill with the existing `herdr-worktree-flow` state file.

### Phase

A node in the workflow graph. Initial phase types should be intentionally small:

- `herdr-worktree`: create the worktree workspace
- `script`: run a local script or helper
- `agent`: start or reuse a Codex agent and send a prompt
- `wait-agent`: wait for an agent run completion artifact
- `poll`: run a polling helper such as the PR monitor
- `decision`: route from captured context without launching work
- `terminal`: end the run with success, closed, aborted, blocked, or escalated

### Transition

A declared edge from one phase to another. Transitions should use named outcomes through an `on` map, not only generic `onSuccess`/`onFailure` fields. Outcomes should be phase-specific but normalized enough to test and recover, such as `success`, `failure`, `blocked`, `approved`, `needs_fix`, `checks_failed`, `changes_requested`, `waiting`, `merged`, `closed`, and `timeout`.

Example:

```yaml
on:
  approved: await_merge
  changes_requested: handle_review
  checks_failed: handle_review
  closed: pr_closed
  waiting: await_review
  timeout: escalate
```

### Script Phase

A deterministic command phase executed by `daemon.ts` as a direct child process. Script phases should not create visible Herdr panes in the initial implementation. Commands are workflow-declared shell scripts that can execute whatever the workflow author chooses. The daemon captures stdout, stderr, exit code, duration, and timeout status into `.agent/` logs and structured run state.

The daemon's responsibility is the execution contract: resolve the script path, pass rendered args, set cwd/env, enforce timeouts, capture logs, normalize outcomes, and persist state. It should not impose a built-in command allowlist.

Script outcome mapping:

- exit `0` with stdout outcome: route to that outcome
- exit `0` without stdout outcome: route to `success`
- non-zero with stdout outcome: route to that outcome
- non-zero without stdout outcome: route to `failure`
- timeout: route to `timeout`
- startup error: route to `failure`

Script stdout outcomes support the same two forms as poll outcomes:

- a single token, such as `success`, `blocked`, or `cleanup_failed`
- JSON, such as `{"outcome":"success","capture":{"pr_url":"https://github.com/owner/repo/pull/123","pr_number":"123"}}`

Use JSON stdout when a script needs to return multiple captured values. The daemon merges `capture` into workflow context after validating it is a string-keyed object.

Cleanup is not a special daemon behavior. It should be modeled as an ordinary workflow phase, usually a `script` phase with named outcomes. The workflow decides whether cleanup failure routes to `complete`, `cleanup_failed`, or `escalate`.

### Poll Phase

A daemon-owned polling phase for external state. PR monitoring should be implemented as native `herdr-implement` daemon behavior, not by wrapping the existing `herdr-worktree-flow` PR monitor script. The existing monitor is useful reference material for GitHub state categories, notification discipline, and tests, but the new skill should own its poll phase semantics directly.

For PR monitoring, the poll phase should inspect PR review, check, merge, and close state, then route through declared workflow transitions such as `feedback`, `checks_failed`, `merged`, `closed`, or `waiting`.

Poll phases should not disappear into an opaque blocking wait. Each tick should inspect external state once, persist the observed result and next wake time, then sleep according to `intervalSeconds`. The daemon continues this loop until a declared transition condition matches or the phase times out. This keeps recovery deterministic because the latest observed external state is always in run state.

The PR loop should remain phase-composable. The reference workflow separates PR handling into phases such as `await_review`, `route_review_failure`, `handle_review`, `await_merge`, and `route_merge_failure`, backed by small scripts that check review, merge, and closed state. `herdr-implement` should follow that shape: PR behavior is modeled as ordinary workflow phases and transitions, not as a hardcoded daemon mode.

Poll outcome mapping:

- exit `0` with stdout outcome: route to that outcome
- exit `0` without stdout outcome: route to `success`
- exit `1` with stdout outcome: route to that outcome, defaulting to `waiting`
- exit `1` without stdout outcome: route to `waiting`
- exit `>=2` with stdout outcome: route to that outcome, defaulting to `failure`
- exit `>=2` without stdout outcome: route to `failure`
- timeout: route to `timeout`

Stdout outcomes support two forms:

- a single token, such as `approved`, `changes_requested`, or `merged`
- JSON, such as `{"outcome":"approved","capture":{"pr_number":"123"}}`

Use JSON stdout when a script needs to return multiple captured values, such as `create_pr` returning both `pr_url` and `pr_number`. The daemon merges `capture` into workflow context after validating it is a string-keyed object.

### Terminal Phase

A terminal phase ends the daemon run. Terminal phases should stay simple: record terminal status, outcome, timestamps, and final context. Do not add a `notify` schema field in the initial design; if notification behavior is needed later, it can be modeled as a normal phase before terminal.

### Context

Structured values captured during a run, such as `worktree`, `workspaceId`, `implementerAgent`, `reviewerAgent`, `prUrl`, `prNumber`, `reviewFindings`, and `setupStatus`.

Context must not become a secret store. Anything captured from command output needs a schema, redaction behavior, and auditability.

### Herdr Adapter

The daemon should talk to Herdr through a narrow adapter rather than scattering CLI calls throughout phase code. The adapter is a tool boundary, not a workflow authority. It should cover:

- workspace discovery
- worktree creation
- agent start
- pane move
- agent send
- agent get/list when needed for validation
- tab creation for non-agent daemon or monitor processes

### Agent Run Contract

The existing completion contract remains valuable. The daemon should create the run, record `resultPath` and `notifyTarget`, prompt the phase executor agent, and wait for `AGENT_RUN_COMPLETE` plus artifact validation before advancing.

Agent result artifacts should use the same routing shape as script and poll outcomes: a required `outcome` and optional `capture`. The artifact can still include richer agent-specific fields such as `status`, `summary`, and `payload`, but daemon routing should use `outcome`.

Example:

```json
{
  "schemaVersion": 1,
  "runId": "issue-15-review-001",
  "phase": "review",
  "role": "reviewer",
  "status": "complete",
  "outcome": "approved",
  "summary": "No Block or Major findings.",
  "capture": {
    "review_verdict": "approved"
  },
  "payload": {
    "findings": []
  }
}
```

The daemon merges `capture` into workflow context after validating it is a string-keyed object.

The daemon should own agent run status logic. Local Herdr research shows useful status and transcript primitives:

- `herdr agent get <target>` exposes machine-readable agent status and Herdr identifiers.
- `herdr agent wait <target> --status <idle|working|blocked|unknown>` can block until a status is reached.
- `herdr agent read <target>` can read recent transcript text.
- `herdr agent explain <target> --json` explains status detection.

These primitives do not appear to expose a structured agent result object. Therefore the primary source of truth for phase completion should remain the expected result artifact. Herdr status should determine whether a pending run is still active, blocked, idle-without-result, or missing. Transcript reads can be used as a recovery aid, not as the normal structured result source.

Suggested pending run status logic:

- result artifact exists and validates: accept result and route transition
- agent status is `working` and no result artifact exists: keep waiting
- agent status is `blocked` and no result artifact exists: mark run blocked or request blocker artifact
- agent status is `idle` and no result artifact exists: inspect transcript once, then mark run incomplete or request artifact rewrite
- agent target cannot be resolved: recover from stored handles if possible, otherwise route to blocked
- result artifact exists but fails validation: reject completion and ask the same role agent to rewrite it

### Phase Executor Agent

A Herdr/Codex agent that executes the current phase's task. The daemon chooses the role, prompt template, command envelope, and expected result schema from the workflow definition. The agent does not choose the next lifecycle state. It returns evidence, status, and any captured outputs through the result artifact.

### Role Declaration

A workflow-level declaration for a phase executor role. Built-in workflows can ship familiar roles such as `implementer` and `reviewer`, but project workflows may define new roles for their own process.

Each role declaration should include:

- `id`: stable role key used by phases
- `label`: Herdr tab label
- `agentNameTemplate`: deterministic Herdr/Codex agent name
- `model`: Codex model for the role
- `approval`: Codex approval mode
- `sandbox`: Codex sandbox mode
- `promptDefaults`: optional defaults inherited by phases using the role
- `resultSchemas`: allowed result schemas for this role
- `reuse`: whether the daemon should reuse the role agent across phases

Workflow-level defaults can provide common role settings:

```yaml
roleDefaults:
  approval: never
  sandbox: workspace-write
  model: gpt-5.5
  reuse: true
```

Roles may then override only the fields that differ:

```yaml
roles:
  - id: implementer
    label: implementer
    agentNameTemplate: "issue-{{ issue.number }}-implementer"
    model: gpt-5.4-mini
    resultSchemas:
      - implementer-result-v1
```

During workflow normalization, the daemon should resolve inherited defaults into an effective role configuration and write that effective configuration into run state. Recovery should never depend on reinterpreting defaults that might have changed after the run started.

Custom roles remain deterministic executors. They may specialize prompts, models, tools, result schemas, approval mode, and sandbox mode, but they still do not choose workflow transitions directly. The daemon routes based on structured results and declared phase transitions.

The default workflow should use a separate `simplifier` role after implementation rather than reusing `implementer`. Project workflows may choose to collapse those roles if they want a single agent to handle both phases.

Verification should be split in the default workflow. `verify` is an agent phase for reasoning about the completed work and selecting or interpreting project checks. `run_checks` is a script phase that executes deterministic verification commands. Check failures can route back to implementation or fixing through named outcomes.

Shipping should also be split into script phases. `commit_changes`, `push_branch`, and `create_pr` are deterministic shell operations and should be overridable per project through workflow scripts. This lets projects control commit message format, PR templates, remote names, and branch policies without daemon changes.

## Draft Workflow Shape

The built-in workflow can mirror the current skill lifecycle:

```text
setup_worktree
  -> post_worktree_setup
  -> write_issue_brief
  -> implement
  -> wait_implementer
  -> simplify
  -> wait_simplify
  -> review
  -> wait_reviewer
  -> route_review
  -> fix
  -> wait_fix
  -> verify
  -> wait_verify
  -> run_checks
  -> commit_changes
  -> push_branch
  -> create_pr
  -> monitor_pr
  -> route_pr_feedback
  -> cleanup
  -> done
```

The PDF's proposed state vocabulary maps cleanly to this, but the daemon should distinguish work states from wait states. For example, `implementing` is an agent run in progress, while `ready_for_review` is a transition outcome that queues review.

## Dynamic Workflow Proposal

Use declarative YAML for workflow override, with JSON accepted later if needed. YAML is friendlier for prompts and command lists; the daemon can compile it into a typed internal JSON model.

Example sketch:

```yaml
name: herdr-standard
version: 1
type: herdr.issue

roleDefaults:
  approval: never
  sandbox: workspace-write
  model: gpt-5.5
  reuse: true

roles:
  - id: implementer
    label: implementer
    agentNameTemplate: "issue-{{ issue.number }}-implementer"
    model: gpt-5.4-mini
    resultSchemas:
      - implementer-result-v1

  - id: accessibility_reviewer
    label: a11y-review
    agentNameTemplate: "issue-{{ issue.number }}-a11y-reviewer"
    resultSchemas:
      - reviewer-result-v1

phases:
  - id: implement
    type: agent
    role: implementer
    promptTemplate: implement.md
    resultSchema: implementer-result-v1
    maxAttempts: 2
    on:
      complete: review
      blocked: blocked
      failed: blocked

  - id: review
    type: agent
    role: reviewer
    promptTemplate: review.md
    resultSchema: reviewer-result-v1
    on:
      approved: verify
      needs_fix: fix
      blocked: blocked
```

The daemon should validate workflow definitions before execution:

- every phase id is unique
- explicit `start` exists and points at a phase
- every `on` transition target exists
- terminal phases are explicit
- script and poll commands reference executable shell scripts
- every agent phase role maps to a declared role
- every declared role maps to a launch policy and result contract
- inherited role defaults are resolved during workflow normalization
- captures have declared names and types
- retry and timeout values have sane bounds
- required workflow-type contracts are present, even if the project workflow adds, removes, or reorders phases

## Prompt Templates And Commands

The reference workflow separates `promptTemplate` and `command`. This design should preserve that split.

`promptTemplate` should be a named template resolved relative to the workflow definition first, then the skill defaults. It supplies the natural-language task contract for an agent phase.

`command` should be interpreted as a shell script path or script name resolved from the workflow/script search path. For example:

```yaml
type: herdr.issue

phases:
  - id: post_worktree_setup
    type: script
    command: scripts/post-worktree-setup.sh
    args:
      worktree: "{{ context.worktreePath }}"
    on:
      success: write_issue_brief
      blocked: blocked

  - id: implement
    type: agent
    role: implementer
    promptTemplate: implement.md
    command: agent-run
    resultSchema: implementer-result-v1
    on:
      complete: review
      blocked: blocked
```

This gives workflow authors the same mental model as the reference project: workflow phases point at scripts, and those scripts own their internal behavior. Since project workflows are authoritative, they may add, remove, reorder phases, and define script commands. The daemon keeps command execution auditable through logs, state, timeout handling, and explicit outcomes.

## Recovery Contract

Recovery is a first-class requirement. The daemon should write state after every phase boundary and before every external side effect that cannot be safely repeated.

Recovery sources:

- `.agent/herdr-workflow-run.json` for active phase, context, attempts, role handles, pending run id, and accepted completions
- `.agent/herdr-implement.json` for Herdr workspace/tab/pane/agent handles
- `.agent/runs/<runId>/result.json` for agent completion evidence
- `.agent/runs/<runId>/notification.json` for notification delivery evidence
- `.agent/pr-monitor.json` for PR monitoring status
- Git and GitHub state for branch, commit, PR, merge, and close status

On restart, the daemon should:

1. Load and validate the run file.
2. Reconcile Herdr handles with `herdr agent get/list` where needed.
3. If a phase is waiting on an agent run, check for an accepted or pending result artifact before dispatching anything new.
4. If the last recorded phase had an incomplete side effect, use idempotency keys or state checks before retrying.
5. Resume at the active phase or route to `blocked` with a concrete recovery reason.

Recovery must prefer "observe before repeat" for worktree creation, agent launch, commit, push, PR creation, and cleanup.

After all core phase types are implemented, run a dedicated recovery hardening pass. The pass should verify that interrupted or restarted runs do not duplicate external side effects: worktrees, daemon panes, role agents, pending agent prompts, commits, pushes, PRs, poll observations, or cleanup actions.

## First Slice

The first slice should be documentation plus a minimal daemon skeleton, not a fully dynamic platform.

Recommended scope:

- Create the new skill folder side by side with `herdr-worktree-flow`.
- Add a concise `SKILL.md` for starting daemon-driven Herdr work from an existing issue.
- Add an ADR for the daemon boundary and ownership model.
- Add a workflow schema draft and built-in default workflow under the new skill.
- Add a TypeScript workflow loader/validator with tests under the new skill.
- Add a dry-run command that reads a workflow and prints the normalized phase graph.
- Do not launch agents or create worktrees from the daemon yet.

This lets us debate the graph and safety model before handing it write access over worktrees, branches, Herdr panes, commits, and PRs.

## Second Slice

- Implement daemon state persistence in `.agent/herdr-workflow-run.json`.
- Implement a bootstrap script that creates the Herdr worktree workspace, writes initial files, creates the daemon pane, and starts `daemon.ts` in that pane.
- Write the initial workflow run state and Herdr workspace handle state after worktree creation and before starting the daemon pane.
- Implement the continuous daemon loop over the first deterministic phase types.
- Implement `herdr-worktree`, `decision`, and `terminal` phase semantics.
- Add a workflow-defined cleanup/stop phase convention.
- Add deterministic recovery from interrupted runs.

## Third Slice

- Implement Herdr adapter and `agent` phase launch/send behavior.
- Reuse `agent-run-complete.ts` for completion notification.
- Add fixture-based integration tests with a fake Herdr binary.

## Fourth Slice

- Implement native PR monitoring as a workflow `poll` phase.
- Route PR feedback back into fix/review loops.
- Add cleanup behavior for merged or closed PRs.

## Remaining Hard Questions

1. What is the exact schema for `type: herdr.issue` phases?
2. Which command names are built into `herdr.issue`, and which ones may a repo override?
3. Should workflow state be visible as first-class Herdr task state, or only through daemon logs and local `.agent/` files?
4. What should the daemon do if Herdr says an agent no longer exists but a pending run artifact is absent?
5. What is the security boundary for captured command output and local state files?
6. Which role fields should be required after inheritance: `id`, `label`, `agentNameTemplate`, `model`, `approval`, `sandbox`, and at least one result schema?

## Current Design Bias

The safest architecture is:

- daemon owns deterministic workflow state
- agents execute the active phase and return structured evidence
- Herdr owns worktree, pane, tab, and TUI visibility
- local `.agent/` files remain the audit and recovery substrate
- workflow overrides configure the phase graph and script commands directly

This keeps the system debuggable while still allowing workflows to evolve beyond one hardcoded state machine.
