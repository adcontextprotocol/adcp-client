---
'@adcp/sdk': patch
---

Treat flat `{ error_code: "..." }` responses as terminal AdCP errors in storyboard expected-error handling so permissive non-standard INVALID_REQUEST envelopes do not fail negative-path steps.
