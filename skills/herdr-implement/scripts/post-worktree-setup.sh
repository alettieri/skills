#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: post-worktree-setup.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.
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
hook_path="$worktree_path/.agent/herdr-post-worktree-setup"
log_path="$worktree_path/.agent/post-worktree-setup.log"

mkdir -p "$(dirname "$log_path")"

if [[ ! -e "$hook_path" ]]; then
  printf 'skipped\n'
  printf 'missing hook: %s\n' "$hook_path" > "$log_path"
  exit 0
fi

if [[ ! -x "$hook_path" ]]; then
  printf 'blocked\n'
  printf 'hook exists but is not executable: %s\n' "$hook_path" > "$log_path"
  exit 0
fi

hook_output=''
if hook_output="$("$hook_path" 2>&1)"; then
  :
else
  printf 'blocked\n'
  {
    printf '%s\n' "$hook_output"
    printf 'hook failed: %s\n' "$hook_path"
  } > "$log_path"
  exit 0
fi

printf '%s\n' "$hook_output" > "$log_path"

git_status_output=''
if ! git_status_output="$(git -C "$worktree_path" status --porcelain --untracked-files=normal 2>&1)"; then
  printf 'blocked\n'
  {
    printf '%s\n' "$hook_output"
    printf '%s\n' "$git_status_output"
    printf 'hook left worktree dirty'
  } > "$log_path"
  exit 0
fi

if [[ -n "$git_status_output" ]]; then
  printf 'blocked\n'
  {
    printf '%s\n' "$hook_output"
    printf '%s\n' "$git_status_output"
    printf 'hook left worktree dirty'
  } > "$log_path"
  exit 0
fi

printf 'success\n'
