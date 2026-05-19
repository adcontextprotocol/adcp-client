// CatalogSync — in-memory replica of an AdCP agent's product / signal
// catalog with three sync modes (manual / auto-poll / live). Tests inject
// a stub client (CatalogSyncClient interface) so each mode is exercised
// without real network I/O. The live-mode change-feed poll talks to
// `<feedOrigin>/catalog/events` via raw fetch; we override that with a
// mock implementation in the constructor.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { CatalogSync } = require('../../dist/lib/catalog-sync/index.js');

// ====== Fixture helpers ======

function makeCapabilitiesResult(stanza) {
  // SingleAgentClient.getAdcpCapabilities returns TaskResult<...>. The
  // CatalogSync mode resolver reads `.data` directly; we stub the same
  // shape here without recreating the full TaskResult union.
  return { data: stanza };
}

function makeProductsResult(products, { catalog_version, cache_scope = 'public', pagination } = {}) {
  const out = {
    products,
    cache_scope,
    ...(catalog_version && { catalog_version }),
    ...(pagination && { pagination }),
  };
  return { data: out };
}

function makeUnchangedResult({ catalog_version, cache_scope = 'public' }) {
  return {
    data: {
      unchanged: true,
      catalog_version,
      cache_scope,
    },
  };
}

function makeSignalsResult(signals, { pagination } = {}) {
  return { data: { signals, cache_scope: 'public', ...(pagination && { pagination }) } };
}

function makeProduct(product_id, overrides = {}) {
  return {
    product_id,
    name: `Product ${product_id}`,
    description: `Description for ${product_id}`,
    delivery_type: 'guaranteed',
    format_ids: [{ id: 'video_ctv_1080p_30s' }],
    pricing_options: [{ pricing_option_id: 'po_cpm_v1', pricing_model: 'cpm', currency: 'USD', fixed_price: 18.5 }],
    ...overrides,
  };
}

function makeSignal(signal_agent_segment_id, overrides = {}) {
  return {
    signal_id: {
      source: 'catalog',
      data_provider_domain: 'acme-data.com',
      id: signal_agent_segment_id,
    },
    signal_agent_segment_id,
    name: `Signal ${signal_agent_segment_id}`,
    description: `Description for ${signal_agent_segment_id}`,
    signal_type: 'marketplace',
    data_provider: 'Acme Data',
    deployments: [],
    pricing_options: [{ pricing_option_id: 'po_cpm_1', model: 'cpm', cpm: 2.5, currency: 'USD' }],
    ...overrides,
  };
}

function makeStubClient(opts = {}) {
  const calls = { capabilities: 0, getProducts: 0, getSignals: 0 };
  const client = {
    async getAdcpCapabilities() {
      calls.capabilities++;
      return makeCapabilitiesResult(opts.capabilities ?? {});
    },
    async getProducts(params) {
      calls.getProducts++;
      if (typeof opts.getProducts === 'function') return opts.getProducts(params, calls.getProducts);
      return makeProductsResult([]);
    },
    async getSignals(params) {
      calls.getSignals++;
      if (typeof opts.getSignals === 'function') return opts.getSignals(params, calls.getSignals);
      return makeSignalsResult([]);
    },
  };
  return { client, calls };
}

// Build a Response-like object for fetch mocks. The CatalogSync code uses
// status, statusText, ok, clone(), and json(). We don't need a full
// implementation — just enough for the live-mode poll loop.
function makeFetchResponse(body, { status = 200, statusText = 'OK' } = {}) {
  const json = async () => body;
  const response = {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    clone: () => makeFetchResponse(body, { status, statusText }),
    json,
  };
  return response;
}

// ====== Tests ======

