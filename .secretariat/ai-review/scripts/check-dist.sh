#!/usr/bin/env bash
#
# CI guard: fail if a node action's committed dist/ is out of sync with its
# source. Rebuilds each action from a clean install and checks for drift.
#
# This is the real enforcer behind the pre-commit dist-rebuild hook: local hooks
# can be bypassed (--no-verify), only exist if `prepare` ran, and are skipped on
# partial commits. This check runs in CI and cannot be skipped.
#
# Self-contained here so it travels with the .secretariat/ai-review tree.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

status=0
for action in setup arbiter; do
  dir=".secretariat/ai-review/${action}"
  echo "::group::rebuild ${dir}"
  (cd "$dir" && npm ci && npm run build)
  echo "::endgroup::"
  if ! git diff --quiet -- "${dir}/dist"; then
    echo "::error file=${dir}/dist::Committed ${dir}/dist is stale — run 'npm run build' in ${dir} and commit the result."
    git --no-pager diff --stat -- "${dir}/dist"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "✅ All .secretariat/ai-review action dist/ bundles are in sync with source."
fi
exit "$status"
