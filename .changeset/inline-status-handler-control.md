---
'@adcp/sdk': minor
---

Add per-call `skipStatusHandlers` to bypass inline completion callbacks, including deferred and submitted continuations. Add opt-in `isolateStatusHandlerErrors` and an `onStatusHandlerError` observer so local post-processing failures can be reported without discarding successful seller results or preventing settlement acknowledgement. Existing handler rejection and retry behavior remains the default; independently delivered webhook callbacks are unaffected.
