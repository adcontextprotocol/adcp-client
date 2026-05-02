---
'@adcp/sdk': minor
---

feat(upstream-recorder): producer-side reference middleware for `query_upstream_traffic` adopters (closes adcp-client#1290)

New public sub-export `@adcp/sdk/upstream-recorder` — a small, sandbox-only-by-default helper adopters drop into their HTTP layer to populate the `comply_test_controller`'s `query_upstream_traffic` buffer that the runner-output-contract v2.0.0 `upstream_traffic` storyboard check (PR #1289, spec adcontextprotocol/adcp#3816) reads from.

The runner-side consumer landed in #1289. This is the producer-side companion: turns "instrument my outbound HTTP layer with a session/principal-scoped ring buffer + redaction + sandbox gating + multi-tenant isolation" — a 1-2 sprint engineering ask for a DSP/SSP-scale codebase — into "wire `recorder.wrapFetch(globalThis.fetch)` and pass the query result through your controller handler."

```ts
import { createUpstreamRecorder } from '@adcp/sdk/upstream-recorder';

const recorder = createUpstreamRecorder({
  enabled: process.env.NODE_ENV !== 'production',
});

// Wrap your HTTP layer
const fetch = recorder.wrapFetch(globalThis.fetch);

// Scope every outbound call inside a request handler to the resolving principal
await recorder.runWithPrincipal(account.id, async () => {
  await syncAudienceUpstream(/* ... */);
});

// In your `comply_test_controller` `query_upstream_traffic` handler:
const { items, total, truncated, since_timestamp } = recorder.query({
  principal: account.id,
  sinceTimestamp: req.params.since_timestamp,
  endpointPattern: req.params.endpoint_pattern,
  limit: req.params.limit,
});
return { success: true, recorded_calls: items, total_count: total, truncated, since_timestamp };
```

**Key behaviors** (all from the spec PR's three-expert review plus this PR's own multi-expert pass):

- **Per-principal isolation** (security HIGH from spec review). `query({ principal })` returns only calls bound to the same principal — multi-tenant sandboxes can't leak traffic across tenants. Adopters thread principal via `runWithPrincipal(p, fn)` (an AsyncLocalStorage scope that propagates across `await` boundaries) or pass it explicitly to `record()`. Empty / non-string principal at record-time or query-time throws `UpstreamRecorderScopeError` rather than silently matching nothing.
- **Record-time redaction**. The canonical secret-key pattern from `runner-output-contract.yaml`'s `payload_redaction` is applied at recording time, not query time. JSON bodies walk through `redactSecrets`; **form-urlencoded bodies are parsed + key-redacted + re-stringified** so `access_token=xxx` is caught without the adopter pre-redacting; binary bodies (Buffer / Blob / ArrayBuffer / TypedArray) are replaced with a `[binary <n> bytes]` marker so the buffer never holds raw bytes.
- **Sandbox-only gating**. `enabled: false` returns a no-op recorder — zero per-call overhead. When `enabled: true` and `NODE_ENV=production`, the factory emits a one-time `console.warn` so accidental ship is loud (suppress with `ADCP_RECORDER_PRODUCTION_ACK=1`).
- **`strict: true` debug mode**. Calls outside `runWithPrincipal` scope throw `UpstreamRecorderScopeError` instead of silently dropping. Adopters set this in integration tests so forgotten scope wrappers surface as a stack trace pointing at the unwrapped call site, not as mysterious "controller present, observed nothing" storyboard failures (a HIGH adopter-facing footgun the DX review flagged).
- **`recorder.debug()` introspection**. Returns `{enabled, bufferSize, bufferedEntries, principals, lastRecordedAt, activePrincipal, strict}` — log it from inside a handler to pinpoint missing scope wrappers or record-time / query-time principal mismatches.
- **`onError` observability hook**. Surfaces classifier-throws, URL-parse-failures, payload-build failures, and unscoped-record events. Adopters wire to their logger; previously-invisible classifier bugs become debuggable.
- **Buffer + TTL eviction**. Default `bufferSize: 1000`, `ttlMs: 1h`. Out-of-range option values (zero / negative / above ceiling / NaN) revert to defaults rather than silently saturating — a typo'd `bufferSize: -10` saturating to `1` would drop nearly everything.
- **Per-entry payload byte cap**. Default `maxPayloadBytes: 65_536` (mirrors the spec's `recorded_calls[].payload.maxLength`). JSON payloads exceeding the cap replaced with `[truncated <n> bytes]`. Bounds memory ceiling under accidental hot-loop recording.
- **`endpointPattern` glob filter** with ReDoS guard. `*` → `.*` (greedy, `/`-crossing); all other regex metas escape literally. Pathological `**********` patterns coalesce to a single `*` to defeat catastrophic backtracking. Implementation lives in `src/lib/utils/glob.ts` — shared with the runner's `validations.ts` so producer + consumer can't drift.
- **`purpose` classifier hook**. Optional callback invoked at record time with redacted-headers view. Returning a string stamps `RecordedCall.purpose` — forward-compat for adcp#3830 item 3.
- **Manual `record()` escape hatch** for adopters on axios / got / native `node:http`. Auto-fills timestamp, host/path, content_type, applies redaction, runs the classifier — same wire shape as `wrapFetch`. SKILL.md documents the axios + got integration patterns.

**`toQueryUpstreamTrafficResponse(queryResult)` helper**: also exported. Projects `recorder.query()`'s adopter-ergonomic shape (`{ items, total, ... }`) onto the spec wire shape (`{ recorded_calls, total_count, ... }`) so adopters return it verbatim from their `comply_test_controller` handler instead of reinventing the field renames.

**`registerTestController` extended**: `TestControllerStore.queryUpstreamTraffic?` is a new optional method. When present, the SDK auto-advertises `query_upstream_traffic` via `list_scenarios` (open-extension scenario, accepted by the dispatcher under the `TOOL_INPUT_SHAPE.scenario: z.string()` open contract). The capability block (`compliance_testing.scenarios` on `get_adcp_capabilities`) keeps the canonical typed enum — extension scenarios live in `list_scenarios` only, since the cached 3.0.4 schema's enum predates spec PR #3816 and would reject the unknown value at validation time. Once a 3.0.5+ release ships the schema, `query_upstream_traffic` gets promoted to a first-class `CONTROLLER_SCENARIOS` constant.

**End-to-end integration**: the SDK's `examples/hello_seller_adapter_signal_marketplace.ts` reference adapter wires the recorder against the published `signal-marketplace` mock. CI gates the example via `test/examples/hello-seller-adapter-signal-marketplace.test.js` — type-checks under strictest tsc (`--strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature`), runs the storyboard with zero failed steps, asserts every expected upstream route hit on the mock's `/_debug/traffic` (the existing façade gate). Adopters fork this example as the copy-pasteable starting point.

**Two anti-façade traffic surfaces — documented explicitly in the SKILL**: adopter-side `query_upstream_traffic` (this PR; full payloads, per-principal, JSONPath assertions) is complementary to mock-side `/_debug/traffic` (pre-existing; per-route hit counts on the mock platform itself). Mocks shouldn't wire the recorder internally — they ARE the upstream. The SKILL's new "Two traffic surfaces" diagram pins this so adopters don't conflate them.

**Refactor under the hood**: `redactSecrets` and `SECRET_KEY_PATTERN` lifted from the runner into a shared `src/lib/utils/redact-secrets.ts` so the new recorder reuses the same redaction floor as the runner consumes — adopter-emitted recorded payloads land in the runner's compliance report unchanged. `globToRegExp` similarly lifted to `src/lib/utils/glob.ts` so producer-side `endpointPattern` filtering and runner-side `endpoint_pattern` matching share one implementation and can't drift. No behavior change for the runner; `__redactSecretsForTest` still works.

**53 tests across four files** pin the integration end-to-end:

- `test/lib/upstream-recorder.test.js` (41 unit) — enabled-false short-circuit, cross-principal isolation (the security HIGH), record-time JSON + header + form-urlencoded redaction with custom-pattern extension, buffer FIFO eviction, TTL eviction, endpointPattern + sinceTimestamp + limit/truncated query filters, wrapFetch end-to-end (incl. status_code capture and recording on fetch error), purpose classifier including the catches-throws-MUST-NOT-crash invariant, clear() cleanup helper, query() principal validation (empty / non-string throws), runWithPrincipal validation, strict-mode throws on unscoped record / fetch, onError observability for all swallow sites, debug() introspection, Buffer / TypedArray binary handling, payload byte cap (truncation + disable), bufferSize clamping (zero / Infinity / negative reverts to default), and the ReDoS guard against pathological `**********` patterns.
- `test/lib/upstream-recorder-spec-shape.test.js` (5 Ajv) — validates a representative `RecordedCall` against the inline `UpstreamTrafficSuccess.recorded_calls` subschema from spec PR adcp#3816 (TODO: switch to cached schema when 3.0.5 ships). Pins `toQueryUpstreamTrafficResponse` projection — `items → recorded_calls` / `total → total_count` field renames are the load-bearing claim and asserted explicitly.
- `test/lib/upstream-recorder-e2e.test.js` (4 round-trip) — drives `runStoryboardStep` against a one-step `upstream_traffic` fixture storyboard with a stub MCP client whose `comply_test_controller` handler routes through the real recorder via `toQueryUpstreamTrafficResponse`. Cases: happy path, façade (zero calls), principal mismatch (cross-tenant isolation), `identifier_paths` missing vector. Test-fixture storyboard at `test/fixtures/storyboards/upstream-traffic-fixture.yaml`.
- `test/examples/hello-seller-adapter-signal-marketplace.test.js` (3 example-adapter integration, pre-existing — now exercises the recorder) — strictest-tsc + storyboard zero-failed + façade gate against the `signal-marketplace` mock-server.

**Sequencing note** — adcp#3830 item 4 in the deferred-extensions tracking issue, sequencing dependency from issue #1290: "land #1253 first (runner + forward-compat default) so storyboards can declare `upstream_traffic` validations and have them grade not_applicable on adopters who haven't yet implemented." That's now landed (PR #1289 merged at `c446936c`). This middleware unblocks the long tail of adopters who want to opt in but don't want to write the recorder from scratch.

Sibling Python issue: `adcp.testing.upstream_recorder` mirrors this for the Python SDK — to be filed as a paired issue in `adcontextprotocol/adcp-client-python`.
