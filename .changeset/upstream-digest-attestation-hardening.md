---
'@adcp/sdk': minor
---

Harden digest-mode upstream traffic attestations with JCS length alignment, bounded identifier proof scanning, clearer not-applicable grading, and stricter storyboard identifier path validation.

`computePayloadDigestSha256()` now applies the recorder's default payload normalization and secret-key redaction before hashing, and accepts a third `RegExp | false | { redactPattern?, maxPayloadBytes? }` argument. Pass the same custom options used by `createUpstreamRecorder()`, or pass `false` only when the payload has already been normalized/redacted exactly as the recorder would store it.

`RecordedCall.host` and `RecordedCall.path` are emitted as strings. The recorder populates both fields from `new URL(url)` when parsing succeeds and emits empty strings when parsing fails.

The `payload_length` docs now spell out the existing attestation semantics: raw calls report the redacted emitted payload length, while digest calls report the canonical byte length covered by `payload_digest_sha256`.

Manual `record()` calls with JSON-string payloads now parse and secret-redact the stored payload just like wrapped `fetch()` calls, so raw and digest attestations use the same redacted body view. Redaction now walks to the recorder's 256-level JSON canonicalization cap, raw recording rejects structured payloads beyond that cap, invalid purpose classifier values are omitted instead of emitting off-spec strings, and disabled recorder queries without a caller-supplied bound return a schema-valid epoch `since_timestamp`.

Storyboard `identifier_paths` are request-payload-relative. Loader validation now rejects request/response/context-prefixed forms including `request.*`, `$["request"].*`, and `$..request.*`; use paths such as `audiences[*].add[*].hashed_email`. `runStoryboardStep()` now runs the same shape validation as full storyboard runs for programmatic callers.

Digest-mode `upstream_traffic` validations now grade controller-side non-finite-number canonicalization failures as `not_applicable`, matching the 3.1 runner contract for JSON values that cannot be portably canonicalized.
