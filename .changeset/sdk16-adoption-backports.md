---
'@adcp/sdk': minor
---

Backport stable SDK adoption fixes without changing the AdCP 3.2.7 pin or legacy HTML projection. Preserve media-buy lifecycle status for AdCP 3.0 buyers and select account-change response validation from negotiated release metadata or an explicit fallback. Add the signature-agnostic, release-aware `parseMediaBuyDeliveryWebhook`, readable schema-ref validators, a shared delivery-body type/schema, canonical AssetVariant exports and shallow schema typing with reachable asset minItems validation, and frozen targeting-key lists.

Preserve safe account identity fields through `accounts.upsert` response projection. SDK 16 retains the existing `SyncAccountsResultRow` interface and its required legacy fields for source compatibility. When `account` is present, the framework emits it as the 3.2 identity anchor and omits flat brand/operator; 3.0/3.1 responses retain the flat identity. Destination billing staging data, bank details, and framework auth metadata remain private; nested identity objects are validated and detached before output/replay caching. SDK 17 provides the modern account-only result union.

Restore strict `by_package` validation for webhook result rows while retaining existing stable polling schema tolerance. The new shared body type follows that existing stable poll output shape. No global nonempty-array/daypart type tightening or SDK17 HTML-kind remapping is included.

Restore protocol-authored minItems only in the schema graph reachable from `AssetVariantSchema`, including macro declarations and catalog selections. Empty arrays in those fields already violate the published canonical types. A shallow canonical output annotation fixes TypeScript 5.9/7 assignability without global nonempty-array or daypart changes; the union options helper remains available.

The asset graph includes shared catalog, provenance, inline-markup, tag/redirect and tracker schemas, so their direct Zod consumers also reject the same protocol-invalid empty arrays (including catalog/provenance fields in other payloads). Existing wire JSON Schema validation already rejects these values. Per-branch union helpers and the typed input contract are retained.
