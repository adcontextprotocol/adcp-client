# Agent resolution and publisher pins

The SDK follows the shared AdCP 3.3 agent-resolution algorithm for request,
webhook and governance signatures. The protocol alignment changes key discovery
and verification; it does not change the SDK's configured wire protocol version.

## Expected agent URLs

Prefer passing the agent URL already recorded by your integration:

```ts
const jwks = new ResolvedAgentJwksResolver(expectedSellerUrl, 'mcp', {
  legacyWebhookFallback: true, // Webhooks from older 3.x sellers only.
});
```

`BrandJsonJwksResolver(operatorUrl, { agentUrl, agentType, agentId })` remains
available for onboarding mappings. It confirms `operatorUrl` against the agent's
capabilities on cache refresh. `agentUrl` is optional for existing callers.
When omitted, the resolver infers one canonical URL from its trusted onboarding
record using the existing type/id/brand selectors, then confirms that URL's
capabilities-selected operator record before accepting any key. Ambiguous
onboarding fails closed; the inferred identity stays pinned for that resolver.
Moving to a different agent URL requires a new resolver instance. Explicit
`agentUrl` configurations must use the exact capabilities-published operator
URL; legacy onboarding may resolve document indirection before confirming it.
Existing `jwksOptions` types remain accepted; cache age and cooldown settings
apply within protocol bounds, and verification always fails closed on expiry.
`agentType` and `agentId` only narrow the final canonical URL match. Deprecated
`brandId` and `maxRedirects` apply only to legacy onboarding, and do not restrict
the final operator collections or capability discovery.
Explicit capability URLs allow no HTTP or document-indirection redirects. The
webhook-only fallback allows the bounded host/www HTTP policy and one document
indirection. Request verification rejects keys discovered through that fallback.
`SingleAgentClient` and `BrandJsonJwksResolver` enable the fallback by default for webhooks;
set `webhookVerification.resolverOptions.legacyWebhookFallback` to `false` to
disable it. Set `legacyWebhookFallback: false` on a standalone brand resolver to disable it.
`ResolvedAgentJwksResolver` requires explicitly enabling the fallback for webhook use.
Wrappers shared with request verification must forward `resolveWithMetadata`
so the verifier can refuse webhook-only fallback keys.

Capabilities discovery defaults to MCP. A2A integrations using
`BrandJsonJwksResolver` must set `protocol: 'a2a'`; the onboarding record does
not determine the transport. Existing cross-domain onboarding records must
agree with the agent's capabilities-selected operator record. A legacy
webhook without `brand_json_url` must use the agent-origin well-known record.

Expired operator mappings fail closed. Successful operator records have a
30-second minimum polling interval, including `no-cache` records, with their
effective cache lifetime bounded above by the JWKS revocation polling interval
and the configured local cap. Capabilities are re-confirmed on every refresh.
A local cap shorter than the discovery cooldown can temporarily reject
verification rather than reuse an expired mapping. Negative discovery results
are throttled for at most 60 seconds.
`maxAgeSeconds` must be positive; zero cannot provide a usable verified mapping
with the protocol discovery cooldown. Public `forceRefresh()` is an
operator-triggered cache flush and bypasses normal resolved-key cooldowns;
failed onboarding attempts retain their 30-second cooldown.

Canonical identity normalization preserves path slashes, query order, trailing
empty queries and scheme distinctions. Update principal indexes that previously
used non-canonical spellings. Duplicate canonical matches within one collection
are ambiguous. Shared portfolio declarations count once only when their type
and JWKS source agree.

## Publisher pin context

Pass `publisherPins` to `verifyWebhookSignature` or `createWebhookVerifier`.
With the high-level client, configure `webhookVerification.publisherPins` to
look up those pins from the persisted registration and your own media-buy record.
Include every publisher whose inventory the delivery concerns. Never use payload
fields to choose publishers.

Each pin holds `publisher`, `signingKeys` and an async `refresh` callback that
bypasses the publisher's adagents.json cache. Reuse the refresh callback across
deliveries and bind it to the agent, publisher and tenant context it reads.
The SDK coalesces concurrent refreshes and reuses their confirmed result (or
failure) for 30 seconds, so a captured rejected delivery cannot repeatedly force
uncached publisher fetches. Missing `signingKeys` means no pin;
an empty array accepts no key. `refresh` must throw on failure; `null` means a
successful fetch confirmed removal of the pin. A pinned key must also appear in
the agent JWKS and match by RFC 7638 thumbprint. `kid`-only entries match nothing;
revoked entries cannot authorize delivery. `key_origins` remains enforced.

## Governance

Supply `buyerIdentity` for each authenticated request to governance verification
or enforcement middleware:

```ts
await enforceGovernance({
  ...governedRequest,
  buyerIdentity: {
    brandJson: request.verifiedSigner.operatorRecord.document,
    brandDomain: governedRequest.payload.brand.domain,
  },
}, performGovernedAction);
```

For signed buyers, use the exact `operatorRecord.document` exposed by request
verification, the authenticator or Express middleware. Do not refetch a different
brand.json at its host. Other authenticated buyer identity paths may supply their
own trusted current record. Select the governed brand's collection, with house
fallback only when it has no agents override; never use a sibling brand's agents.
The inline brand URL hostname must equal the governed brand domain; `www` and
the bare domain are distinct here.

The legacy `jwks` plus `expectedIssuer` integration remains available for trusted
onboarding resolvers. With `buyerIdentity`, the SDK selects and caches the matched
entry's JWKS instead; no extra `jwks` argument is needed. Reuse a configured
`jwksOptions` object across requests to share its bounded resolver cache.
Governance replay and
revocation lookups use canonical issuer URLs. Migrate external indexes and replay
store keys when they contain non-canonical issuer spellings.

Origin binding reads `authorized_operators` only from a House Portfolio and
matches the exact agent eTLD+1. Brands and countries apply to account authorization,
separately from key discovery. Existing explicit `requiredOperatorBrand`,
`requiredOperatorScope` and `requiredOperatorCountry` receiver policies still
check the delegation tuple and its validity bounds, including at cache acceptance.
