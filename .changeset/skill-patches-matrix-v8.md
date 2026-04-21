---
'@adcp/client': patch
---

Skill fixes uncovered by matrix v8's handler-throw disclosure (PR #735):

- **brand-rights skill** (`acquire_rights` + `sync_accounts` + `sync_governance`): swap `|` → `:` in the composite account-key template literal. `ctx.store.put`'s key pattern is `[A-Za-z0-9_.\-:]` — `|` is rejected and the handler throws on the first sync. Also guard `acquireRights` against missing `account.brand.domain` / `account.operator` before composing the key.
- **creative skill** (`list_creatives` + `build_creative`): destructure `ctx.store.list` — it returns `{ items, nextCursor? }`, not a bare array. Previously the examples called `.filter`/`.find` on the envelope object and blew up with `TypeError`, surfaced as `SERVICE_UNAVAILABLE`. Also flip `throw adcpError(...)` to `return adcpError(...)` in `build_creative`; throwing bypasses the envelope path and reports as `SERVICE_UNAVAILABLE` instead of `CREATIVE_NOT_FOUND`.
- **governance skill** (`property-lists`): add a `list_property_lists` example showing `const { items } = await ctx.store.list('property_list')`. Matrix v8 builds repeatedly `.map`-ed the raw result; the skill now shows the correct shape in-line.

No SDK code changes — these are skill-corpus fixes visible to agent builders.
