#!/usr/bin/env bash
# Run pinned reference harnesses with the candidate SDK artifact. The pinned
# Python seller supports AdCP 3.2, so exercise that maintained compatibility
# bundle while the candidate SDK's primary protocol is a 3.3 preview.
set -euo pipefail
language="${1:?reference language is required}"
harness="${2:?reference harness path is required}"
if [[ "$language" != python ]]; then
  exec "./$harness"
fi

task_runner_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/adcp-python-runner.XXXXXX")"
trap 'rm -rf "$task_runner_dir"' EXIT
npm install --prefix "$task_runner_dir" --ignore-scripts --no-audit --no-fund "${ADCP_SDK_TARBALL:?candidate SDK tarball is required}"
export ADCP_INTEROP_REAL_RUNNER="$task_runner_dir/node_modules/.bin/adcp"
export ADCP_SDK_ROOT="$task_runner_dir/node_modules/@adcp/sdk"
export ADCP_INTEROP_RUNNER_MARKER="$task_runner_dir/executed"
cat > "$task_runner_dir/runner" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == storyboard && "${2:-}" == run ]]; then
  touch "$ADCP_INTEROP_RUNNER_MARKER"
  exec "$ADCP_INTEROP_REAL_RUNNER" storyboard run --compliance-version 3.2.7 "${@:3}"
fi
exec "$ADCP_INTEROP_REAL_RUNNER" "$@"
RUNNER
chmod +x "$task_runner_dir/runner"
export ADCP_RUNNER_BIN="$task_runner_dir/runner"
unset ADCP_SDK_TARBALL ADCP_SDK_VERSION
"./$harness"
[[ -f "$ADCP_INTEROP_RUNNER_MARKER" ]] || { echo "Candidate SDK runner was not invoked" >&2; exit 1; }
