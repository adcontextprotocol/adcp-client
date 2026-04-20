---
'@adcp/client': minor
---

`createAdcpServer` auto-wires the RFC 9421 verifier when the seller declares the `signed-requests` specialism and provides `signedRequests: { jwks, replayStore, revocationStore }`. Startup-fails when `signedRequests` is configured without the specialism claim; logs a loud error when the specialism is claimed without a `signedRequests` config (to avoid breaking legacy manual `serve({ preTransport })` wiring). Closes the footgun where claiming the specialism didn't enforce it.
