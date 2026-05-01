---
"@adcp/sdk": patch
---

Fix `createAdcpServerFromPlatform` v6 regression: always emit `supported_billing: []` when the account block is projected (adcp-client#1186).

When `requireOperatorAuth` is `true` (or derived from `accounts.resolution: 'explicit'`) but `supportedBillings` is not set, the v6 path omitted `supported_billing` entirely from the wire `get_adcp_capabilities` response. The AdCP schema requires the field whenever the `account` block is present, so schema validation failed with `missing required property 'supported_billing'` — and the storyboard runner cascade-failed every subsequent step. The v5 `createAdcpServer` path correctly defaulted to `[]`; this fix restores parity. Also corrects the `DecisioningCapabilities.supportedBillings` JSDoc which incorrectly claimed the default was `['agent']`.
