---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-rc.6 schema and compliance bundles as the default wire release.

The generated surface adds the `sales-exchange`, `sales-retail-media`, and
`sales-streaming-tv` specialisms; retry-safe asynchronous `get_creative_features` contracts;
request-signing error codes; seller-policy decline reasons; and the terminal
`COMMITTED_RESOURCE_PURGED` idempotency outcome. Compact buy and proposal-acceptance
requests can also carry the new optional media-buy `name`.

As with earlier 3.2 prereleases, rc.6 replaces rc.4 in
`COMPATIBLE_ADCP_VERSIONS`; communicating peers should upgrade together or use the
`3.2-rc.6` release-precision alias carried by this SDK build.
