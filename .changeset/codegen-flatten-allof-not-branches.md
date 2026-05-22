---
'@adcp/sdk': minor
---

feat(codegen): surface typed shapes for `oneOf` branches that express their forbidden-field set via `allOf:[{not:{required:[X]}}, ...]`

Several AdCP 3.1.0-beta.3 request/response schemas use a `oneOf` of titled
mutual-exclusion branches where each branch declares "these fields are
forbidden" as an `allOf` of single-key `not.required` clauses. Until now,
the codegen tightener only recognized the simpler `not: { required: [X] }`
shape — when it saw an `allOf`, it bailed and `json-schema-to-typescript`
emitted the branch as `{ [k: string]: unknown | undefined }`, dropping
every typed field at the parent `items.properties` level.

**Most visible impact:** `SyncAccountsRequest.accounts[]` — the two
branches `ProvisioningMode` and `SettingsUpdateMode` now surface their
actual fields instead of being loose passthroughs:

- `ProvisioningMode`: `brand`, `operator`, `billing`, `billing_entity`,
  `payment_terms`, `sandbox`, `preferred_reporting_protocol`,
  `notification_configs`
- `SettingsUpdateMode`: `account`, `billing_entity`, `payment_terms`,
  `sandbox`, `preferred_reporting_protocol`, `notification_configs`

Buyers writing typed sync-accounts payloads now get autocomplete and
type-checking on the webhook-subscription field
(`notification_configs[]`) that 3.1 introduced for account-scoped
events (`creative.status_changed`, `creative.purged`, wholesale-feed
events). Previously the field would compile against the passthrough
arm but the typed shape was invisible to adopter tooling.

**Also surfaces:** named typed shapes for the same idiom inside
`CreativeAsset` (`V1CreativeNamedFormatReference` /
`V2CreativeCanonicalFormatKind`) and `CreativeManifest`
(`V1ManifestNamedFormatReference` / `V2ManifestCanonicalFormatKind`).

**Why the two forms aren't interchangeable upstream:**
`not: { required: [X, Y, Z] }` matches only when ALL three fields are
present (forbids only the conjunction). The `allOf:[{not:{required:
[X]}}, {not:{required:[Y]}}, {not:{required:[Z]}}]` form forbids each
field independently — "none of them may be present." That's the
authorial intent for `SettingsUpdateMode`, so the spec uses idiom #2.
The codegen now recognizes both forms when collecting per-branch
forbidden-name sets; semantics on the wire are unchanged (Ajv enforces
the unstripped schema at runtime).

No source changes required for adopters — regenerated types are
strictly more typed in the affected places.
