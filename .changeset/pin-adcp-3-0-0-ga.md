---
'@adcp/client': minor
---

Pin to AdCP 3.0.0 GA.

`ADCP_VERSION` flips from the rolling `latest` alias to the published
`3.0.0` release. Generated types, Zod schemas, compliance storyboards,
and `schemas-data/` are now locked to the 3.0.0 registry instead of
tracking whatever the registry serves next. `COMPATIBLE_ADCP_VERSIONS`
adds `'3.0.0'` alongside the existing `v3` alias and the beta.1 /
beta.3 wire-compat entries so mixed-version traffic keeps working.

Supply-chain: the 3.0.0 tarball is cosign-verified against
`adcontextprotocol/adcp`'s release workflow OIDC identity, which is a
stricter trust boundary than the checksum-only `latest` alias used
before.

Side effects of the pin:

- `validate_property_delivery` response now uses its generated
  `ValidatePropertyDeliveryResponseSchema` (upstream shipped the
  registry entry in 3.0.0 GA). The schema requires `list_id`,
  `summary`, `results`, and `validated_at`; `compliant` is optional.
  The previous hand-written stub accepted a bare `{compliant}` OR a
  bare `{errors}` fallback; **the `{errors}` branch is gone** — error
  responses now flow through the protocol's async error channel
  rather than the response body. Callers reading `compliant` still
  work; callers that consumed `.errors` from the response must switch
  to the standard `TaskResult.adcpError` path.
- `compliance/cache/3.0.0/` is populated (cosign-verified) and
  replaces `compliance/cache/latest/` as the storyboard source.
