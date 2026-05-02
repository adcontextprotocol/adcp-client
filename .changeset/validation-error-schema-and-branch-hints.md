---
"@adcp/sdk": minor
---

Validation errors now name the rejecting schema and the discriminator the payload was inferred to be targeting. Closes #1283.

`ValidationIssue` carries two new optional fields:

- **`schemaId`** — `$id` of the rejecting schema, resolved by finding the longest registered AJV `$id` that prefixes the issue's `schemaPath`. For tools served from the flat schema tree (e.g. `governance/`, `brand/`) where `$ref`s are followed at runtime, this lands on the deeper sub-schema. For tools served from the pre-resolved `bundled/` tree (most of the catalog — signals, media-buy, creative), inner `$id`s are stripped at bundle time so `schemaId` resolves to the response root. Either way, the field names exactly the schema the validator looked at.
- **`discriminator`** — array of `{field, value}` pairs identifying the variant the payload was inferred to be targeting. Populated when `compactUnionErrors`' const-discriminator collapse picks a "best surviving variant" (the user matched the discriminator but missed required fields or other constraints inside it). Compound discriminators like `audience-selector`'s `(type, value_type)` produce multi-entry arrays. Names align with OpenAPI 3.x `discriminator.propertyName`.

Both fields ride on every `VALIDATION_ERROR` envelope by default — same precedent as `variants[]` and `allowedValues`, which already ship always-on with the rationale "PUBLIC spec data, not internal handler shape." The `exposeSchemaPath` gate stays in place for `schemaPath` itself.

The prose `adcp_error.message` mirrors the new fields so adopters debugging from a wire envelope alone don't need to walk `issues[]`. The `(schema: …)` half is suppressed when the issue's `schemaId` equals the validator's root (bundled-tree default — restating the tool name doesn't help). New `ValidationOutcome.schemaId` exposes the root for callers building their own envelopes:

```
activate_signal response failed schema validation at /deployments/0/activation_key/key:
  must have required property 'key' (discriminator: type='key_value')
```

Empirically every example built during the matrix-blind-fixtures lineage took 1–3 iterations to resolve a discriminated-union error that's now one-shot once the adopter reads the `discriminator` tag.

**Known limitations** (follow-ups filed separately):
- Bundled tools strip inner `$id`s — `schemaId` lands on the response root, not the deeper sub-schema referenced by `$ref`. A spec companion issue covers `$id` retention during bundling.
- Synthetic union-root errors in nested unions can carry the outer discriminator (e.g. `type='platform'`) while leaf errors carry the inner (`type='key_value'`). The leaf is the actionable one; the root is contextual. Spec companion covers de-duplication.
- The optional `hint` field from issue #1283's "Proposed change" #3 (curated prose like "type='key_value' requires top-level `key` and `value`") is deferred — requires per-tool curation and ships separately.
