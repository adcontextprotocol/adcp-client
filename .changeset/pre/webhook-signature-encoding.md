---
'@adcp/sdk': minor
---

Add an explicit `signatureEncoding` option to webhook verifiers for peers that emit RFC 8941 standard Base64 signatures. Preserve the AdCP webhook-v1 Base64URL default and 3.2 URL canonicalization, and document the distinction from request signing.
