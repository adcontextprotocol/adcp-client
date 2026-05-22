---
'@adcp/sdk': major
---

Remove the beta `CatalogSync` surface and replace it with `WholesaleFeedSync` / `@adcp/sdk/wholesale-feed-sync`. This removes the old `@adcp/sdk/catalog-sync` subpath, the `catalogVersioning` capability alias, the beta direct-feed config keys (`feedOrigin`, `feedHeaders`, `maxFeedResponseBytes`, `pollIntervalMs`, `cursorStore`, `fetch`), and the cursor-store re-exports from that subpath.

Wholesale feed webhooks now repair only the affected product or signal feed on `wholesale_feed.bulk_change`, fail closed on missing or invalid `affected_entity_type`, and record terminally rejected bulk-change deliveries in the webhook dedupe store before rethrowing.
