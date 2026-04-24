---
'@adcp/client': patch
---

Align `replayed` envelope emission with `protocol-envelope.json`: the SDK now **omits `replayed` on fresh execution** and stamps `replayed: true` on replays only. The envelope spec explicitly permits the field to be "omitted when the request was executed fresh," and the replay stamp now mirrors into both the L3 `structuredContent` and the L2 `content[0].text` JSON body so A2A/REST transports see the same marker MCP does.

### What you'll see

- **Seller handlers (using `createAdcpServer`)**: fresh mutating responses (`create_media_buy`, `sync_creatives`, `sync_governance`, etc.) no longer carry `replayed: false` in the envelope. Snapshot or contract tests asserting `replayed === false` on fresh will need to be updated to `replayed !== true` (or `replayed === undefined`). Replay responses still carry `replayed: true`.
- **Buyer-side readers (using the `@adcp/client` SDK)**: no change. `ProtocolResponseParser.getReplayed` already treats absence and `false` identically, and the envelope schema's `"default": false` means schema-aware parsers materialize the same value either way.
- **Public `wrapEnvelope` helper**: unchanged. Sellers calling `wrapEnvelope({replayed: false})` directly still round-trip the explicit marker — this release only changes the framework's internal idempotency path.

### Upstream tracking

The compliance storyboard `compliance/cache/latest/universal/idempotency.yaml` asserts `field_value allowed_values: [false]` on `replayed` at the fresh-path step, which conflicts with the envelope spec. The storyboard's own `description` field at that step reads "Initial execution sets replayed: false (or omits the field)" — a self-inconsistent assertion. Filed upstream as [`adcp-client#857`](https://github.com/adcontextprotocol/adcp-client/issues/857) with a fix proposal (`any_of: [field_absent, field_value: false]`). Until that lands, the `replay_same_payload` phase of the idempotency storyboard will fail on the fresh-path step for any seller on this SDK version — this is the storyboard's literal-match bug, not SDK drift. Other phases (`key_reuse_conflict`, `fresh_key_new_resource`, webhook dedup) still pass.

### Internal

- `create-adcp-server.ts`: `injectReplayed(response, value)` renamed to `stampReplayed(response)` (always stamps `true`); fresh-path call site dropped. Replay-path stamp now updates both L2 text and L3 structuredContent to match the `injectContextIntoResponse` / `sanitizeAdcpErrorEnvelope` lockstep pattern.
- `wrap-envelope.ts`, `envelope-allowlist.ts`, `validation/schema-loader.ts`: documentation only.
- `test/server-idempotency.test.js`: fresh-path assertion relaxed from `=== false` to `!== true`.
