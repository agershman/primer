#!/bin/bash
# Pre-push lint + typecheck.
#
# `tsc --noEmit` must run project-wide — types can break across file
# boundaries — but `biome check` is scoped to files this branch
# touches relative to `origin/main`. That keeps the hook actionable
# (it fails on issues the author actually introduced) without
# blocking pushes on pre-existing lint debt elsewhere in the tree.
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

# Make sure we have an up-to-date view of `origin/main` for the
# diff base. Quiet failure — if there's no network or remote, fall
# back to the local ref.
git fetch origin main --quiet 2>/dev/null || true

# Determine the diff base. Prefer `origin/main` (the canonical
# baseline); fall back to local `main` if the remote ref is
# unavailable (offline, first push of a fork, etc.).
base="origin/main"
if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  base="main"
fi

# Files changed on this branch vs. main, filtered to source files
# Biome can check. `--diff-filter=ACMR` skips deleted files.
changed=$(git diff --name-only --diff-filter=ACMR "$base"...HEAD -- 'src/**' 2>/dev/null \
  | grep -E '\.(ts|tsx|js|jsx|json|css)$' || true)

if [ -n "$changed" ]; then
  # shellcheck disable=SC2086  # Word splitting is intentional here.
  bunx biome check $changed 1>&2 || exit 2
fi

bun run typecheck 1>&2 || exit 2
