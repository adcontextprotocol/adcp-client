---
'@adcp/sdk': minor
---

Add a seller wholesale catalogue service, `@adcp/sdk/wholesale-catalog` (#3630). A seller that sells a wholesale catalogue wrote paging, per-scope versions, conditional reads, account isolation and change events itself, and each got versioning and scope isolation wrong in its own way. Now it writes one function, `readCatalog(scope)`, and `createWholesaleCatalogService` does the rest, shaped like `createReliableReportingService` (an adapter, a replaceable snapshot store, `install`, `start` and `stop`):

- **Serves** `list_products` and wholesale `get_products` from one stored snapshot per scope, with cursor paging.
- **Versions** each scope with a `sha256:` hash that includes the scope and the account, so a token from one account never matches another. A matching `if_feed_version` or `if_wholesale_feed_version` answers `unchanged` with no products.
- **Isolates accounts.** `readCatalog` is called only with the public scope or the account the server resolved for the caller, never one named in a request; return `null` for an account that prices off the public catalogue.
- **Notifies.** `update(scope)` (and a reconcile timer as a backstop) compares with the snapshot and sends `product.created|updated|priced|removed`, or one `wholesale_feed.bulk_change` for a large change, through the persistent notification runtime. An account change goes only to that account's subscribers; each subscriber gets the `canonical` or `legacy` product view it registered. Events are stored with the change and retried with stable ids until the runtime accepts them.
- **Declares** `wholesale` in `media_buy.buying_modes`, `wholesale_feed_versioning` and `wholesale_feed_webhooks`; `isCurrent` and `assertCurrent` give `buy_products` its `feed_version` check.

`createAdcpServerFromPlatform` also no longer adds `products: []` to a wholesale `get_products` answer of `unchanged: true`, which the schema forbids.

See `docs/guides/WHOLESALE-CATALOG.md` and the reference seller in `examples/wholesale-catalog-seller`.

**Who is affected.** Sellers adopting the service. The one change for existing sellers is the `unchanged: true` fix above: a seller that returns it from `sales.getProducts` now passes strict response validation.
