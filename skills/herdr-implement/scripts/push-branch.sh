#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: push-branch.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.
  HERDR_REMOTE          Optional remote name override. Defaults to origin.
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
remote_name="${HERDR_REMOTE:-origin}"
branch_name="${HERDR_BRANCH_NAME:-$(git -C "$worktree_path" branch --show-current)}"

if [[ -z "$branch_name" ]]; then
  printf 'failure\n'
  exit 0
fi

if ! git -C "$worktree_path" push --set-upstream "$remote_name" "$branch_name" >/dev/null; then
  printf 'failure\n'
  exit 0
fi

printf 'success\n'
