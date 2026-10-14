---
'@adcp/sdk': patch
---

Build every AdCP 3.2.4 request-signing vector faithfully. The grader now constructs the duplicate `Signature` label, mixed-case `Content-Digest` key and malformed `Host` negatives (and their 3.2-profile mirrors), preserves the two-label and two-algorithm positives instead of collapsing them to a single signature and digest, keeps the correct `Content-Digest` on the unsigned 3.2 mirrors, and reports the Host-header negative as transport-ungradable and the bracketed-IPv6 positive as skipped where the transport cannot carry the authority. `verifyRequestSignature` now refuses a malformed `Host` header with `request_target_uri_malformed`.
