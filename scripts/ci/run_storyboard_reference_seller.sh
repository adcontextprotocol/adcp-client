#!/usr/bin/env bash
set -euo pipefail

CALLER_CWD="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ADCP_PORT="${ADCP_PORT:-3002}"
ADCP_AUTH_TOKEN="${ADCP_AUTH_TOKEN:-sk_harness_do_not_use_in_prod}"
ADCP_UPSTREAM_API_KEY="${ADCP_UPSTREAM_API_KEY:-mock_sales_guaranteed_key_do_not_use_in_prod}"
# The TS reference seller is this repo's checked-out example server:
# examples/hello_seller_adapter_guaranteed.ts. That specialism composes the
# applicable media_buy_seller scenarios through requires_scenarios; callers can
# override this to probe a narrower or broader storyboard id.
ADCP_STORYBOARD_ID="${ADCP_STORYBOARD_ID:-sales_guaranteed}"
ADCP_RUNNER_TIMEOUT_SECONDS="${ADCP_RUNNER_TIMEOUT_SECONDS:-180}"
ADCP_STORYBOARD_RETRIES="${ADCP_STORYBOARD_RETRIES:-0}"

make_absolute_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$CALLER_CWD" "$1" ;;
  esac
}

if [[ -n "${ADCP_SDK_TARBALL:-}" ]]; then
  ADCP_SDK_TARBALL="$(make_absolute_path "$ADCP_SDK_TARBALL")"
fi
if [[ -n "${ADCP_RUNNER_DIR:-}" ]]; then
  ADCP_RUNNER_DIR="$(make_absolute_path "$ADCP_RUNNER_DIR")"
fi
if [[ -n "${ADCP_RUNNER_BIN:-}" && "$ADCP_RUNNER_BIN" == */* ]]; then
  ADCP_RUNNER_BIN="$(make_absolute_path "$ADCP_RUNNER_BIN")"
fi

STORYBOARD_RESULT_PATH="$(make_absolute_path "${STORYBOARD_RESULT_PATH:-storyboard-result-ts.json}")"
SELLER_LOG_PATH="$(make_absolute_path "${SELLER_LOG_PATH:-storyboard-seller-ts.log}")"
mkdir -p "$(dirname "$STORYBOARD_RESULT_PATH")" "$(dirname "$SELLER_LOG_PATH")"
: >"$SELLER_LOG_PATH"

TMP_ROOT_CREATED=0
if [[ -n "${ADCP_HARNESS_TMPDIR:-}" ]]; then
  TMP_ROOT="$(make_absolute_path "$ADCP_HARNESS_TMPDIR")"
  mkdir -p "$TMP_ROOT"
else
  TMP_ROOT="$(mktemp -d)"
  TMP_ROOT_CREATED=1
fi

MOCK_PID=""
SELLER_PID=""

cleanup() {
  local status=$?
  for pid in "$SELLER_PID" "$MOCK_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  if [[ "$TMP_ROOT_CREATED" == "1" && "${ADCP_KEEP_HARNESS_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

log() {
  printf '[ts-reference-seller] %s\n' "$*" >&2
  printf '[ts-reference-seller] %s\n' "$*" >>"$SELLER_LOG_PATH"
}

pick_free_port() {
  node <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => {
    process.stdout.write(String(port));
  });
});
server.on('error', err => {
  console.error(err.message);
  process.exit(1);
});
NODE
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if node -e "const s=require('node:net').connect($port, '$host', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 1000);" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

resolve_runner_cmd() {
  if [[ -n "${ADCP_RUNNER_BIN:-}" ]]; then
    if [[ "$ADCP_RUNNER_BIN" == */* ]]; then
      if [[ ! -f "$ADCP_RUNNER_BIN" ]]; then
        log "ADCP_RUNNER_BIN does not exist: $ADCP_RUNNER_BIN"
        return 1
      fi
      RUNNER_CMD=("$ADCP_RUNNER_BIN")
    else
      local resolved_bin
      resolved_bin="$(command -v "$ADCP_RUNNER_BIN" || true)"
      if [[ -z "$resolved_bin" ]]; then
        log "ADCP_RUNNER_BIN is not on PATH: $ADCP_RUNNER_BIN"
        return 1
      fi
      RUNNER_CMD=("$resolved_bin")
    fi
    return 0
  fi

  if [[ -n "${ADCP_RUNNER_DIR:-}" ]]; then
    local runner_js="$ADCP_RUNNER_DIR/node_modules/@adcp/sdk/bin/adcp.js"
    if [[ ! -f "$runner_js" ]]; then
      log "ADCP_RUNNER_DIR does not contain node_modules/@adcp/sdk/bin/adcp.js: $ADCP_RUNNER_DIR"
      return 1
    fi
    RUNNER_CMD=(node "$runner_js")
    return 0
  fi

  if [[ -n "${ADCP_SDK_TARBALL:-}" ]]; then
    if [[ ! -f "$ADCP_SDK_TARBALL" ]]; then
      log "ADCP_SDK_TARBALL does not exist: $ADCP_SDK_TARBALL"
      return 1
    fi
    local runner_dir="$TMP_ROOT/candidate-runner"
    mkdir -p "$runner_dir"
    log "Installing candidate SDK runner from $ADCP_SDK_TARBALL"
    (
      cd "$runner_dir"
      npm init -y >/dev/null
      npm install --no-audit --no-fund --ignore-scripts "$ADCP_SDK_TARBALL" >>"$SELLER_LOG_PATH" 2>&1
    )
    RUNNER_CMD=(node "$runner_dir/node_modules/@adcp/sdk/bin/adcp.js")
    return 0
  fi

  RUNNER_CMD=(node "$REPO_ROOT/bin/adcp.js")
}

