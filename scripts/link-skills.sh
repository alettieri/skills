#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="${SKILLS_DIR:-${REPO_ROOT}/skills}"
AGENTS_DIR="${AGENTS_DIR:-${HOME}/.agents/skills}"
CLAUDE_DIR="${CLAUDE_DIR:-${HOME}/.claude/skills}"

if ! command -v realpath >/dev/null 2>&1; then
  echo "realpath is required but not found." >&2
  exit 1
fi

link_skills_into() {
  local dest_dir="$1"

  mkdir -p "${dest_dir}"
  echo "== linking into ${dest_dir} =="

  for skill in "${SKILLS_DIR}"/*; do
    [ -d "${skill}" ] || continue

    name="$(basename "${skill}")"
    target="${dest_dir}/${name}"

    if [ -L "${target}" ]; then
      current="$(readlink "${target}")"
      real_target="$(realpath "${target}")"
      real_source="$(realpath "${skill}")"
      if [ "${real_target}" = "${real_source}" ]; then
        echo "exists: ${name}"
        continue
      fi

      echo "skip (symlink mismatch): ${name} -> ${current}" >&2
      continue
    fi

    if [ -e "${target}" ]; then
      echo "skip (exists): ${name}" >&2
      continue
    fi

    ln -s "${skill}" "${target}"
    echo "linked: ${name}"
  done
}

link_skills_into "${AGENTS_DIR}"
link_skills_into "${CLAUDE_DIR}"
