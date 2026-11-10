/**
 * Reference seller for the wholesale catalogue service (`@adcp/sdk/wholesale-catalog`): one `readCatalog`
 * function, and the SDK serves `list_products` and wholesale `get_products`, pages and versions the catalogue,
 * answers conditional reads with `unchanged`, and, given a notification runtime, sends `product.*` events.
 * It passes `examples/storyboards/wholesale-catalog.yaml`.
 *
 * The catalogue here is two accounts' worth of in-memory rows. Replace `readCatalog` with your database, pass
 * `snapshots` a durable store, and pass `notifications` the runtime that holds your buyers' subscriptions.
 */
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';
import { buildProduct } from '@adcp/sdk/server';
import { createWholesaleCatalogService } from '@adcp/sdk/wholesale-catalog';

const product = (id, floor) =>
  buildProduct({
    id,
    name: `Product ${id}`,
    publisher_domain: 'reference-seller.example',
    format_options: [{ format_option_id: 'banner', format_kind: 'image', params: { width: 300, height: 250 } }],
    delivery_type: 'non_guaranteed',
    pricing: { model: 'cpm', floor, currency: 'USD' },
  });

export const PUBLIC_CATALOG = ['p1', 'p2', 'p3', 'p4', 'p5'].map(id => product(id, 5));
/** Account A has its own prices; account B follows the public catalogue. */
export const ACCOUNT_A_ID = 'acct-a';
export const ACCOUNT_B_ID = 'acct-b';

export function createWholesaleCatalogSeller({ notifications, snapshots } = {}) {
  const catalogue = { public: structuredClone(PUBLIC_CATALOG), a: PUBLIC_CATALOG.map(p => product(p.product_id, 3)) };
  const service = createWholesaleCatalogService({
    accountOverlays: true,
    notifications,
    snapshots,
    adapter: {
      readCatalog: scope => {
        if (scope.cacheScope === 'public') return structuredClone(catalogue.public);
        return scope.accountId === ACCOUNT_A_ID ? structuredClone(catalogue.a) : null;
      },
    },
  });
  const platform = service.install({
    capabilities: { specialisms: [], config: {} },
    accounts: {
      resolution: 'explicit',
      resolve: async ref =>
        ref?.account_id ? { id: ref.account_id, ctx_metadata: {} } : { id: ACCOUNT_B_ID, ctx_metadata: {} },
    },
  });
  const createServer = () =>
    createAdcpServerFromPlatform(platform, {
      name: 'wholesale-catalog-reference-seller',
      version: '1.0.0',
      validation: { requests: 'strict', responses: 'strict' },
    });
  return { createServer, service, catalogue };
}
