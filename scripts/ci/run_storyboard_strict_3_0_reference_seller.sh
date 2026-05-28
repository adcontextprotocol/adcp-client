#!/usr/bin/env bash
set -euo pipefail

CALLER_CWD="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REFERENCE_REPO_ROOT="${ADCP_REFERENCE_REPO_ROOT:-}"

if [[ -z "$REFERENCE_REPO_ROOT" ]]; then
  echo "ADCP_REFERENCE_REPO_ROOT must point at a pinned AdCP 3.0 reference checkout." >&2
  exit 1
fi

case "$REFERENCE_REPO_ROOT" in
  /*) ;;
  *) REFERENCE_REPO_ROOT="$CALLER_CWD/$REFERENCE_REPO_ROOT" ;;
esac

ADCP_PORT="${ADCP_PORT:-3003}"
ADCP_INTERNAL_PORT="${ADCP_INTERNAL_PORT:-3004}"
ADCP_AUTH_TOKEN="${ADCP_AUTH_TOKEN:-sk_harness_do_not_use_in_prod}"
ADCP_STORYBOARD_ID="${ADCP_STORYBOARD_ID:-capability_discovery}"
ADCP_RUNNER_TIMEOUT_SECONDS="${ADCP_RUNNER_TIMEOUT_SECONDS:-120}"

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

STORYBOARD_RESULT_PATH="$(make_absolute_path "${STORYBOARD_RESULT_PATH:-storyboard-result-strict-3-0.json}")"
SELLER_LOG_PATH="$(make_absolute_path "${SELLER_LOG_PATH:-storyboard-seller-strict-3-0.log}")"
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

SELLER_PID=""
PROXY_PID=""
RUNNER_PACKAGE_ROOT=""

cleanup() {
  local status=$?
  for pid in "$PROXY_PID" "$SELLER_PID"; do
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
  printf '[strict-3-0-reference-seller] %s\n' "$*" >&2
  printf '[strict-3-0-reference-seller] %s\n' "$*" >>"$SELLER_LOG_PATH"
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
      RUNNER_PACKAGE_ROOT="$SDK_REPO_ROOT"
    else
      local resolved_bin
      resolved_bin="$(command -v "$ADCP_RUNNER_BIN" || true)"
      if [[ -z "$resolved_bin" ]]; then
        log "ADCP_RUNNER_BIN is not on PATH: $ADCP_RUNNER_BIN"
        return 1
      fi
      RUNNER_CMD=("$resolved_bin")
      RUNNER_PACKAGE_ROOT="$SDK_REPO_ROOT"
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
    RUNNER_PACKAGE_ROOT="$ADCP_RUNNER_DIR/node_modules/@adcp/sdk"
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
    RUNNER_PACKAGE_ROOT="$runner_dir/node_modules/@adcp/sdk"
    return 0
  fi

  RUNNER_CMD=(node "$SDK_REPO_ROOT/bin/adcp.js")
  RUNNER_PACKAGE_ROOT="$SDK_REPO_ROOT"
}

PROXY_AUDIT_PATH="$TMP_ROOT/strict-proxy-audit.json"

check_storyboard_result() {
  node - "$STORYBOARD_RESULT_PATH" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
let result;
try {
  result = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`[strict-3-0-reference-seller] Could not parse storyboard result JSON at ${path}: ${err.message}`);
  process.exit(1);
}
const status = result.overall_status;
const passed = result.passed_count ?? result.summary?.steps_passed ?? 0;
const failed = result.failed_count ?? result.summary?.steps_failed ?? 0;
const skipped = result.skipped_count ?? result.summary?.steps_skipped ?? 0;
console.error(`[strict-3-0-reference-seller] overall_status=${status} passed=${passed} failed=${failed} skipped=${skipped}`);
if (!['passing', 'partial'].includes(status) || failed !== 0 || skipped !== 0 || passed < 2) {
  process.exit(1);
}
NODE
}

check_proxy_audit() {
  node - "$PROXY_AUDIT_PATH" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
let audit;
try {
  audit = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`[strict-3-0-reference-seller] Could not parse strict proxy audit at ${path}: ${err.message}`);
  process.exit(1);
}
const forwardedTools = audit.forwardedTools ?? {};
const capabilitiesCalls = forwardedTools.get_adcp_capabilities ?? 0;
const getProductsCalls = forwardedTools.get_products ?? 0;
console.error(
  `[strict-3-0-reference-seller] strict_proxy forwarded=${audit.forwardedToolCallCount ?? 0} ` +
    `get_adcp_capabilities=${capabilitiesCalls} get_products=${getProductsCalls}`
);
if (capabilitiesCalls < 1 || getProductsCalls < 1) {
  process.exit(1);
}
NODE
}

probe_get_products_with_candidate_sdk() {
  node - "$RUNNER_PACKAGE_ROOT" "http://127.0.0.1:$ADCP_PORT/mcp" <<'NODE'
const path = require('node:path');
const packageRoot = process.argv[2];
const agentUrl = process.argv[3];
const { ProtocolClient } = require(path.join(packageRoot, 'dist/lib/index.js'));

ProtocolClient.callTool(
  {
    id: 'strict-3-0-probe',
    name: 'Strict 3.0 Probe',
    protocol: 'mcp',
    agent_uri: agentUrl,
  },
  'get_products',
  {
    buying_mode: 'brief',
    brief: 'Return a small representative sample of available advertising products',
    context: { correlation_id: 'strict-adcp-3-0--sdk-probe-get-products' },
  },
  { adcpVersion: '3.1.0-beta.7', versionEnvelope: 'major-only' }
)
  .then(response => {
    const serialized = JSON.stringify(response);
    if (/Unexpected keyword argument 'adcp_version'/.test(serialized)) {
      console.error(`[strict-3-0-reference-seller] candidate SDK get_products probe leaked adcp_version: ${serialized}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(err => {
    console.error(`[strict-3-0-reference-seller] candidate SDK get_products probe failed: ${err.message}`);
    process.exit(1);
  });
NODE
}

assert_strict_proxy_rejects_unknown_arguments() {
  node - "http://127.0.0.1:$ADCP_PORT/mcp" <<'NODE'
const url = process.argv[2];

async function assertRejected(tool, field, value) {
  const payload = {
    jsonrpc: '2.0',
    id: `strict-proxy-probe-${tool}-${field}`,
    method: 'tools/call',
    params: {
      name: tool,
      arguments: { [field]: value },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!body.error || !String(body.error.message).includes(field)) {
    console.error(`[strict-3-0-reference-seller] strict proxy probe did not reject ${field}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
}

Promise.all([
  assertRejected('get_adcp_capabilities', 'adcp_version', '3.1.0-beta.7'),
  assertRejected('get_adcp_capabilities', 'definitely_not_adcp_3_0', true),
  assertRejected('get_products', 'adcp_version', '3.1.0-beta.7'),
  assertRejected('get_products', 'get_products_extra_field', true),
]).catch(err => {
  console.error(`[strict-3-0-reference-seller] strict proxy probe failed: ${err.message}`);
  process.exit(1);
});
NODE
}

log "SDK repo root: $SDK_REPO_ROOT"
log "Reference repo root: $REFERENCE_REPO_ROOT"
log "Storyboards: $ADCP_STORYBOARD_ID"
log "Proxy port: $ADCP_PORT"
log "Internal seller port: $ADCP_INTERNAL_PORT"
log "Result path: $STORYBOARD_RESULT_PATH"
log "Seller log path: $SELLER_LOG_PATH"

if [[ "$(tr -d '\n\r' <"$REFERENCE_REPO_ROOT/ADCP_VERSION")" != 3.0.* ]]; then
  log "Reference checkout is not pinned to an AdCP 3.0.x protocol version"
  cat "$REFERENCE_REPO_ROOT/ADCP_VERSION" >&2 || true
  exit 1
fi

if [[ "${ADCP_SKIP_NPM_CI:-0}" != "1" ]]; then
  log "Installing pinned 3.0 reference seller dependencies with npm ci"
  (
    cd "$REFERENCE_REPO_ROOT"
    npm ci >>"$SELLER_LOG_PATH" 2>&1
  )
fi

if [[ "${ADCP_SKIP_BUILD:-0}" != "1" ]]; then
  log "Building pinned 3.0 reference seller checkout"
  (
    cd "$REFERENCE_REPO_ROOT"
    npm run build:test-agents >>"$SELLER_LOG_PATH" 2>&1
  )
fi

resolve_runner_cmd

SELLER_ENTRY="$REFERENCE_REPO_ROOT/test-agents/dist/seller-agent.js"
if [[ ! -f "$SELLER_ENTRY" ]]; then
  SELLER_ENTRY="$REFERENCE_REPO_ROOT/dist/seller-agent.js"
fi
if [[ ! -f "$SELLER_ENTRY" ]]; then
  log "Could not find built 3.0 seller entrypoint at test-agents/dist/seller-agent.js or dist/seller-agent.js"
  exit 1
fi

log "Starting pinned AdCP 3.0 TypeScript seller"
(
  cd "$REFERENCE_REPO_ROOT"
  NODE_ENV=development \
    ADCP_SANDBOX=1 \
    PORT="$ADCP_INTERNAL_PORT" \
    node "$SELLER_ENTRY"
) >>"$SELLER_LOG_PATH" 2>&1 &
SELLER_PID=$!

if ! wait_for_port 127.0.0.1 "$ADCP_INTERNAL_PORT" 30; then
  log "Timed out waiting for pinned 3.0 seller on port $ADCP_INTERNAL_PORT"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

log "Starting strict AdCP 3.0 envelope proxy"
ADCP_STRICT_PROXY_PORT="$ADCP_PORT" \
  ADCP_STRICT_PROXY_TARGET_PORT="$ADCP_INTERNAL_PORT" \
  ADCP_STRICT_PROXY_AUDIT_PATH="$PROXY_AUDIT_PATH" \
  node "$SDK_REPO_ROOT/scripts/ci/strict_adcp_3_0_proxy.mjs" >>"$SELLER_LOG_PATH" 2>&1 &
PROXY_PID=$!

if ! wait_for_port 127.0.0.1 "$ADCP_PORT" 30; then
  log "Timed out waiting for strict proxy on port $ADCP_PORT"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

assert_strict_proxy_rejects_unknown_arguments

log "Running candidate SDK storyboard runner against strict 3.0 seller"
RUN_STATUS=0
ADCP_AUTH_TOKEN="$ADCP_AUTH_TOKEN" "${RUNNER_CMD[@]}" storyboard run "http://127.0.0.1:$ADCP_PORT/mcp" "$ADCP_STORYBOARD_ID" \
  --json \
  --allow-http \
  --timeout "$ADCP_RUNNER_TIMEOUT_SECONDS" >"$STORYBOARD_RESULT_PATH" 2>>"$SELLER_LOG_PATH" || RUN_STATUS=$?

log "Probing get_products through candidate SDK with major-only envelope"
PROBE_STATUS=0
probe_get_products_with_candidate_sdk >>"$SELLER_LOG_PATH" 2>&1 || PROBE_STATUS=$?

set +e
check_storyboard_result
RESULT_STATUS=$?
check_proxy_audit
AUDIT_STATUS=$?
set -e

if [[ "$RUN_STATUS" != "0" || "$PROBE_STATUS" != "0" || "$RESULT_STATUS" != "0" || "$AUDIT_STATUS" != "0" ]]; then
  log "Storyboard run failed (runner exit=$RUN_STATUS, probe exit=$PROBE_STATUS, status check=$RESULT_STATUS, audit check=$AUDIT_STATUS)"
  tail -200 "$SELLER_LOG_PATH" >&2 || true
  exit 1
fi

log "Strict AdCP 3.0 reference seller storyboard passed"
