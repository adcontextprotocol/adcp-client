#!/usr/bin/env bash
#
# Pre-commit: keep each node action's committed dist/ in sync with its source.
#
# The setup and arbiter actions ship a bundled dist/index.js that GitHub Actions
# runs directly. If source changes land without a matching rebuild, the committed
# bundle goes stale and the action runs old code. When a staged change touches a
# node action's src/ or build config, this rebuilds that action and re-stages its
# dist/ so the bundle never lands stale.
#
# Self-contained here so the logic travels with the .secretariat/ai-review tree
# (Phase-2 extraction). Wired into .git/hooks/pre-commit by scripts/install-hooks.js,
# which only delegates to this file.
#
# Fast-exits when no action source is staged, so ordinary commits are unaffected.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$REPO_ROOT" || exit 0

TREE=".secretariat/ai-review"
STAGED="$(git diff --cached --name-only)"

rebuilt=0
for action in setup arbiter; do
  # Only the node actions have a committed dist/. Rebuild when their source or
  # build inputs are staged.
  if printf '%s\n' "$STAGED" | grep -qE "^${TREE}/${action}/(src/|scripts/|package\.json|package-lock\.json|tsconfig\.json)"; then
    dir="${TREE}/${action}"
    if [ ! -d "${dir}/node_modules" ]; then
      echo "⚠️  ${dir}: node_modules missing — run 'npm ci' in that directory." >&2
      echo "    Skipping dist rebuild; the committed dist/ may be stale (CI will catch it)." >&2
      continue
    fi
    echo "🔧 [aao-secretariat] rebuilding ${dir}/dist ..." >&2
    if ! ( cd "$dir" && npm run build >/dev/null 2>&1 ); then
      echo "❌ ${dir} build failed — fix before committing." >&2
      exit 1
    fi
    git add "${dir}/dist"
    rebuilt=$((rebuilt + 1))
  fi
done

if [ "$rebuilt" -gt 0 ]; then
  echo "✅ [aao-secretariat] re-staged dist/ for ${rebuilt} action(s)." >&2
fi
exit 0
