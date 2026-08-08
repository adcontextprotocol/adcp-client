---
'@adcp/sdk': major
---

Remove the legacy bare `RegExp` and `false` third-argument forms from `computePayloadDigestSha256()`. Pass custom redaction as `{ redactPattern }` and identify already-normalized payloads with `{ prenormalized: true }`.
