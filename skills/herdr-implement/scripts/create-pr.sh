#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: create-pr.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.
  HERDR_BASE_BRANCH     Optional base branch override. Defaults to main.
EOF
}

emit_pr_json() {
  local outcome="$1"
  local capture_json="$2"
  node - "$outcome" "$capture_json" <<'NODE'
const [outcome, captureJson] = process.argv.slice(2);
const capture = JSON.parse(captureJson);
process.stdout.write(`${JSON.stringify({ outcome, capture })}\n`);
NODE
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
base_branch="${HERDR_BASE_BRANCH:-main}"
branch_name="${HERDR_BRANCH_NAME:-$(git -C "$worktree_path" branch --show-current)}"

if [[ -z "$branch_name" ]]; then
  printf 'failure\n'
  exit 0
fi

if command -v gh >/dev/null 2>&1; then
  if pr_json="$(gh pr view --json number,url --jq '{pr_number: .number, pr_url: .url}' 2>/dev/null)"; then
    emit_pr_json 'existing' "$pr_json"
    exit 0
  fi

  if ! gh pr create --base "$base_branch" --head "$branch_name" --fill >/dev/null; then
    printf 'failure\n'
    exit 0
  fi

  if pr_json="$(gh pr view --json number,url --jq '{pr_number: .number, pr_url: .url}' 2>/dev/null)"; then
    emit_pr_json 'success' "$pr_json"
    exit 0
  fi
fi

printf 'failure\n'
