---
'@adcp/sdk': patch
---

chore(typecheck-skill-examples): treat `defineSalesPlatform` / `defineSalesCorePlatform` / `defineAudiencePlatform` / `defineSalesIngestionPlatform` calls as full-module anchors

Skill snippets that demonstrate platform handler shapes (e.g. `defineSalesPlatform<Meta>({ getProducts: async (req, ctx) => {...} })`) compile standalone with full type inference, but the typecheck harness's `FULL_MODULE_ANCHORS` regex didn't recognize them. Result: those blocks were classified as fragments and skipped — exactly the drift class the harness exists to catch.

Adding the four `define*Platform` regexes lifts ~2 blocks today (sales-guaranteed and sales-social Forecast / Planning-surface sections) into the compiled set, and gives future doc authors a way to write fragment-shaped snippets that still get typechecked. No baseline churn.