ADCP_UPSTREAM_PORT="${ADCP_UPSTREAM_PORT:-$(pick_free_port)}"

log "Repository root: $REPO_ROOT"
log "Storyboards: $ADCP_STORYBOARD_ID"
log "Seller port: $ADCP_PORT"
log "Mock upstream port: $ADCP_UPSTREAM_PORT"
log "Result path: $STORYBOARD_RESULT_PATH"
log "Seller log path: $SELLER_LOG_PATH"

cd "$REPO_ROOT"

if [[ "${ADCP_SKIP_NPM_CI:-0}" != "1" ]]; then
  log "Installing reference seller dependencies with npm ci"
  npm ci >>"$SELLER_LOG_PATH" 2>&1
fi

if [[ "${ADCP_SKIP_BUILD:-0}" != "1" ]]; then
  log "Building reference seller checkout"
  npm run build:lib >>"$SELLER_LOG_PATH" 2>&1
elif [[ ! -f "$REPO_ROOT/dist/lib/index.js" ]]; then
  log "ADCP_SKIP_BUILD=1 was set, but dist/lib/index.js is missing"
  exit 1
fi

resolve_runner_cmd

log "Starting sales-guaranteed mock upstream"
node "$REPO_ROOT/bin/adcp.js" mock-server sales-guaranteed \
  --port "$ADCP_UPSTREAM_PORT" \
  --api-key "$ADCP_UPSTREAM_API_KEY" >>"$SELLER_LOG_PATH" 2>&1 &
MOCK_PID=$!

if ! wait_for_port 127.0.0.1 "$ADCP_UPSTREAM_PORT" 30; then
  log "Timed out waiting for mock upstream on port $ADCP_UPSTREAM_PORT"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

log "Starting TypeScript sales-guaranteed reference seller"
NODE_ENV=development \
  PORT="$ADCP_PORT" \
  UPSTREAM_URL="http://127.0.0.1:$ADCP_UPSTREAM_PORT" \
  UPSTREAM_API_KEY="$ADCP_UPSTREAM_API_KEY" \
  ADCP_AUTH_TOKEN="$ADCP_AUTH_TOKEN" \
  npx tsx examples/hello_seller_adapter_guaranteed.ts >>"$SELLER_LOG_PATH" 2>&1 &
SELLER_PID=$!

if ! wait_for_port 127.0.0.1 "$ADCP_PORT" 30; then
  log "Timed out waiting for TypeScript reference seller on port $ADCP_PORT"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

check_storyboard_result() {
  node - "$STORYBOARD_RESULT_PATH" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
let result;
try {
  result = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`[ts-reference-seller] Could not parse storyboard result JSON at ${path}: ${err.message}`);
  process.exit(1);
}
const status = result.overall_status;
const passed = result.passed_count ?? result.summary?.steps_passed ?? '?';
const failed = result.failed_count ?? result.summary?.steps_failed ?? '?';
const skipped = result.skipped_count ?? result.summary?.steps_skipped ?? '?';
console.error(`[ts-reference-seller] overall_status=${status} passed=${passed} failed=${failed} skipped=${skipped}`);
if (status !== 'passing') {
  process.exit(1);
}
if (result.controller_detected !== true) {
  console.error('[ts-reference-seller] comply_test_controller was not detected; deterministic scenario coverage is incomplete');
  process.exit(1);
}
NODE
}

MAX_ATTEMPTS=$((ADCP_STORYBOARD_RETRIES + 1))
ATTEMPT=1
RUN_STATUS=1
RESULT_STATUS=1
while (( ATTEMPT <= MAX_ATTEMPTS )); do
  log "Running candidate SDK storyboard runner (attempt $ATTEMPT/$MAX_ATTEMPTS)"
  RUN_STATUS=0
  ADCP_AUTH_TOKEN="$ADCP_AUTH_TOKEN" "${RUNNER_CMD[@]}" storyboard run "http://127.0.0.1:$ADCP_PORT/mcp" "$ADCP_STORYBOARD_ID" \
    --json \
    --allow-http \
    --webhook-receiver \
    --timeout "$ADCP_RUNNER_TIMEOUT_SECONDS" >"$STORYBOARD_RESULT_PATH" 2>>"$SELLER_LOG_PATH" || RUN_STATUS=$?

  set +e
  check_storyboard_result
  RESULT_STATUS=$?
  set -e

  if [[ "$RUN_STATUS" == "0" && "$RESULT_STATUS" == "0" ]]; then
    break
  fi

  if (( ATTEMPT < MAX_ATTEMPTS )); then
    log "Storyboard attempt $ATTEMPT failed (runner exit=$RUN_STATUS, status check=$RESULT_STATUS); retrying"
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

if [[ "$RUN_STATUS" != "0" || "$RESULT_STATUS" != "0" ]]; then
  log "Storyboard run failed (runner exit=$RUN_STATUS, status check=$RESULT_STATUS)"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

log "TypeScript reference seller storyboard passed"
