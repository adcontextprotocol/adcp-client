---
'@adcp/sdk': minor
---

Harden digest-mode upstream traffic attestations with JCS length alignment, bounded identifier proof scanning, clearer not-applicable grading, and stricter storyboard identifier path validation.

`computePayloadDigestSha256()` now applies the recorder's default payload normalization and secret-key redaction before hashing, and accepts a third `RegExp | false | { redactPattern?, maxPayloadBytes? }` argument. Pass the same custom options used by `createUpstreamRecorder()`, or pass `false` only when the payload has already been normalized/redacted exactly as the recorder would store it.

`RecordedCall.host` and `RecordedCall.path` remain optional on the public type, matching the looser `query_upstream_traffic` test-controller shape. The recorder populates both fields from `new URL(url)` when parsing succeeds and emits empty strings when parsing fails.

The `payload_length` docs now spell out the existing attestation semantics: raw calls report the redacted emitted payload length, while digest calls report the canonical byte length covered by `payload_digest_sha256`.

Storyboard `identifier_paths` are request-payload-relative. Loader validation now rejects request/response/context-prefixed forms including `request.*`, `$["request"].*`, and `$..request.*`; use paths such as `audiences[*].add[*].hashed_email`.
