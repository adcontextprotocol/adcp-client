# Migration Guide: 7.11 to 8.0

## Wholesale Feed Sync Rename

The beta wholesale feed mirror helper was renamed to match the AdCP 3.1 beta 3 protocol language.

```ts
// Before
import { CatalogSync } from '@adcp/sdk/catalog-sync';

// After
import { WholesaleFeedSync } from '@adcp/sdk/wholesale-feed-sync';
```

Type names moved with the class:

| 7.11 beta name | 8.0 name |
| --- | --- |
| `CatalogSync` | `WholesaleFeedSync` |
| `CatalogSyncConfig` | `WholesaleFeedSyncConfig` |
| `CatalogSyncClient` | `WholesaleFeedSyncClient` |
| `CatalogSyncEvents` | `WholesaleFeedSyncEvents` |
| `CatalogSyncMode` | `WholesaleFeedSyncMode` |
| `CatalogSyncState` | `WholesaleFeedSyncState` |

The old `@adcp/sdk/catalog-sync` subpath was removed. Use `@adcp/sdk/wholesale-feed-sync`.

`CursorStore`, `InMemoryCursorStore`, and `FileCursorStore` are still available from the `@adcp/sdk` package root for `RegistrySync` users; they are no longer re-exported from the wholesale feed sync subpath.

The beta-era direct feed polling options were removed from the config shape: `feedOrigin`, `feedHeaders`, `maxFeedResponseBytes`, `pollIntervalMs`, `cursorStore`, and `fetch`. Beta 3 wholesale feed sync uses account-level `notification_configs[]` webhooks plus conditional wholesale reads for repair.

`ResolvedCapabilities.catalogVersioning` was also removed. Use `ResolvedCapabilities.wholesaleFeedVersioning`.
