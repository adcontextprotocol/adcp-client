---
'@adcp/sdk': minor
---

Add `dropped_count` to `UpstreamRecorderQueryResult` to surface the number of matched entries silently dropped by digest canonicalization failure. The field is always `0` in raw mode and on the noop recorder. Wire projection onto `toQueryUpstreamTrafficResponse` / `UpstreamTrafficSuccess` is schema-gated and will be added when the spec adopts the field.
