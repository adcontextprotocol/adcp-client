---
'@adcp/client': minor
---

Four new response builders + auto-wrap wiring, closing the "Claude-and-humans miss required response fields" class of failure that matrix runs against fresh-built agents kept surfacing:

- **`acquireRightsResponse(data)`** — typed on the `acquired | pending_approval | rejected` discriminated union. Runtime-validates `approval_webhook.authentication.credentials` length (spec requires ≥32 chars) with an actionable error pointing at `randomUUID().replace(/-/g, "")` as the easy fix.
- **`syncAccountsResponse(data)`** — asserts every `accounts[i].account_id` is present. The `sync_accounts` conformance step fails without platform-assigned IDs, and fresh builders commonly echo request fields without stamping one.
- **`syncGovernanceResponse(data)`** — typed passthrough on the `SyncGovernanceResponse` union.
- **`reportUsageResponse(data, summary?)`** — auto-defaults `accepted: 0`. Shortcut: `reportUsageResponse.fromRequest(request)` acknowledges every `usage[]` entry as accepted in one call — the common "ack all items" case.
- **`buildCreativeResponse`** now validates `creative_manifest.format_id` is the `{ agent_url, id }` object shape (not the bare string or `undefined` the type permits via loose unions). Previously this failed downstream with a cryptic `oneOf` mismatch; the builder now throws at response-construction time with a pointer at the right shape.

All four are auto-applied via `createAdcpServer`'s `TOOL_META` — handlers return domain objects, the framework wraps. Also exported from `@adcp/client` and `@adcp/client/server` for manual use.

First step of the "SDK utilities over hand-rolled skill examples" plan: closes the four matrix-v5 runtime-error signatures (`SERVICE_UNAVAILABLE: Tool acquire_rights/sync_accounts/build_creative/report_usage`) that followed from fresh agents missing required fields the schema now mandates.
