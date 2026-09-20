---
'@adcp/sdk': patch
---

Name the A2A dispatch's `legacyCompat` policy once, with the measurement that justifies it.

`request-signing/a2a-dispatch.ts` set `{ enabled: true }` at two call sites. Measured against `@a2a-js/sdk`, that is the card-following setting: a `1.0` card emits `CancelTask`/`a2a-version: 1.0` whether it is on or off, while a `0.3.0` card emits `tasks/cancel`/`0.3` with it on and `CancelTask`/`1.0` with it off. Turning it off does not refuse a 0.3 card, it speaks 1.0 at one — so a conformance run must leave it on. Folded from adcontextprotocol/adcp-client#2973.
