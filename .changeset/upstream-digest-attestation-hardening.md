---
'@adcp/sdk': minor
---

Harden digest-mode upstream traffic attestations with JCS length alignment, bounded identifier proof scanning, clearer not-applicable grading, and stricter storyboard identifier path validation.

`computePayloadDigestSha256()` now applies the recorder's default payload normalization and secret-key redaction before hashing, and accepts a third `RegExp | false | PayloadDigestOptions` argument. Pass `createUpstreamRecorder({ redactPattern })` through as `{ redactPattern }`, and `createUpstreamRecorder({ maxPayloadBytes })` through as `{ maxPayloadBytes }`. Pass `{ prenormalized: true }` only when the payload has already been normalized/redacted exactly as the recorder would store it; prenormalized inputs with unredacted secret-shaped keys now throw `PayloadDigestError`, malformed prenormalized JSON strings and duplicate secret-shaped form keys are rejected, and `{ redactPattern: false }` is rejected unless paired with `{ prenormalized: true }`. Secret-shaped keys in prenormalized payloads are considered safe only when their value is the literal `"[redacted]"` marker or `null`. Legacy bare `RegExp` and `false` forms remain accepted for this major but are soft-deprecated in favor of `{ redactPattern }` and `{ prenormalized: true }`.

`RecordedCall.host` and `RecordedCall.path` are emitted as strings. The recorder populates both fields from `new URL(url)` when parsing succeeds and emits empty strings when parsing fails.

BEHAVIOR CHANGE: digest-mode `payload_length` now reports the canonical byte length covered by `payload_digest_sha256`; raw calls continue to report the redacted emitted payload length.

Manual `record()` calls with JSON-string payloads now parse and secret-redact the stored payload just like wrapped `fetch()` calls, so raw and digest attestations use the same redacted body view. Parsed JSON string payloads now fail closed beyond the recorder's 256-level JSON canonicalization cap, and malformed JSON strings get a best-effort key-based secret scrub before diagnostic storage and surface an `onError` event when configured and digest-mode identifier scanning cannot parse them. Digest-mode query projection now drops only the non-canonical recorded entry and surfaces `digest_canonicalization_failed` through configured `onError` instead of throwing the whole query. Redaction now walks to the recorder's 256-level JSON canonicalization cap with cycle protection, raw recording rejects structured payloads beyond that cap, invalid purpose classifier values are omitted instead of emitting off-spec strings, and disabled recorder queries without a caller-supplied bound return a schema-valid epoch `since_timestamp`. Purpose classifier values remain a preview surface until the `purpose` field is adopted by the spec; unknown values are omitted rather than emitted on the wire.

Storyboard `identifier_paths` are request-payload-relative. Loader validation now rejects request/response/context-prefixed forms including `request.*`, `$["request"].*`, and `$..request.*`; use paths such as `audiences[*].add[*].hashed_email`. `runStoryboardStep()` now runs the same shape validation as full storyboard runs for programmatic callers without rewriting caller-owned path strings.

Digest-mode `upstream_traffic` validations now grade controller-side non-finite-number canonicalization failures as `not_applicable`, matching the 3.1 runner contract for JSON values that cannot be portably canonicalized.

Compliance summary artifacts now expose `validations_not_applicable` when any validations were downgraded, so CI and badge consumers can tell a clean pass from a pass with coverage downgrades.
