---
'@adcp/client': minor
---

feat(server): bearer-or-signature composition (#655) + capability overrides (#654)

Two additions for downstream agents that claim the `signed-requests` specialism
and/or need to surface per-domain capability fields the framework doesn't
auto-derive.

**`verifySignatureAsAuthenticator` (#655).** New adapter that turns
`verifyRequestSignature` into an `Authenticator` composable with
`anyOf(verifyApiKey(...), verifySignatureAsAuthenticator(...))`. Lets a single
endpoint accept either bearer credentials OR a valid RFC 9421 signature —
previously, mounting the Express-shaped verifier downstream of a bearer gate
caused signed-but-unauthed requests to fail 401 before the verifier ran.

```ts
import { serve, verifyApiKey, anyOf, verifySignatureAsAuthenticator } from '@adcp/client/server';

serve(createAgent, {
  authenticate: anyOf(
    verifyApiKey({ keys: { 'sk_live_abc': { principal: 'acct_42' } } }),
    verifySignatureAsAuthenticator({
      jwks, replayStore, revocationStore,
      capability: { supported: true, required_for: [], covers_content_digest: 'either' },
      resolveOperation: req => {
        try {
          const body = JSON.parse(req.rawBody ?? '');
          if (body.method === 'tools/call') return body.params?.name;
        } catch {}
        return undefined;
      },
    }),
  ),
});
```

`serve()` now buffers `req.rawBody` before authentication when any wired
authenticator carries the `AUTH_NEEDS_RAW_BODY` tag (the signature adapter
sets it; `anyOf` propagates it). Bearer-only and JWT-only configurations are
unaffected — buffering stays deferred until preTransport runs.

**`capabilities.overrides` (#654).** New per-domain merge field on
`AdcpCapabilitiesConfig`. Deep-merges on top of the framework's auto-derived
`get_adcp_capabilities` response so agents can surface fields like
`media_buy.execution.targeting.*`, `media_buy.audience_targeting`,
`media_buy.content_standards.supported_channels`, or
`compliance_testing.scenarios` without reaching for `getSdkServer()` to
replace the tool.

```ts
createAdcpServer({
  name: 'My Seller',
  version: '1.0.0',
  mediaBuy: { /* handlers */ },
  capabilities: {
    features: { audienceTargeting: true },
    overrides: {
      media_buy: {
        execution: { targeting: { geo_countries: true, language: true } },
        audience_targeting: {
          supported_identifier_types: ['hashed_email'],
          minimum_audience_size: 500,
        },
      },
      compliance_testing: { scenarios: ['force_media_buy_status'] },
    },
  },
});
```

Nested objects merge; arrays and primitives replace; `null` on a top-level
override removes the auto-derived block. Top-level fields the framework owns
(`adcp`, `supported_protocols`, `specialisms`, `extensions_supported`) stay
managed by their dedicated config fields.

New exports from `@adcp/client/server`:
`verifySignatureAsAuthenticator`, `VerifySignatureAsAuthenticatorOptions`,
`AUTH_NEEDS_RAW_BODY`, `tagAuthenticatorNeedsRawBody`,
`authenticatorNeedsRawBody`, `AdcpCapabilitiesOverrides`.
