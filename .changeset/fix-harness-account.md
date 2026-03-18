---
"@adcp/client": patch
---

Fix test harness `create_media_buy` scenarios failing with `account: Invalid input`

The `buildCreateMediaBuyRequest` helper was not including the required `account` field,
causing client-side Zod validation to reject the request before it reached the agent.

- Add `account: resolveAccount(options)` to `buildCreateMediaBuyRequest`
- Add backwards-compatible `account` inference in `normalizeRequestParams` so callers
  that pre-date the required `account` field keep working (derived from `brand`)
