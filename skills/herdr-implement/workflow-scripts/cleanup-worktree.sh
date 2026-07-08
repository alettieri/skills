#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cleanup-worktree.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.

Behavior:
  Removes transient workflow run output under .agent/runs when it exists and can be removed safely.
  The command is idempotent and emits success when the cleanup target is already absent.
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

worktree_path="${1:-${HERDR_WORKTREE_PATH:-$PWD}}"
worktree_path="$(cd "$worktree_path" && pwd -P)"
runs_path="$worktree_path/.agent/runs"

if [[ -e "$runs_path" ]]; then
  if ! rm -rf "$runs_path"; then
    printf 'cleanup_failed\n'
    exit 0
  fi
fi

printf 'success\n'
