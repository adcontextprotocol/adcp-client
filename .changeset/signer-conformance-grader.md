---
"@adcp/client": minor
---

feat(testing): `adcp grade signer` — validate a signer end-to-end before going live

Adds a CLI grader and matching library function that exercises a signer (typically KMS-backed) end-to-end: produces a sample signed AdCP request through the operator's signer, then verifies the result against the operator's published JWKS via the SDK's RFC 9421 verifier. Pass means a counterparty verifier will accept your signatures; fail produces a specific `error_code` + step matching the verifier-checklist semantics, so DER-vs-P1363 / kid-mismatch / wrong-key / algorithm-mismatch each surface as a distinct diagnostic instead of the generic `request_signature_invalid` you'd see in the seller's monitoring after pushing live traffic.

Two signer-source modes:

- `--key-file <path>` — local JWK file. Easy path for local dev / non-KMS testing.
- `--signer-url <url>` — HTTP signing oracle for KMS-backed signers. Wire contract is intentionally minimal — `POST {payload_b64, kid, alg}` returns `{signature_b64}` (raw wire-format bytes, not DER) — so any KMS adapter can put a small handler in front of `provider.sign()` for grading without exposing the underlying KMS to the grader.

Programmatic API: `gradeSigner(options)` exported from `@adcp/client/testing/storyboard/signer-grader`. Returns a `SignerGradeReport` with `passed`, `step.{status,error_code,diagnostic}`, the JWKS URI it resolved against, and the sample request the signer produced headers for (useful for operator-side diagnostics).

Pairs with the `SigningProvider` abstraction (also in 5.20.0) — that release added the surface for KMS-backed signing; this one closes the loop by giving operators a way to validate their adapter before going live.

Closes #610.
