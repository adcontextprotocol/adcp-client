---
"@adcp/sdk": patch
---

`AccountStore.reportUsage` and `AccountStore.getAccountFinancials` now receive `ctx.agent` (the registry-resolved `BuyerAgent`) in addition to `authInfo` and `toolName` — matching the threading already wired for `resolve`, `upsert`, and `list`. Closes the symmetric gap noted in PR #1315 review.

All four `AccountStore` handlers now route through a single internal `toResolveCtx` helper so future additions to `ResolveContext` land on every method automatically. Adopters implementing principal-keyed gates (e.g. `BILLING_NOT_PERMITTED_FOR_AGENT` from adcontextprotocol/adcp#3851, or per-agent financial-read authorization) get the resolved buyer-agent identity on every account-store surface, not just three of five.

No behavior change for adopters that didn't already read `ctx.agent` — the field was simply missing on `reportUsage` / `getAccountFinancials` before.