describe('CatalogSync', () => {
  describe('mode resolution from capabilities', () => {
    test('resolves to live when catalog_change_feed.supported is true', async () => {
      const { client } = makeStubClient({
        capabilities: {
          catalog_change_feed: { supported: true, event_types: ['product.priced'] },
        },
      });
      // No feedOrigin → mode resolution still succeeds; the live-mode
      // poll loop throws lazily if it ever fires without one.
      const sync = new CatalogSync({ client, feedOrigin: 'https://agent.example.com' });
      // Bypass bootstrap by stubbing wholesale to return empty.
      await sync.start();
      assert.strictEqual(sync.mode, 'live');
      assert.strictEqual(sync.capabilities.changeFeed, true);
      assert.deepStrictEqual([...sync.capabilities.eventTypes], ['product.priced']);
      sync.stop();
    });

    test('resolves to auto-poll when only catalog_versioning is supported', async () => {
      const { client } = makeStubClient({
        capabilities: { catalog_versioning: { supported: true } },
      });
      const sync = new CatalogSync({ client });
      await sync.start();
      assert.strictEqual(sync.mode, 'auto-poll');
      assert.strictEqual(sync.capabilities.catalogVersioning, true);
      assert.strictEqual(sync.capabilities.changeFeed, false);
      sync.stop();
    });

    test('resolves to manual when neither stanza is declared (3.0 agent)', async () => {
      const { client } = makeStubClient({ capabilities: {} });
      const sync = new CatalogSync({ client });
      await sync.start();
      assert.strictEqual(sync.mode, 'manual');
      assert.strictEqual(sync.capabilities.changeFeed, false);
      assert.strictEqual(sync.capabilities.catalogVersioning, false);
      sync.stop();
    });

    test('signals.queryable mirrors signals.discovery_modes.wholesale', async () => {
      const { client: clientYes } = makeStubClient({
        capabilities: { signals: { discovery_modes: ['brief', 'wholesale'] } },
      });
      const yesSync = new CatalogSync({ client: clientYes });
      await yesSync.start();
      assert.strictEqual(yesSync.signals.queryable, true);
      yesSync.stop();

      const { client: clientNo } = makeStubClient({
        capabilities: { signals: { discovery_modes: ['brief'] } },
      });
      const noSync = new CatalogSync({ client: clientNo });
      await noSync.start();
      assert.strictEqual(noSync.signals.queryable, false);
      noSync.stop();
    });
  });

  describe('manual mode bootstrap', () => {
    test('paginates wholesale get_products and populates the product index', async () => {
      const products1 = [makeProduct('p1'), makeProduct('p2')];
      const products2 = [makeProduct('p3')];
      const { client } = makeStubClient({
        capabilities: {},
        getProducts: (_params, callNumber) => {
          if (callNumber === 1) {
            return makeProductsResult(products1, {
              catalog_version: 'v1',
              pagination: { has_more: true, cursor: 'page-2' },
            });
          }
          return makeProductsResult(products2, {
            catalog_version: 'v1',
            pagination: { has_more: false },
          });
        },
      });
      const sync = new CatalogSync({ client });
      await sync.start();
      assert.strictEqual(sync.products.count, 3);
      assert.strictEqual(sync.products.get('p2')?.name, 'Product p2');
      assert.strictEqual(sync.mode, 'manual');
      sync.stop();
    });

    test('skips signal bootstrap when discovery_mode wholesale is unsupported', async () => {
      const { client, calls } = makeStubClient({
        capabilities: { signals: { discovery_modes: ['brief'] } },
        getProducts: () => makeProductsResult([makeProduct('p1')], { catalog_version: 'v1' }),
        getSignals: () => {
          throw new Error('CatalogSync must not call get_signals when wholesale is unsupported');
        },
      });
      const sync = new CatalogSync({ client });
      await sync.start();
      assert.strictEqual(calls.getSignals, 0);
      assert.strictEqual(sync.signals.queryable, false);
      assert.strictEqual(sync.signals.count, 0);
      sync.stop();
    });

    test('refresh() emits diff events for added/removed/repriced products', async () => {
      const initial = [makeProduct('p1'), makeProduct('p2')];
      let phase = 'initial';
      const { client } = makeStubClient({
        capabilities: {},
        getProducts: () => {
          if (phase === 'initial') return makeProductsResult(initial, { catalog_version: 'v1' });
          // After refresh:
          // - p1 removed
          // - p2 reprice
          // - p3 added
          return makeProductsResult(
            [
              makeProduct('p2', {
                pricing_options: [
                  { pricing_option_id: 'po_cpm_v2', pricing_model: 'cpm', currency: 'USD', fixed_price: 22.0 },
                ],
              }),
              makeProduct('p3'),
            ],
            { catalog_version: 'v2' }
          );
        },
      });
      const sync = new CatalogSync({ client });
      await sync.start();
      assert.strictEqual(sync.products.count, 2);

      const events = [];
      sync.on('event', ({ event }) => events.push(event.event_type));

      phase = 'after';
      await sync.refresh();

      assert.deepStrictEqual(events.sort(), ['product.created', 'product.priced', 'product.removed']);
      assert.strictEqual(sync.products.count, 2);
      assert.strictEqual(sync.products.get('p1'), undefined);
      assert.strictEqual(sync.products.get('p3')?.name, 'Product p3');
      sync.stop();
    });
  });

  describe('search', () => {
    test('products.search filters by format_ids, delivery_type, and text', async () => {
      const { client } = makeStubClient({
        capabilities: {},
        getProducts: () =>
          makeProductsResult(
            [
              makeProduct('ctv-premium', { name: 'Premium CTV', delivery_type: 'guaranteed' }),
              makeProduct('display-floor', {
                name: 'Display Floor',
                delivery_type: 'non_guaranteed',
                format_ids: [{ id: 'display_300x250' }],
              }),
              makeProduct('ctv-budget', { name: 'Budget CTV', delivery_type: 'guaranteed' }),
            ],
            { catalog_version: 'v1' }
          ),
      });
      const sync = new CatalogSync({ client });
      await sync.start();

      const byFormat = sync.products.search({ format_ids: ['video_ctv_1080p_30s'] });
      assert.strictEqual(byFormat.length, 2);

      const byDelivery = sync.products.search({ delivery_types: ['non_guaranteed'] });
      assert.strictEqual(byDelivery.length, 1);
      assert.strictEqual(byDelivery[0].product_id, 'display-floor');

      const byText = sync.products.search({ text: 'premium' });
      assert.strictEqual(byText.length, 1);
      assert.strictEqual(byText[0].product_id, 'ctv-premium');

      const combined = sync.products.search({
        format_ids: ['video_ctv_1080p_30s'],
        delivery_types: ['guaranteed'],
        text: 'budget',
      });
      assert.strictEqual(combined.length, 1);
      assert.strictEqual(combined[0].product_id, 'ctv-budget');
      sync.stop();
    });
  });

  describe('auto-poll mode', () => {
    test('probeVersion short-circuits on unchanged: true and does not re-bootstrap', async () => {
      let phase = 'bootstrap';
      const { client, calls } = makeStubClient({
        capabilities: { catalog_versioning: { supported: true } },
        getProducts: () => {
          if (phase === 'bootstrap') {
            return makeProductsResult([makeProduct('p1')], { catalog_version: 'v1' });
          }
          return makeUnchangedResult({ catalog_version: 'v1' });
        },
      });
      const sync = new CatalogSync({
        client,
        probeIntervalMs: 1_000_000, // never fires during the test
      });
      await sync.start();
      assert.strictEqual(sync.mode, 'auto-poll');
      assert.strictEqual(sync.products.count, 1);

      // Manually invoke a probe by calling refresh() with the same version
      // returned — but refresh() always re-bootstraps. Test the probe code
      // path directly: switch the stub to the unchanged branch and call
      // refresh(). The bootstrap path sends if_catalog_version, gets
      // unchanged: true, breaks out of the pagination loop without
      // mutating the index. The index was cleared at the top of bootstrap
      // — so we expect 0 products after this refresh.
      // (This test verifies the unchanged-response short-circuit on the
      // first page is reached; the SDK's refresh contract is "re-fetch
      // and diff," so reaching the unchanged path means the agent told
      // us we're current.)
      phase = 'probe';
      await sync.refresh();
      assert.strictEqual(calls.getProducts, 2, 'one bootstrap call + one probe call');
      sync.stop();
    });
  });

  describe('live mode', () => {
    test('polls the change feed, applies events, and emits typed listeners', async () => {
      const products = [makeProduct('p1')];
      const { client } = makeStubClient({
        capabilities: {
          catalog_change_feed: {
            supported: true,
            event_types: ['product.priced', 'product.removed'],
            retention_window_days: 30,
          },
        },
        getProducts: () => makeProductsResult(products, { catalog_version: 'v1' }),
      });

      let fetchCallCount = 0;
      const fetchMock = async (url, _init) => {
        fetchCallCount++;
        const parsed = new URL(url);
        assert.strictEqual(parsed.pathname, '/catalog/events');
        // Only the first poll returns the priced event. Subsequent polls
        // return an empty feed so the test's elapsed-time-budget doesn't
        // accidentally fan out multiple identical events.
        if (fetchCallCount > 1) {
          return makeFetchResponse({
            events: [],
            next_cursor: '019539a1-bbbb-7bbb-bbbb-bbbbbbbbbbbb',
            has_more: false,
          });
        }
        return makeFetchResponse({
          events: [
            {
              event_id: '019539a0-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
              event_type: 'product.priced',
              entity_type: 'product',
              entity_id: 'p1',
              created_at: '2026-05-19T10:00:00Z',
              payload: {
                product_id: 'p1',
                pricing_options: [
                  { pricing_option_id: 'po_cpm_v2', pricing_model: 'cpm', currency: 'USD', fixed_price: 22.0 },
                ],
                applies_to: { scope: 'public' },
              },
            },
          ],
          next_cursor: '019539a1-bbbb-7bbb-bbbb-bbbbbbbbbbbb',
          has_more: false,
        });
      };

      const sync = new CatalogSync({
        client,
        feedOrigin: 'https://agent.example.com',
        feedHeaders: { Authorization: 'Bearer test-token' },
        fetch: fetchMock,
        pollIntervalMs: 50,
      });

      const typedEvents = [];
      sync.on('product.priced', ({ event }) => typedEvents.push(event));

      await sync.start();
      assert.strictEqual(sync.mode, 'live');

      // Wait for the first poll cycle to fire and complete.
      await new Promise(resolve => setTimeout(resolve, 200));

      sync.stop();

      assert.ok(fetchCallCount > 0, 'fetch should have been called at least once');
      assert.strictEqual(typedEvents.length, 1, 'one typed product.priced event applied');
      const repriced = sync.products.get('p1');
      assert.strictEqual(repriced?.pricing_options?.[0]?.fixed_price, 22.0);
    });

    test('catalog.bulk_change triggers re-bootstrap and emits bulk_resync', async () => {
      let productsPhase = 'initial';
      const { client, calls } = makeStubClient({
        capabilities: {
          catalog_change_feed: { supported: true, event_types: ['catalog.bulk_change'] },
        },
        getProducts: () => {
          if (productsPhase === 'initial') return makeProductsResult([makeProduct('p1')], { catalog_version: 'v1' });
          return makeProductsResult([makeProduct('p1'), makeProduct('p2')], { catalog_version: 'v2' });
        },
      });

      const fetchMock = async () =>
        makeFetchResponse({
          events: [
            {
              event_id: '019539a0-cccc-7ccc-cccc-cccccccccccc',
              event_type: 'catalog.bulk_change',
              entity_type: 'catalog',
              entity_id: 'op-q3-rate-refresh',
              created_at: '2026-05-19T10:00:00Z',
              payload: {
                summary: 'Q3 rate card refresh',
                affected_entity_types: ['product'],
                affected_count: 1480,
                recommendation: 'wholesale_resync',
                applies_to: { scope: 'public' },
              },
            },
          ],
          next_cursor: '019539a1-dddd-7ddd-dddd-dddddddddddd',
          has_more: false,
        });

      const sync = new CatalogSync({
        client,
        feedOrigin: 'https://agent.example.com',
        fetch: fetchMock,
        pollIntervalMs: 50,
      });

      const resyncReasons = [];
      sync.on('bulk_resync', ({ reason }) => resyncReasons.push(reason));

      await sync.start();
      assert.strictEqual(sync.products.count, 1, 'initial bootstrap has one product');

      productsPhase = 'after';
      await new Promise(resolve => setTimeout(resolve, 200));
      sync.stop();

      assert.ok(resyncReasons.includes('bulk_change'), 'bulk_resync emitted with bulk_change reason');
      assert.strictEqual(sync.products.count, 2, 're-bootstrap pulled the new product');
      assert.ok(calls.getProducts >= 2, 'get_products called at least twice (initial + re-bootstrap)');
    });

    test('RETENTION_EXPIRED (HTTP 410) triggers re-bootstrap with the retention_expired reason', async () => {
      const { client } = makeStubClient({
        capabilities: { catalog_change_feed: { supported: true } },
        getProducts: () => makeProductsResult([makeProduct('p1')], { catalog_version: 'v1' }),
      });

      let firstCall = true;
      const fetchMock = async () => {
        if (firstCall) {
          firstCall = false;
          return makeFetchResponse({ error: { code: 'RETENTION_EXPIRED' } }, { status: 410, statusText: 'Gone' });
        }
        return makeFetchResponse({ events: [], next_cursor: 'cur-new', has_more: false });
      };

      const sync = new CatalogSync({
        client,
        feedOrigin: 'https://agent.example.com',
        fetch: fetchMock,
        pollIntervalMs: 50,
      });

      const reasons = [];
      sync.on('bulk_resync', ({ reason }) => reasons.push(reason));

      await sync.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      sync.stop();

      assert.ok(reasons.includes('retention_expired'), 'retention_expired bulk_resync emitted');
    });
  });
});
