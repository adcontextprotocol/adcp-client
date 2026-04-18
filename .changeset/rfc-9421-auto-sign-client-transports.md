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
  sign — required by the seller's `required_for`, opted-in via
  `supported_for` + `sign_supported`, or forced by buyer `always_sign`.
- Content-digest coverage honors the seller's `covers_content_digest` policy
  (`required` / `forbidden` / `either`) per-request.
- Transport connection caches disambiguate by signer `kid`, so an agent
  rotating keys mid-session gets a fresh connection rather than replaying the
  old wrapper.
- `get_adcp_capabilities` and MCP/A2A protocol-layer RPCs (`initialize`,
  `tools/list`, A2A card discovery) always pass through unsigned.

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
`CoverContentDigestPredicate`.

`createSigningFetch` now accepts `coverContentDigest` as either `boolean`
or `(url, init) => boolean` so the seller policy can be resolved per
request without rebuilding the wrapper.
