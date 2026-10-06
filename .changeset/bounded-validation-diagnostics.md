---
'@adcp/sdk': patch
---

Name forbidden fields individually when validation rejects a `not.anyOf` presence guard, so buyers can repair package updates. These failures now produce one issue per forbidden field instead of one opaque issue.

Correct `VALIDATION_ERROR.field` from RFC 6901 to the protocol-required JSONPath-lite notation. Consumers parsing `field` as a JSON Pointer should read `issues[].pointer` instead. Cap each serialized issue list at 100 issues and 64 KiB, and each issue at 8 KiB. Preserve the first omitted failure's schema keyword and bounded pointer, and signal truncation through `details.issues_truncated`. Preserve the full internal `sync_accounts` diagnostic set so valid sibling accounts still succeed in large batches.

Refresh vulnerable fast-uri, markdown-it, proxy-addr, and nested js-yaml dependencies.
