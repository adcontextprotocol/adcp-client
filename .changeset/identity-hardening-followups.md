---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 identity hardening (follow-up to #3244): process-local trust authority history no longer evicts or globally disables the legacy brand.json fallback on overflow; it is budgeted per PSL PRIVATE-section suffix (`maxAuthoritativeOperatorsPerPrivateSuffix`, default 32) and in total, and refuses the record of an operator over budget. Duplicate structured-field members or parameters in Signature-Input, Signature and Signature-Agent are rejected as malformed under both Web Bot Auth (400) and RFC 9421 (`request_signature_header_malformed`). `createExpressVerifier` refuses Web Bot Auth requests with 403 instead of answering them under the RFC 9421 profile.
