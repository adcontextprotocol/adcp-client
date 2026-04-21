---
'@adcp/client': minor
---

`createAdcpServer`'s dispatcher now auto-unwraps `throw adcpError(...)` into the normal response path. Handlers that `throw` an envelope (instead of `return`-ing it) used to surface as `SERVICE_UNAVAILABLE: Tool X handler threw: [object Object]` — the thrown value is a plain object, not an `Error`, so `err.message` is undefined and `String(err)` yields the `[object Object]` literal. The dispatcher now detects the envelope shape (`{ isError: true, content: [...], structuredContent: { adcp_error: { code } } }`) and returns it directly, preserving the typed code / field / suggestion exactly as if the handler had written `return`.

Driver: matrix v8 showed this pattern persisting across fresh-Claude builds even when the skill examples use `return`. Fixing it at the dispatcher closes the class of bugs once, instead of hoping every skill-corpus update lands. A `logger.warn` still fires on unwrap so agent authors see they should switch to `return`, but buyers stop paying for the mistake.

Idempotency claims are released on unwrap (same as any other thrown path) so retries proceed normally. Non-envelope throws (`TypeError`, custom errors, strings, objects without the full envelope shape) still surface as `SERVICE_UNAVAILABLE` with the underlying cause in `details.reason` — the existing handler-throw disclosure from PR #735 is unchanged.
