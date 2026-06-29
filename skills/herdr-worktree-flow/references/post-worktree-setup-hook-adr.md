# ADR: Post-Worktree Setup Hook

Date: 2026-06-29
Status: Accepted

## Context

Some repositories need deterministic setup after Herdr creates an issue worktree but before the issue orchestrator starts. Without an explicit hook, every issue orchestrator must rediscover setup requirements, and failures such as missing dependencies appear after handoff instead of before it.

## Decision

The main orchestrator runs a committed executable hook at exactly `.agent/herdr-post-worktree-setup` in the new worktree after `herdr worktree create` and before writing the final issue brief or launching the issue orchestrator.

The hook is extensionless and uses its shebang to choose the runtime. It runs with the issue worktree as the current working directory. Missing hooks are a successful skipped setup. Present hooks must be executable.

The helper script is `skills/herdr-worktree-flow/scripts/post-worktree-setup.ts`. It enforces a fixed 10-minute timeout, writes full stdout and stderr to `.agent/post-worktree-setup.log`, and verifies a clean worktree with:

```bash
git status --porcelain --untracked-files=normal
```

Setup blocks handoff when the hook is non-executable, cannot start, exits non-zero, times out, or leaves tracked changes or non-ignored untracked files. The issue brief records status and log path, not full logs.

## Consequences

Projects can declare setup in the repository without Herdr CLI changes or package-manager inference. Setup output remains local agent state. Hooks that need to update tracked files must have those updates committed before the worktree flow starts.
