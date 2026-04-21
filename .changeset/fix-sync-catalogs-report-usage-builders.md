---
'@adcp/client': patch
---

Fix `sync_catalogs` and `report_usage` storyboard request-builders to honor `step.sample_request` when present, and use spec-valid defaults when building a fallback.

**sync_catalogs** — before this fix, the builder ignored the storyboard's `sample_request` entirely and returned a hardcoded catalog with `feed_format: 'json'` (not in the `FeedFormatSchema` union: `google_merchant_center | facebook_catalog | shopify | linkedin_jobs | custom`) and no `type` field (required by `CatalogSchema`). Every conformance agent running the generated Zod schema rejected the request with `-32602` on both paths. The fallback now uses `type: 'product'` + `feed_format: 'custom'`, and the builder reads `sample_request` first.

**report_usage** — same pattern: builder ignored `sample_request` and returned per-entry shape `{ creative_id, impressions, spend: { amount, currency } }` which doesn't match `usage-entry.json` (expects top-level `vendor_cost: number` + `currency: string` + `account` on each entry). Agents rejected with `-32602` listing all three missing fields. Fixed by reading `sample_request` first and aligning the fallback to the spec shape.

Surfaced by the matrix harness — every `sales_catalog_driven` and `creative_ad_server` run showed the same builder-generated -32602 before this patch.
