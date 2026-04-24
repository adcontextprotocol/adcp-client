---
'@adcp/client': patch
---

Two independent envelope-layer fixes for mutating responses:

### 1. Omit `replayed` on fresh execution (align with `protocol-envelope.json`)

The SDK used to stamp `replayed: false` on every fresh-path mutating response. The envelope spec explicitly permits the field to be "omitted when the request was executed fresh" — absence now signals fresh execution, presence signals replay. Replay responses still carry `replayed: true`.

### 2. Mirror the replay marker into L2 `content[0].text` (A2A/REST parity)

The replay-path stamp previously only touched MCP `structuredContent` (L3). A2A and REST transports that consume `content[0].text` (L2) never saw `replayed: true` on replay — replay detection was silently broken on those transports. `stampReplayed` now updates both layers, matching the lockstep pattern used by `injectContextIntoResponse` and `sanitizeAdcpErrorEnvelope`. This is orthogonal to the envelope-semantics change and a bona fide bug fix.

### What you'll see

- **Seller handlers (`createAdcpServer`)**: fresh mutating responses no longer carry `replayed: false`. Snapshot / contract tests asserting `replayed === false` on fresh need to be updated to `replayed !== true` (or `replayed === undefined`).
- **A2A / REST buyers**: replay responses now carry `replayed: true` on the text body where they previously didn't. Replay detection on non-MCP transports starts working.
- **Observability / log pipelines**: dashboards that count fresh executions via `replayed === false` go silent on this version. Switch to `replayed !== true` (fresh = absent or false) or key off a different signal (e.g. tool handler invocation count).
- **Buyer-side readers (`@adcp/client` SDK)**: no change. `ProtocolResponseParser.getReplayed` already treats absence and `false` identically, and the envelope schema's `"default": false` means schema-aware parsers materialize the same value either way.
- **Public `wrapEnvelope` helper**: unchanged. Sellers calling `wrapEnvelope({replayed: false})` directly still round-trip the explicit marker. The asymmetry between the framework path (omits on fresh) and wrapEnvelope callers (honors explicit `false`) is intentional and documented on the option.

### Upstream coordination

Filed [`adcp-client#857`](https://github.com/adcontextprotocol/adcp-client/issues/857) against the `compliance/cache/latest/universal/idempotency.yaml` storyboard: its `field_value allowed_values: [false]` assertion on the fresh-path step conflicts with its own prose (`"Initial execution sets replayed: false (or omits the field)"`) — a literal-match bug where `any_of: [field_absent, field_value: false]` was intended. Until the storyboard fix lands, the `replay_same_payload` phase will fail on the fresh-path step for sellers on this SDK version; all other phases (`key_reuse_conflict`, `fresh_key_new_resource`, webhook dedup) still pass. Per `CLAUDE.md`'s storyboard-failure triage rule, the storyboard is the bug here — the envelope spec unambiguously permits omission.

### Internal

- `create-adcp-server.ts`: `injectReplayed(response, value)` renamed to `stampReplayed(response)`; fresh-path call site dropped; replay-path stamp mirrors into both L2 text and L3 structuredContent.
- `wrap-envelope.ts`, `envelope-allowlist.ts`, `validation/schema-loader.ts`: documentation only. `wrap-envelope.ts` picks up a note that the framework/helper asymmetry on fresh `replayed` is intentional.
- `test/server-idempotency.test.js`: fresh-path assertion relaxed from `=== false` to `!== true`.
