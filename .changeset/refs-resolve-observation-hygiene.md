---
'@adcp/client': patch
---

`refs_resolve`: harden grader-visible observation and `actual.missing`
payloads against hostile agent responses.

Compliance reports may be published or forwarded to third parties, so
every ref field emitted by the runner is now:

- **Userinfo-scrubbed** on URL-keyed fields via WHATWG URL parsing plus
  a regex fallback that scrubs `scheme://user:pass@` shapes embedded
  in non-URL fields. Credentials planted in `agent_url` values can no
  longer leak through compliance output.
- **Scheme-restricted** on URL-keyed fields: non-`http(s)` schemes
  (e.g. `javascript:`, `data:`, `file:`) are replaced with a
  `<non-http scheme: …>` placeholder so downstream UIs rendering
  `agent_url` as a link cannot inherit a stored-XSS vector.
- **Length-capped** at 512 code points per string field, with a
  code-point-boundary truncation that preserves surrogate pairs.
- **Count-capped** at 50 observations per check, with an
  `observations_truncated` marker when the cap fires. Meta
  observations (`scope_excluded_all_refs`, `target_paginated`)
  precede per-ref entries so the cap never drops primary signal.

Match and dedup behavior is unchanged: the internal projection used
for ref comparison is kept separate from the sanitized projection used
for user-facing output, so truncation never false-collapses dedup
keys. `refsMatch` and `projectRef` also now use `hasOwnProperty` to
prevent storyboard authors from accidentally drawing match keys from
`Object.prototype`. Closes #714.
