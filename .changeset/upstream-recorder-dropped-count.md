---
'@adcp/sdk': minor
---

Add `dropped_count` to `UpstreamRecorderQueryResult` to surface the number of matched entries omitted from returned items after digest canonicalization failure; `digest_canonicalization_failed` is surfaced through `onError` when that hook is configured. The field is always `0` in raw mode and on the noop recorder. Wire projection onto `toQueryUpstreamTrafficResponse` / `UpstreamTrafficSuccess` is schema-gated and will be added when the spec adopts the field.
