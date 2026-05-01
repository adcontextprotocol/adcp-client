---
'@adcp/sdk': minor
---

Add `transport.maxResponseBytes` for hostile-vendor protection. Closes adcontextprotocol/adcp-client#1167.

`@adcp/sdk` builds the underlying MCP / A2A transport's `fetch` internally, so callers had no seam to inject a size-bounded fetch. That's a real DoS surface against any code crawling untrusted agents (registries, federated discovery, monitoring tools): a hostile vendor publishing a 200 MB JSON-RPC reply gets fully buffered before any application-layer schema validation runs. The 10s default timeout doesn't mitigate — 200 MB at datacenter speeds arrives well under the limit.

```ts
const client = new ADCPMultiAgentClient(
  [{ id: 'vendor', agent_uri, protocol: 'mcp' }],
  {
    userAgent: 'AAO-Discovery/1.0',
    transport: { maxResponseBytes: 1_048_576 }, // 1 MB cap on every call
  }
);

// Per-call override beats the constructor default — for agents that
// legitimately publish large catalogs (`list_creative_formats` on a
// generative seller, `list_properties` on a publisher with 50K URLs).
const formats = await client.agent('vendor').listCreativeFormats(
  { /* ... */ },
  undefined,
  { transport: { maxResponseBytes: 16 * 1_048_576 } }
);
```

When the cap is exceeded, the SDK throws `ResponseTooLargeError` (code `RESPONSE_TOO_LARGE`, extends `ADCPError`). The error carries `limit`, `bytesRead`, `url`, and — when the cap was tripped on a `Content-Length` pre-check — `declaredContentLength`. Recovery is `terminal` from the SDK's view: replaying against the same agent will hit the same cap. The buyer's options are to widen the cap per-call when the agent's payload is legitimately large, or to flag the agent as misbehaving.

**Why a typed knob, not a `fetchOverride`.** Callers composing their own size cap with the SDK's existing `wrapFetchWithCapture`, RFC 9421 signing fetch, and OAuth fetch wrappers is a footgun — the wrap order matters and isn't obvious from the public API. `maxResponseBytes` is a single-purpose ergonomic with a clear contract; future hardening (DNS-rebind defense, scheme allow-list) can add similar typed knobs without callers rewriting their fetch.

**How it works.** `wrapFetchWithSizeLimit` is installed as the innermost transport wrapper for both MCP and A2A — closer to the network than capture / signing — so the diagnostic capture wrapper reads a size-limited body and can't blow memory through `Response.clone()`. Pre-cancels when `Content-Length` exceeds the cap; otherwise streams through a counting `TransformStream` that errors at the cap boundary. The active cap is read from `responseSizeLimitStorage` (AsyncLocalStorage), so cached MCP / A2A connections don't need to rebuild — the cap lives on the request, not on the transport.

**Default is no cap.** Buyers in trusted relationships keep their existing payload sizes; only the registry-crawl / federated-discovery use cases need to set this. When set, per-call `transport.maxResponseBytes` (in `TaskOptions`) overrides the constructor's `transport.maxResponseBytes` (in `SingleAgentClientConfig`).

**Surface area.** New exports: `TransportOptions`, `ResponseTooLargeError`. New fields: `SingleAgentClientConfig.transport`, `TaskOptions.transport`, `CallToolOptions.transport`, `transport` argument on `createMCPClient` / `createA2AClient` factories. No breaking changes to existing fields.

**Defense detail (post-review hardening).**

- **Forces `Accept-Encoding: identity` when the cap is active** so a hostile vendor can't ship a 5 KB gzip blob that decompresses to GBs and burn asymmetric CPU before the streaming counter trips. Without this, undici's default `Accept-Encoding: gzip, deflate, br` lets the cap count post-decompression bytes only. Forcing identity moves the bomb to the network where the `Content-Length` pre-check catches it. The header is only set when no caller value is present — signing fetches that need a stable signed-bytes shape can override.
- **Strips the search component from `ResponseTooLargeError.url`.** Some agents publish manifests with auth tokens in the query string (`?api_key=…`); without redaction those land in `err.message`, `err.details.url`, and any downstream log sinks. The error stores the path-only form for diagnostics.
- **`createMCPClient` / `createA2AClient` factory exports honor the same cap.** They accept a `transport` argument and wrap with `withResponseSizeLimit`, matching the contract the public `TransportOptions` type implies. Without this, callers reaching the factory exports would silently bypass the cap.

**Known gaps tracked as follow-ups (not blocking this ship).**

- OAuth client-credentials token endpoint (`exchangeClientCredentials`) uses raw fetch and bypasses the cap. Pre-existing surface, not a regression from this change. Tracked separately.
- The cap applies to MCP's long-lived side-channel `GET` for server-initiated messages; the doc warning ("leave unset for long-lived buyer sessions") is the current mitigation. A finer-grained per-response scope is a follow-up.
- OAuth metadata discovery (`/.well-known/oauth-authorization-server`) doesn't flow through the wrapped fetch — `discoverOAuthMetadata` uses raw fetch. Same DoS surface, separate fix.
