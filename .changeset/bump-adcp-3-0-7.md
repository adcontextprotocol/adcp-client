---
'@adcp/sdk': patch
---

Bump `ADCP_VERSION` to 3.0.7. Pulls in the upstream storyboard fix for `media_buy_seller/measurement_terms_rejected` (adcontextprotocol/adcp#4218) — both `create_media_buy` steps now use `$generate:uuid_v4#…` aliases instead of hardcoded literals, so each test run mints fresh idempotency keys and the spec-mandated `IDEMPOTENCY_CONFLICT` arm no longer fires against long-running seller deployments. Closes adcp-client#1586.

Also includes a docs-only refinement to the `list_creatives` filtering type column (`accounts: AccountRef[]`, `format_ids: FormatID[]`, `statuses: CreativeStatus`) — no schema or wire-format change.

`COMPATIBLE_ADCP_VERSIONS` extended with `'3.0.7'` for editor autocomplete on the `adcpVersion` constructor option. Generated types regenerated; functional schema content is identical to 3.0.6 (this release was docs + storyboard fix only).
