---
---

Test-only change. Adds `test/request-signing-live-verifier-integration.test.js`
plus the shared `test/helpers/signing-origin-servers.js` helper to cover the
`HttpsJwksResolver` + `HttpsRevocationStore` wiring inside
`verifyRequestSignature` across multi-step rotation / revocation flows. No
library surface changes — no publishable release needed.
