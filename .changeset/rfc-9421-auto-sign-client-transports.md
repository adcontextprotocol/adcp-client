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

New exports from `@adcp/client/signing`:
`CapabilityCache`, `buildCapabilityCacheKey`, `defaultCapabilityCache`,
`buildAgentSigningContext`, `buildAgentSigningFetch`, `ensureCapabilityLoaded`,
`extractAdcpOperation`, `shouldSignOperation`, `resolveCoverContentDigest`.

New field on `AgentConfig`: `request_signing?: AgentRequestSigningConfig`.

`createSigningFetch` now accepts `coverContentDigest` as either `boolean` or
`(url, init) => boolean` so the seller policy can be resolved per request
without rebuilding the wrapper.
