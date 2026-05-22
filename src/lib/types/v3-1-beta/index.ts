// AdCP 3.1.0-beta.1 type surface — re-export the generated request/response
// interfaces so consumers can import them as a namespace:
//
//   import * as V31Beta from '@adcp/sdk/types/v3-1-beta';
//   const req: V31Beta.GetProductsRequest = { if_wholesale_feed_version: 'v123' };
//
// Or by name:
//
//   import type { GetProductsResponse, WholesaleFeedEvent } from '@adcp/sdk/types/v3-1-beta';
//
// The SDK's primary type surface (`@adcp/sdk/types`) stays pinned to the
// GA `ADCP_VERSION`; this opt-in parallel tree exposes the catalog-sync
// wholesale-feed sync additions (`if_wholesale_feed_version`, `cache_scope`,
// `unchanged`, `WholesaleFeedEvent`, `WholesaleFeedWebhook`) so consumers can build against
// beta sellers with full type coverage.
//
// The generated file is the source of truth; refresh by running
// `npm run sync-schemas:3.1-beta && npm run generate-types:3.1-beta`.

export * from './tools.generated';
