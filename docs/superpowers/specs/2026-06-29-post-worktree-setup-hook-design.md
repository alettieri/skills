# Post-Worktree Setup Hook Design

Date: 2026-06-29
Status: Draft for review
Skill: `herdr-worktree-flow`

## Context

The `herdr-worktree-flow` skill creates an isolated Herdr git worktree, writes a canonical issue brief, starts an issue orchestrator, and hands the issue lifecycle to that orchestrator. Some project repositories need deterministic setup immediately after the worktree exists and before any agent starts reasoning in it. A common example is installing dependencies with `pnpm install`.

Today, that setup has to be done manually or left for the issue orchestrator to discover. That makes the worktree readiness contract implicit and can waste model time on missing dependencies or local setup failures.

## Goals

- Let a project repository declare a post-worktree setup command.
- Run setup after worktree creation and before issue orchestrator launch.
- Keep the hook project-owned and reproducible from the committed base branch.
- Block handoff when setup fails or dirties the worktree.
- Preserve full setup output for debugging without bloating the issue brief.
- Avoid Herdr CLI changes or package-manager-specific assumptions.

## Non-Goals

- Do not add a general hook framework.
- Do not support multiple hook locations in the first version.
- Do not infer package-manager commands automatically.
- Do not allow user-local source checkout scripts to affect worktree setup.
- Do not allow setup to create implementation diffs before the issue starts.

## Decision

Add a single exact post-worktree setup hook path:

```text
.agent/herdr-post-worktree-setup
```

The hook must exist in the newly created worktree. That means the hook is committed on the base branch and visible to the issue worktree. The main orchestrator does not copy a hook from the source checkout and does not search alternate paths.

The hook is extensionless so the shebang chooses the runtime. Example:

```sh
#!/usr/bin/env bash
set -euo pipefail
pnpm install
```

If the hook is absent, setup succeeds with a "no hook found" result. If the hook is present but not executable, setup fails as a blocker.

## Execution Point

The post-worktree setup hook runs:

```text
create Herdr worktree -> run post-worktree setup -> write issue brief -> launch issue orchestrator
```

Running before issue orchestrator launch makes worktree readiness a main-orchestrator responsibility and avoids spending model time on deterministic dependency setup failures.

## Helper Script

Add a helper script to make behavior repeatable:

```text
skills/herdr-worktree-flow/scripts/post-worktree-setup.ts
```

The main orchestrator should invoke the helper with the worktree path after `herdr worktree create`.

The helper is responsible for:

- checking for `.agent/herdr-post-worktree-setup`
- requiring the hook to be executable when present
- running the hook from the worktree root
- enforcing a fixed 10-minute timeout
- writing full stdout/stderr to `.agent/post-worktree-setup.log`
- checking that the worktree remains clean after successful setup
- returning a clear success, skipped, or blocker result

## Clean Worktree Rule

After a successful hook run, the helper must verify:

```bash
git status --porcelain --untracked-files=normal
```

returns no output.

This allows ignored local files such as `node_modules`, caches, and build artifacts. It blocks tracked changes and untracked non-ignored files. If setup needs to update a lockfile or committed config, that change should be committed separately before using the workflow.

## Blocking Behavior

Setup failure is always blocking.

The helper must fail when:

- the hook exists but is not executable
- the hook exits non-zero
- the hook times out
- the hook cannot be started
- the worktree is dirty after a successful hook run

The main orchestrator should stop before launching the issue orchestrator and report the setup blocker with the log path.

## Logging

Full setup output goes to:

```text
.agent/post-worktree-setup.log
```

The issue brief should include only:

- hook status: `skipped`, `succeeded`, or `blocked`
- hook path
- log path, when a hook ran or failed to start
- exit code or timeout marker, when applicable
- a short tail summary for failures

Hooks must not print secrets. Setup logs are local agent state and should not be committed unless the repository explicitly tracks similar local handoff files.

## Skill Documentation Updates

The first implementation should update:

- `skills/herdr-worktree-flow/SKILL.md`
- `skills/herdr-worktree-flow/references/issue-brief-template.md`
- `skills/herdr-worktree-flow/references/glossary.md`
- `skills/herdr-worktree-flow/references/post-worktree-setup-hook-adr.md`

The workflow should explicitly say that setup runs after worktree creation and before issue orchestrator launch.

## Acceptance Criteria

- A committed executable `.agent/herdr-post-worktree-setup` hook is run from the issue worktree root when present.
- Missing hook files are treated as a successful skipped setup.
- Present non-executable hooks fail setup before issue orchestrator launch.
- Hook failures, startup errors, and timeouts block handoff.
- Successful hook execution is followed by a clean worktree check.
- Tracked changes and untracked non-ignored files after setup block handoff.
- Full setup output is written to `.agent/post-worktree-setup.log`.
- The issue brief records setup status and log path without embedding full logs.
- The implementation has tests for skipped, success, non-executable, non-zero exit, timeout, and dirty-worktree cases.

## Open Follow-Ups

- Add repo-configurable timeout only if the fixed 10-minute timeout proves too rigid.
- Add alternate hook paths only if real repositories need them.
- Consider package-script conventions later as a separate feature, not part of this first hook contract.
