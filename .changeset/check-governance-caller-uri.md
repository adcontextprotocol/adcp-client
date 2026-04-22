---
'@adcp/client': patch
---

Fix storyboard `check_governance` builder fallback: emit a URI-formatted
`caller` instead of a bare domain.

`governance/check-governance-request.json` declares `caller` as
`format: uri`; the fallback was passing `resolveBrand(options).domain`
directly, which fails strict JSON-schema validation (framework-dispatch
agents reject with `-32602 invalid_type`; legacy-dispatch accepts
permissively). The generated Zod schema does not enforce `format`
keywords, so the existing Zod round-trip invariant did not catch it.

Adds `test/lib/request-builder-jsonschema-roundtrip.test.js` — an AJV
round-trip invariant that validates every builder fallback against the
upstream JSON schema, catching `format` violations and strict
`additionalProperties` regressions that Zod misses. The suite ships
with a small `KNOWN_NONCONFORMING` allowlist for six pre-existing
fallback bugs (format_id.agent_url placeholders, missing required
fields on `update_media_buy` / `get_signals` / `create_content_standards`);
a companion guard test fails if any listed task starts passing, forcing
the allowlist to stay minimal as fixes land.

Closes #805 (check_governance half; the creative_approval half was
already fixed by prior work on the builder and is covered by the new
invariant).
