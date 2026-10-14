---
'@adcp/sdk': minor
---

Cap agent response bodies by default. `transport.maxResponseBytes` now defaults to **4 MiB** (`DEFAULT_MAX_RESPONSE_BYTES`) on every MCP and A2A call path — tool calls, endpoint discovery, `tools/list`, A2A agent-card lookup, and OAuth token exchange. Bytes are counted as they stream in, a declared `Content-Length` over the cap is refused before the body is read, and an oversized response fails with the existing typed `ResponseTooLargeError`. Nothing is ever truncated.

`text/event-stream` responses are no longer exempt. The old bypass let any peer opt itself out of the cap by changing one response header. SSE now carries two bounds: no single event frame may exceed `maxResponseBytes` (the memory bound — an SSE consumer buffers one frame at a time), and the cumulative event-stream octets read during one call may not exceed `maxResponseBytes * SSE_CUMULATIVE_BUDGET_MULTIPLIER` (2, so 8 MiB by default — the liveness bound that stops an endless drip of individually legal frames). A long-lived `GET` event-stream — MCP's standalone notification listener, the legacy SSE transport — outlives the call that opened it, so it meters its cumulative allowance per connection rather than per call.

**This is a behavior change if you call an agent that legitimately returns more than 4 MiB** (very large `get_products` or `list_creative_formats` catalogs). Raise the cap per client or per call:

```ts
// Per client
const client = new SingleAgentClient(agent, { transport: { maxResponseBytes: 32 * 1024 * 1024 } });

// Per call
await client.getProducts(params, { transport: { maxResponseBytes: 32 * 1024 * 1024 } });

// Opt out entirely (explicit, never the default)
await client.getProducts(params, { transport: { maxResponseBytes: 0 } });
```

Only `0` opts out. `Infinity` and negative values fall back to the default rather than disabling the cap, because they almost always arrive from a misparsed env var or a budget subtraction rather than an intention.

The byte counter runs downstream of the runtime's content-decoder, so it measures **decompressed** octets: a small gzip blob that inflates to gigabytes still trips the cap after `maxResponseBytes` of output. The `Content-Length` pre-check sees the compressed length and is therefore a fast path, not the guarantee. The SDK does not force `Accept-Encoding: identity` — a hostile peer would ignore it, and forcing it would cost every honest adopter their response compression.

On a streaming transport the cap errors the response body, and some transports classify that as a stream disconnect and retry rather than propagating it. The SDK records the violation for the call and re-raises `ResponseTooLargeError` (with the transport's own error as `cause`) in place of the timeout the caller would otherwise see.

`DEFAULT_MAX_RESPONSE_BYTES` and `SSE_CUMULATIVE_BUDGET_MULTIPLIER` are exported from `@adcp/sdk`.

Closes #3253. Cross-SDK default and spec wording: adcontextprotocol/adcp#8190.
