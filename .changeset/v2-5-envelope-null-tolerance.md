---
'@adcp/sdk': patch
---

Fix v2.5 response validator spuriously rejecting null on optional envelope fields.

v2.5 sellers built on Pydantic commonly emit `errors: null`, `context: null`, and `ext: null` to signal "nothing here" rather than omitting the key. After #1137 pinned `validateResponseSchema` to the detected server version, Ajv correctly validated these responses against the v2.5 schema — but the v2.5 schemas declare those fields as `type: 'array'` or `type: 'object'` without a `null` union, so every such response failed with `/errors: must be array; /context: must be object; /ext: must be object`.

The fix adds a `stripEnvelopeNulls` pre-processing step inside `validateResponse` that strips top-level optional fields whose value is `null` but whose declared schema type is not nullable. Gated to v2.x schema bundles only — in v3, `errors` is a required field on failure branches and must not be silently dropped.

Surfaced against Wonderstruck (v2.5 MCP) by `scripts/smoke-wonderstruck-v2-5.ts` (issue #1149).
