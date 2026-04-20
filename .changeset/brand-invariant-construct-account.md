---
'@adcp/client': patch
---

Fix `applyBrandInvariant` scoping for tools whose schema declares `account` but not top-level `brand` (e.g. `get_media_buys`, `get_media_buy_delivery`, `list_creatives`). The helper was only injecting top-level `brand` and merging into an existing `account`; when the request-builder produced no `account`, `adaptRequestForServerVersion` would strip the unrecognized top-level `brand` and the run-scoped brand was lost on the wire. Now the helper constructs an `account` (via `resolveAccount(options)`) when the request omits one, so session scoping survives for every schema shape. Non-object `account` values (`null`, arrays) are still passed through unchanged. (adcp-client#643)
