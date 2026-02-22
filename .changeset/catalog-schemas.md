---
"@adcp/client": minor
---

Sync AdCP catalog schemas: add `sync_catalogs` task, `Catalog` core type, and new catalog-related enums (`CatalogType`, `CatalogAction`, `CatalogItemStatus`). The `GetProductsRequest` now accepts a `catalog` field for product selection. Deprecated `PromotedProducts` and `PromotedOfferings` types are retained in the backwards-compatibility layer with a `promotedProductsToCatalog()` migration helper.
