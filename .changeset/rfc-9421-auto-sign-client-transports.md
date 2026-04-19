---
'@adcp/client': minor
---

Auto-apply RFC 9421 request signing to outbound MCP and A2A calls inside
`ProtocolClient` / `AdCPClient`. Follow-up to the signing primitives shipped
previously: the library now wires the signer into `StreamableHTTPClientTransport`
and the A2A `fetchImpl` automatically when an `AgentConfig.request_signing`
block is present.

Behavior:

- On first outbound call for an agent with `request_signing`, the client
  fetches `get_adcp_capabilities` (unsigned — the discovery op is exempt) and
  caches the seller's `request_signing` capability per-agent with a 300s TTL.
- Subsequent calls consult the cache to decide per-operation whether to
  sign — precedence matches the spec: buyer `always_sign` > seller
  `required_for` > seller `warn_for` (shadow-mode telemetry) > seller
  `supported_for` (buyer opted in via `sign_supported`).
- Content-digest coverage honors the seller's `covers_content_digest` policy
  (`required` / `forbidden` / `either`) per-request.
- Transport connection caches disambiguate by a per-key fingerprint (hash of
  `kid` + private scalar) so two tenants that misconfigure the same `kid`
  but hold distinct private keys cannot collide on a shared cached
  transport and sign each other's traffic.
- `get_adcp_capabilities` and MCP/A2A protocol-layer RPCs (`initialize`,
  `tools/list`, A2A card discovery) always pass through unsigned.
- OAuth-gated agents with signing: `callMCPToolWithOAuth` threads the
  signing context through to the transport fetch, so OAuth flows don't
  silently drop signatures.
- Priming failures fail open with a 60s negative cache: a transient seller
  discovery outage doesn't wedge every subsequent call. `always_sign` ops
  still get signed with sensible content-digest defaults; ops the seller
  might have listed in `required_for` reach the wire unsigned and are
  rejected visibly with `request_signature_required`, which retries re-prime.
- Concurrent cold-cache fans-out share one `get_adcp_capabilities` fetch
  via an in-flight pending-map stored on the `CapabilityCache` instance
  itself — so two tenants with separate `CapabilityCache` instances get
  independent in-flight tables, and embedders who construct their own
  cache don't race against the default cache.
- `AgentSigningContext.invalidate()` evicts this context's capability
  entry so callers don't have to rebuild the cache key from the agent's
  identifying fields when they want to force a re-prime.
- Signing-reserved headers (`Signature`, `Signature-Input`, `Content-Digest`)
  supplied by a caller's `customHeaders` are scrubbed before the signer
  runs — a misconfigured header cannot silently break or bypass the RFC
  9421 signature output.
- `extractAdcpOperation` throws on unsupported body shapes (Blob, FormData,
  ReadableStream) rather than silently passing the request unsigned — the
  seller's `required_for` contract is not broken by SDK body-format drift.

New field on `AgentConfig`: `request_signing?: AgentRequestSigningConfig`
(kid, alg, `AdcpPrivateJsonWebKey` with required `d`, agent_url, optional
`always_sign[]` and `sign_supported`).

New sub-barrels:

- `@adcp/client/signing/client` — signer, canonicalization, fetch wrapper,
  capability cache, and the auto-wiring helpers a buyer building an
  AdCPClient needs.
- `@adcp/client/signing/server` — verifier pipeline, Express-shaped
  middleware, JWKS / replay / revocation stores, error taxonomy.

The existing `@adcp/client/signing` barrel continues to export the union of
both sub-barrels, so existing consumers keep working. New code should
import from whichever half matches its role — coding agents reading a file
cold only need to hold one side of the taxonomy.

New exports on `@adcp/client/signing/client`: `CapabilityCache`,
`buildCapabilityCacheKey`, `defaultCapabilityCache`,
`buildAgentSigningContext`, `buildAgentSigningFetch`,
`ensureCapabilityLoaded`, `extractAdcpOperation`, `shouldSignOperation`,
`resolveCoverContentDigest`, `toSignerKey`, `CAPABILITY_OP`,
`CoverContentDigestPredicate`. `AgentSigningContext` gains an
`invalidate()` method. `CachedCapability` gains an optional `staleAt`
deadline for negative-cache entries.

`createSigningFetch` now accepts `coverContentDigest` as either `boolean`
or `(url, init) => boolean` so the seller policy can be resolved per
request without rebuilding the wrapper.
