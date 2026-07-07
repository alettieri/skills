#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-checks.sh [worktree-path]

Arguments:
  worktree-path   Optional worktree root. Defaults to $HERDR_WORKTREE_PATH or the current directory.

Environment:
  HERDR_WORKTREE_PATH   Fallback worktree root when no positional path is supplied.

Behavior:
  Runs the repo's discovered package scripts in a conservative order: typecheck, then test.
  If neither script exists, emits no_checks.
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
package_json="$worktree_path/package.json"

if [[ ! -f "$package_json" ]]; then
  printf 'no_checks\n'
  exit 0
fi

discovered_scripts=()
while IFS= read -r script_name; do
  if [[ -n "$script_name" ]]; then
    discovered_scripts+=("$script_name")
  fi
done < <(
  node - "$package_json" <<'NODE'
const fs = require('node:fs');
const packageJsonPath = process.argv[2];
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const scripts = pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const name of ['typecheck', 'test']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') {
      process.stdout.write(`${name}\n`);
    }
  }
} catch {
  // No discovered checks.
}
NODE
)

if [[ ${#discovered_scripts[@]} -eq 0 ]]; then
  printf 'no_checks\n'
  exit 0
fi

package_manager=''
if command -v pnpm >/dev/null 2>&1; then
  package_manager='pnpm'
elif command -v npm >/dev/null 2>&1; then
  package_manager='npm'
else
  printf 'failure\n'
  exit 0
fi

failed=0
for script_name in "${discovered_scripts[@]}"; do
  if [[ "$package_manager" == "pnpm" ]]; then
    if ! pnpm "$script_name" 1>&2; then
      failed=1
    fi
  else
    if ! npm run "$script_name" 1>&2; then
      failed=1
    fi
  fi
done

if [[ $failed -eq 1 ]]; then
  printf 'checks_failed\n'
else
  printf 'success\n'
fi
