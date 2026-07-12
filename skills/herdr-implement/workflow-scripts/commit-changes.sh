#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: commit-changes.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.
  HERDR_COMMIT_MESSAGE  Optional commit message override.
  HERDR_ISSUE_CANONICAL Fallback issue reference for generated commit messages.
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

if [[ -z "$(git -C "$worktree_path" status --porcelain --untracked-files=normal)" ]]; then
  printf 'no_changes\n'
  exit 0
fi

commit_message="${HERDR_COMMIT_MESSAGE:-}"
if [[ -z "$commit_message" ]]; then
  if [[ -n "${HERDR_ISSUE_CANONICAL:-}" ]]; then
    commit_message="Issue ${HERDR_ISSUE_CANONICAL}: herdr workflow changes"
  else
    commit_message='herdr: workflow changes'
  fi
fi

if ! git -C "$worktree_path" add -A; then
  printf 'failure\n'
  exit 0
fi

if ! git -C "$worktree_path" commit -m "$commit_message" >/dev/null; then
  printf 'failure\n'
  exit 0
fi

printf 'success\n'
