---
'@adcp/client': minor
---

**Enrich `oneOf` / `anyOf` validation errors with variant metadata.** When AJV rejects a request because a discriminated-union field matched none of its variants, the emitted `ValidationIssue` now carries a `variants[]` array describing what each variant would accept — instead of the bare "must match exactly one schema in oneOf" that left naive LLM clients stuck.

Before:
```json
{ "pointer": "/account", "keyword": "oneOf", "message": "must match exactly one schema in oneOf" }
```

After:
```json
{
  "pointer": "/account",
  "keyword": "oneOf",
  "message": "must match exactly one schema in oneOf",
  "variants": [
    { "index": 0, "required": ["account_id"],       "properties": ["account_id"] },
    { "index": 1, "required": ["brand", "operator"], "properties": ["brand", "operator", "sandbox"] }
  ]
}
```

A caller reading this knows exactly which combinations to try — pick one variant's `required` fields. Empirically, this unsticks the #1 naive-LLM stall point (discriminated `account` on `create_media_buy`, discriminated `destinations[]` on `activate_signal`, etc.).

**Scope:** applies to both `validateRequest` and `validateResponse`. Variants land on the same `issues[]` that ship at `adcp_error.issues` and `adcp_error.details.issues` on wire envelopes — no new field on the error envelope itself. Non-union keywords (`required`, `type`, `enum`, `additionalProperties`, …) are unchanged.

**Trade-off:** response payload grows slightly for schemas with many variants. Variants are derived from public `@adcp/client`/AdCP spec schemas — no seller-specific information leaks. `schemaPath` gating (production strip) is unchanged; `variants` is not gated because the information is already public in the canonical schemas under `schemas/cache/<version>/`.

**Related:** pairs with [#918](https://github.com/adcontextprotocol/adcp-client/pull/918) (buyer-side `call-adcp-agent` skill) and #915 (validation symmetry). Together these give naive LLMs two paths to recover: the skill carries priors about common variants; the enriched error carries them at runtime for variants the skill doesn't cover. Non-LLM buyers (programmatic clients) benefit regardless.
