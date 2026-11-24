---
'@adcp/sdk': patch
---

Keep the SDK error class on `result.errorInstance` for creative-bearing tasks (`create_media_buy`, `update_media_buy`, `sync_creatives`, `get_products`, `list_creatives`, `get_media_buys`, `get_media_buy_delivery`, `get_creative_delivery`). The canonical creative boundary rebuilt every typed error on `Error.prototype`, so a signed `create_media_buy` refused with HTTP 401 returned a plain `Error` that failed `instanceof AuthenticationRequiredError`, and `IdempotencyConflictError`, `IdempotencyExpiredError`, the `Account*Error` classes, `ActionNotAllowedError` and `NeedsAuthorizationError` lost their class the same way. SDK error classes now keep their prototype, with their sanitized own data fields (non-enumerable ones stay non-enumerable) and, when the stack formats to a string, a stack sanitized like `message`. Errors whose class is not an SDK class, including adopter subclasses of SDK classes, are still rebuilt on `Error.prototype`.
