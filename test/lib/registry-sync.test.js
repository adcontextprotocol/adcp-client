const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { PropertyRegistry, RegistryClient, RegistrySync } = require('../../dist/lib/registry/index.js');

// Helper to mock global fetch
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, ...args) => {
    const response = await handler(url, ...args);
    if (response.status === 404 && String(url).includes('/api/properties/registry')) {
      return new Response(JSON.stringify({ properties: [], stats: {} }), { status: 200 });
    }
    return response;
  };
  return () => {
    globalThis.fetch = original;
  };
}

// Shared test fixtures
const AGENT_1 = {
  url: 'https://ads.streamhaus.example.com',
  name: 'StreamHaus',
  type: 'sales',
  inventory_profile: {
    channels: ['ctv', 'olv'],
    property_types: ['ctv_app'],
    markets: ['US', 'GB'],
    categories: ['IAB-7'],
    category_taxonomy: 'iab_content_3.0',
    tags: ['premium'],
    delivery_types: ['guaranteed'],
    property_count: 42,
    publisher_count: 3,
    has_tmp: true,
  },
  match: { score: 0.92, matched_filters: ['channels'] },
};

const AGENT_2 = {
  url: 'https://ads.displayco.example.com',
  name: 'DisplayCo',
  type: 'creative',
  inventory_profile: {
    channels: ['display'],
    property_types: ['website'],
    markets: ['US'],
    categories: ['IAB-1'],
    category_taxonomy: 'iab_content_3.0',
    tags: [],
    delivery_types: ['non_guaranteed'],
    property_count: 200,
    publisher_count: 10,
    has_tmp: false,
  },
  match: { score: 0.5, matched_filters: [] },
};

const EMPTY_FEED = { events: [], cursor: 'cursor-001', has_more: false };

const BRAND_CHAIN = [
  {
    canonical_id: 'wpp-spain.com',
    canonical_domain: 'wpp-spain.com',
    brand_name: 'WPP Spain',
    keller_type: 'sub_brand',
    parent_brand: 'brand_wpp',
    house_domain: 'omnicom.com',
    source: 'brand_json',
  },
  {
    canonical_id: 'wpp.com',
    canonical_domain: 'wpp.com',
    brand_name: 'WPP',
    keller_type: 'sub_brand',
    parent_brand: 'brand_omnicom',
    house_domain: 'omnicom.com',
    source: 'brand_json',
  },
  {
    canonical_id: 'omnicom.com',
    canonical_domain: 'omnicom.com',
    brand_name: 'Omnicom',
    keller_type: 'master',
    source: 'brand_json',
  },
];

const PROPERTY_PAYLOAD = {
  property_rid: 'rid-alpha',
  publisher_domain: 'ExamplePub.com',
  identifiers: [{ type: 'domain', value: 'examplepub.com' }],
  classification: 'property',
  source: 'authoritative',
  property: {
    publisher_domain: 'ExamplePub.com',
    source: 'adagents_json',
    authorized_agents: [],
    properties: [
      {
        id: 'homepage',
        type: 'website',
        name: 'ExamplePub Homepage',
        identifiers: [{ type: 'domain', value: 'examplepub.com' }],
      },
    ],
    verified: true,
  },
};

function makeSearchResponse(results, { has_more = false, cursor = null } = {}) {
  return { results, has_more, cursor };
}

function makeFeedResponse(events, { has_more = false, cursor = 'cursor-001', cursor_expired = false } = {}) {
  return { events, has_more, cursor, cursor_expired: cursor_expired || undefined };
}

function makeEvent(type, entity_id, payload = {}) {
  return {
    event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event_type: type,
    entity_type: type.split('.')[0],
    entity_id,
    payload,
    actor: 'test',
    created_at: new Date().toISOString(),
  };
}

describe('RegistrySync', () => {
  let restore;

  afterEach(() => {
    if (restore) restore();
  });

  // ============ Bootstrap ============

  describe('bootstrap', () => {
    test('loads agents from search and initializes feed cursor', async () => {
      const calls = [];
      restore = mockFetch(async url => {
        calls.push(url);
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1, AGENT_2])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();

      assert.strictEqual(sync.state, 'syncing');
      assert.strictEqual(sync.getStats().agents, 2);
      assert.strictEqual(sync.getCursor(), 'cursor-001');

      const agent = sync.getAgent('https://ads.streamhaus.example.com');
      assert.strictEqual(agent.name, 'StreamHaus');

      sync.stop();
    });

    test('does not bootstrap aggregate property registry rows as properties', async () => {
      let propertiesCallCount = 0;
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/api/properties/registry')) {
          propertiesCallCount++;
          assert.match(url, /limit=200/);
          assert.match(url, /offset=0/);
          return new Response(
            JSON.stringify({
              properties: [
                {
                  domain: 'Listed.example',
                  source: 'adagents_json',
                  property_count: 1,
                  agent_count: 0,
                  verified: true,
                  properties: [{ id: 'homepage', type: 'website', name: 'Listed Homepage' }],
                },
              ],
              stats: { total: 1 },
            }),
            { status: 200 }
          );
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const properties = sync.getPropertiesForDomain('listed.example');
      assert.strictEqual(propertiesCallCount, 0);
      assert.strictEqual(properties.length, 0);
      assert.strictEqual(sync.getProperty('listed.example'), undefined);
      assert.strictEqual(sync.getStats().properties, 0);
    });

    test('paginates search until has_more is false', async () => {
      let searchCallCount = 0;
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          searchCallCount++;
          if (searchCallCount === 1) {
            return new Response(JSON.stringify(makeSearchResponse([AGENT_1], { has_more: true, cursor: 'page2' })), {
              status: 200,
            });
          }
          assert.ok(url.includes('cursor=page2'));
          return new Response(JSON.stringify(makeSearchResponse([AGENT_2])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();

      assert.strictEqual(searchCallCount, 2);
      assert.strictEqual(sync.getStats().agents, 2);
      sync.stop();
    });

    test('emits bootstrap event with counts', async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });

      const bootstrapEvents = [];
      sync.on('bootstrap', data => bootstrapEvents.push(data));

      await sync.start();

      assert.strictEqual(bootstrapEvents.length, 1);
      assert.strictEqual(bootstrapEvents[0].agentCount, 1);
      sync.stop();
    });

    test('transitions state: idle -> bootstrapping -> syncing', async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });

      const transitions = [];
      sync.on('stateChange', data => transitions.push(data));

      assert.strictEqual(sync.state, 'idle');
      await sync.start();

      assert.deepStrictEqual(transitions, [
        { from: 'idle', to: 'bootstrapping' },
        { from: 'bootstrapping', to: 'syncing' },
      ]);
      sync.stop();
    });

    test('emits error and throws on bootstrap failure', async () => {
      restore = mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const errors = [];
      const emittedErrors = [];
      const sync = new RegistrySync({ client, onError: err => errors.push(err) });
      sync.on('error', data => emittedErrors.push(data));

      await assert.rejects(() => sync.start(), { message: /500/ });
      assert.strictEqual(sync.state, 'error');
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(emittedErrors.length, 1);
    });
  });

  // ============ Agent Lookups ============

  describe('agent lookups', () => {
    let sync;

    beforeEach(async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1, AGENT_2])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();
    });

    test('getAgent returns agent by URL', () => {
      const agent = sync.getAgent('https://ads.streamhaus.example.com');
      assert.strictEqual(agent.name, 'StreamHaus');
    });

    test('getAgent returns undefined for unknown URL', () => {
      assert.strictEqual(sync.getAgent('https://unknown.example.com'), undefined);
    });

    test('getAgents returns all agents', () => {
      assert.strictEqual(sync.getAgents().length, 2);
    });

    test('findAgents filters by type', () => {
      const sales = sync.findAgents({ type: 'sales' });
      assert.strictEqual(sales.length, 1);
      assert.strictEqual(sales[0].name, 'StreamHaus');
    });

    test('findAgents filters by channels (OR within dimension)', () => {
      const ctv = sync.findAgents({ channels: ['ctv'] });
      assert.strictEqual(ctv.length, 1);
      assert.strictEqual(ctv[0].name, 'StreamHaus');

      const both = sync.findAgents({ channels: ['ctv', 'display'] });
      assert.strictEqual(both.length, 2);
    });

    test('findAgents filters by markets', () => {
      const gb = sync.findAgents({ markets: ['GB'] });
      assert.strictEqual(gb.length, 1);
      assert.strictEqual(gb[0].name, 'StreamHaus');
    });

    test('findAgents filters by has_tmp', () => {
      const tmp = sync.findAgents({ has_tmp: true });
      assert.strictEqual(tmp.length, 1);
      assert.strictEqual(tmp[0].name, 'StreamHaus');
    });

    test('findAgents uses AND across dimensions', () => {
      const result = sync.findAgents({ channels: ['ctv'], markets: ['US'] });
      assert.strictEqual(result.length, 1);

      const empty = sync.findAgents({ channels: ['ctv'], markets: ['DE'] });
      assert.strictEqual(empty.length, 0);
    });

    test('findAgents filters by min_properties', () => {
      const big = sync.findAgents({ min_properties: 100 });
      assert.strictEqual(big.length, 1);
      assert.strictEqual(big[0].name, 'DisplayCo');
    });
  });

  // ============ Event Application ============

  describe('event application', () => {
    let sync;

    beforeEach(async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();
    });

    test('authorization.granted adds to both indexes', async () => {
      // Simulate a poll with an authorization event
      const authEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([authEvent], { cursor: 'cursor-002' })), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncWithAuth = new RegistrySync({ client });
      await syncWithAuth.start();
      syncWithAuth.stop();

      assert.ok(syncWithAuth.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncWithAuth.getAuthorizationsForDomain('nytimes.com').length, 1);
      assert.strictEqual(syncWithAuth.getAuthorizationsForAgent('https://ads.streamhaus.example.com').length, 1);
    });

    test('authorization.modified refreshes existing authorization details', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
        property_ids: ['old-property'],
      });
      const modifyEvent = makeEvent('authorization.modified', 'auth-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'scoped',
        property_ids: ['new-property'],
        effective_until: '2026-12-31T00:00:00.000Z',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, modifyEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const domainEntries = syncInstance.getAuthorizationsForDomain('nytimes.com');
      const agentEntries = syncInstance.getAuthorizationsForAgent('https://ads.streamhaus.example.com');
      assert.strictEqual(domainEntries.length, 1);
      assert.strictEqual(agentEntries.length, 1);
      assert.strictEqual(domainEntries[0].authorization_type, 'scoped');
      assert.deepStrictEqual(domainEntries[0].property_ids, ['new-property']);
      assert.strictEqual(agentEntries[0].effective_until, '2026-12-31T00:00:00.000Z');
    });

    test('authorization.granted maps legacy effective_to to effective_until', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-legacy', {
        id: 'auth-legacy',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
        effective_to: '2026-12-31T00:00:00.000Z',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const [entry] = syncInstance.getAuthorizationsForDomain('nytimes.com');
      assert.strictEqual(entry.effective_to, '2026-12-31T00:00:00.000Z');
      assert.strictEqual(entry.effective_until, '2026-12-31T00:00:00.000Z');
    });

    test('authorization.modified without authorization_type replaces row by id', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
        property_ids: ['old-property'],
      });
      const modifyEvent = makeEvent('authorization.modified', 'auth-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        property_ids: ['new-property'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, modifyEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const domainEntries = syncInstance.getAuthorizationsForDomain('nytimes.com');
      assert.strictEqual(domainEntries.length, 1);
      assert.strictEqual(domainEntries[0].authorization_type, undefined);
      assert.deepStrictEqual(domainEntries[0].property_ids, ['new-property']);
    });

    test('authorization.modified without id or authorization_type is ignored', async () => {
      const grantA = makeEvent('authorization.granted', 'auth-row-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
        property_ids: ['property-a'],
      });
      const grantB = makeEvent('authorization.granted', 'auth-row-2', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'scoped',
        property_ids: ['property-b'],
      });
      const modifyB = makeEvent('authorization.modified', 'auth-row-2', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        property_ids: ['property-b-updated'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantA, grantB, modifyB], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const domainEntries = syncInstance.getAuthorizationsForDomain('nytimes.com');
      assert.strictEqual(domainEntries.length, 2);
      assert.deepStrictEqual(
        domainEntries.map(entry => [entry.id, entry.authorization_type, entry.property_ids]).sort(),
        [
          [undefined, 'full', ['property-a']],
          [undefined, 'scoped', ['property-b']],
        ]
      );
    });

    test('authorization.modified with unknown id replaces matching idless authorization', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-without-id', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'property_ids',
        property_ids: ['old-property'],
      });
      const modifyEvent = makeEvent('authorization.modified', 'auth-row-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'property_ids',
        property_ids: ['new-property'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, modifyEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const domainEntries = syncInstance.getAuthorizationsForDomain('nytimes.com');
      assert.strictEqual(domainEntries.length, 1);
      assert.strictEqual(domainEntries[0].id, 'auth-row-1');
      assert.deepStrictEqual(domainEntries[0].property_ids, ['new-property']);
    });

    test('authorization.revoked removes from both indexes', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });
      const revokeEvent = makeEvent('authorization.revoked', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, revokeEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.ok(!syncInstance.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncInstance.getAuthorizationsForDomain('nytimes.com').length, 0);
    });

    test('authorization.revoked with unknown id removes matching idless authorization', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-without-id', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });
      const revokeEvent = makeEvent('authorization.revoked', 'auth-row-1', {
        id: 'auth-row-1',
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, revokeEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.ok(!syncInstance.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncInstance.getAuthorizationsForDomain('nytimes.com').length, 0);
      assert.strictEqual(syncInstance.getAuthorizationsForAgent('https://ads.streamhaus.example.com').length, 0);
    });

    test('authorization indexes normalize publisher domain casing', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'NYTimes.com',
        authorization_type: 'full',
      });
      const revokeEvent = makeEvent('authorization.revoked', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, revokeEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.ok(!syncInstance.isAuthorized('https://ads.streamhaus.example.com', 'NYTimes.com'));
      assert.strictEqual(syncInstance.getAuthorizationsForDomain('NYTimes.com').length, 0);
      assert.strictEqual(syncInstance.getAuthorizationsForDomain('nytimes.com').length, 0);
    });

    test('authorization indexes use canonical agent urls', async () => {
      const grantEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ADS.streamhaus.example.com/agent-card',
        agent_url_canonical: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });
      const revokeEvent = makeEvent('authorization.revoked', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        agent_url_canonical: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([grantEvent, revokeEvent], { cursor: 'cursor-003' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.ok(!syncInstance.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncInstance.getAuthorizationsForAgent('https://ads.streamhaus.example.com').length, 0);
    });

    test('agent.discovered adds to agent index', async () => {
      const discoverEvent = makeEvent('agent.discovered', 'https://new.agent.example.com', {
        name: 'New Agent',
        type: 'creative',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([discoverEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getStats().agents, 2);
      const newAgent = syncInstance.getAgent('https://new.agent.example.com');
      assert.strictEqual(newAgent.name, 'New Agent');
      assert.strictEqual(newAgent.type, 'creative');
    });

    test('agent.removed deletes from agent index', async () => {
      const authEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });
      const removeEvent = makeEvent('agent.removed', 'https://ads.streamhaus.example.com', {});

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([authEvent, removeEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getAgent('https://ads.streamhaus.example.com'), undefined);
      assert.strictEqual(syncInstance.getStats().agents, 0);
      assert.ok(!syncInstance.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncInstance.getAuthorizationsForDomain('nytimes.com').length, 0);
      assert.strictEqual(syncInstance.getAuthorizationsForAgent('https://ads.streamhaus.example.com').length, 0);
    });

    test('agent.profile_updated updates existing agent', async () => {
      const updateEvent = makeEvent('agent.profile_updated', 'https://ads.streamhaus.example.com', {
        inventory_profile: {
          ...AGENT_1.inventory_profile,
          property_count: 100,
          channels: ['ctv', 'olv', 'display'],
        },
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([updateEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const agent = syncInstance.getAgent('https://ads.streamhaus.example.com');
      assert.strictEqual(agent.inventory_profile.property_count, 100);
      assert.deepStrictEqual(agent.inventory_profile.channels, ['ctv', 'olv', 'display']);
    });

    test('skips authorization.granted with missing authorization_type', async () => {
      const badAuth = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
        // missing authorization_type
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([badAuth], { cursor: 'cursor-002' })), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getStats().authorizations, 0);
    });

    test('skips authorization.granted with empty identity fields', async () => {
      const emptyAgent = makeEvent('authorization.granted', 'auth-empty-agent', {
        agent_url: '',
        publisher_domain: 'pub.com',
        authorization_type: 'full',
      });
      const emptyDomain = makeEvent('authorization.granted', 'auth-empty-domain', {
        agent_url: 'https://ads.example.com',
        publisher_domain: ' ',
        authorization_type: 'full',
      });
      const emptyType = makeEvent('authorization.granted', 'auth-empty-type', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
        authorization_type: '',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([emptyAgent, emptyDomain, emptyType], { cursor: 'cursor-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getStats().authorizations, 0);
    });

    test('brand.hierarchy_updated indexes ordered ancestor domains and resolved chain', async () => {
      const hierarchyEvent = makeEvent('brand.hierarchy_updated', 'WPP-Spain.com', {
        canonical_domain: 'wpp-spain.com',
        chain: BRAND_CHAIN,
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([hierarchyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(syncInstance.getAncestors('wpp-spain.com'), ['wpp-spain.com', 'wpp.com', 'omnicom.com']);
      assert.deepStrictEqual(syncInstance.getAncestors('WPP-Spain.com'), ['wpp-spain.com', 'wpp.com', 'omnicom.com']);
      assert.strictEqual(syncInstance.getBrandHierarchy('wpp-spain.com')[1].brand_name, 'WPP');
      assert.strictEqual(syncInstance.getStats().brandHierarchies, 1);

      const hierarchy = syncInstance.getBrandHierarchy('wpp-spain.com');
      hierarchy[0].brand_name = 'Mutated';
      assert.strictEqual(syncInstance.getBrandHierarchy('wpp-spain.com')[0].brand_name, 'WPP Spain');
    });

    test('brand.hierarchy_updated accepts compact domain-only chains', async () => {
      const hierarchyEvent = makeEvent('brand.hierarchy_updated', 'wpp-spain.com', {
        domains: ['wpp-spain.com', 'wpp.com', 'omnicom.com'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([hierarchyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(syncInstance.getAncestors('wpp-spain.com'), ['wpp-spain.com', 'wpp.com', 'omnicom.com']);
      assert.deepStrictEqual(syncInstance.getBrandHierarchy('wpp-spain.com'), []);
    });

    test('brand.deleted removes hierarchy entries', async () => {
      const hierarchyEvent = makeEvent('brand.hierarchy_updated', 'wpp-spain.com', {
        chain: BRAND_CHAIN,
      });
      const deleteEvent = makeEvent('brand.deleted', 'wpp-spain.com', {
        canonical_domain: 'wpp-spain.com',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([hierarchyEvent, deleteEvent], { cursor: 'cursor-002' })),
            {
              status: 200,
            }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(syncInstance.getAncestors('wpp-spain.com'), []);
      assert.deepStrictEqual(syncInstance.getBrandHierarchy('wpp-spain.com'), []);
    });

    test('brand.deleted with only internal entity id removes all hierarchy aliases', async () => {
      const hierarchyEvent = makeEvent('brand.hierarchy_updated', 'brand-row-1', {
        canonical_domain: 'wpp-spain.com',
        chain: BRAND_CHAIN,
      });
      const deleteEvent = makeEvent('brand.deleted', 'brand-row-1', {});

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([hierarchyEvent, deleteEvent], { cursor: 'cursor-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(syncInstance.getAncestors('brand-row-1'), []);
      assert.deepStrictEqual(syncInstance.getAncestors('wpp-spain.com'), []);
      assert.deepStrictEqual(syncInstance.getBrandHierarchy('wpp-spain.com'), []);
    });

    test('property.created indexes by property_rid and publisher domain', async () => {
      const propertyEvent = makeEvent('property.created', 'rid-alpha', PROPERTY_PAYLOAD);

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([propertyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const property = syncInstance.getProperty('rid-alpha');
      assert.ok(property);
      assert.strictEqual(property.property_rid, 'rid-alpha');
      assert.strictEqual(property.publisher_domain, 'ExamplePub.com');
      assert.strictEqual(syncInstance.getPropertiesForDomain('examplepub.com').length, 1);
      assert.strictEqual(syncInstance.getStats().properties, 1);

      property.publisher_domain = 'mutated.example';
      assert.strictEqual(syncInstance.getProperty('rid-alpha').publisher_domain, 'ExamplePub.com');
    });

    test('property.created without explicit registry rid is ignored', async () => {
      const propertyEvent = makeEvent('property.created', 'examplepub.com', {
        publisher_domain: 'ExamplePub.com',
        identifiers: [{ type: 'domain', value: 'examplepub.com' }],
        classification: 'property',
        source: 'authoritative',
        property: PROPERTY_PAYLOAD.property,
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([propertyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getProperty('examplepub.com'), undefined);
      assert.deepStrictEqual(syncInstance.getPropertiesForDomain('examplepub.com'), []);
      assert.strictEqual(syncInstance.getStats().properties, 0);
    });

    test('property.updated merges over existing property by rid', async () => {
      const createEvent = makeEvent('property.created', 'rid-alpha', PROPERTY_PAYLOAD);
      const updateEvent = makeEvent('property.updated', 'rid-alpha', {
        property_rid: 'rid-alpha',
        publisher_domain: 'examplepub.com',
        identifiers: [{ type: 'subdomain', value: 'www.examplepub.com' }],
        changed_fields: ['identifiers'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([createEvent, updateEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const property = syncInstance.getProperty('rid-alpha');
      assert.deepStrictEqual(property.identifiers, [{ type: 'subdomain', value: 'www.examplepub.com' }]);
      assert.strictEqual(property.property.properties[0].id, 'homepage');
      assert.strictEqual(syncInstance.getPropertiesForDomain('ExamplePub.com').length, 1);
    });

    test('property.updated reindexes changed publisher domain from nested property payload', async () => {
      const createEvent = makeEvent('property.created', 'rid-alpha', {
        ...PROPERTY_PAYLOAD,
        publisher_domain: 'old.example',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'old.example',
        },
      });
      const updateEvent = makeEvent('property.updated', 'rid-alpha', {
        property_rid: 'rid-alpha',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'new.example',
        },
        changed_fields: ['publisher_domain'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([createEvent, updateEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getProperty('rid-alpha').publisher_domain, 'new.example');
      assert.deepStrictEqual(syncInstance.getPropertiesForDomain('old.example'), []);
      assert.strictEqual(syncInstance.getPropertiesForDomain('new.example').length, 1);
    });

    test('property.merged resolves alias rid to canonical rid', async () => {
      const aliasEvent = makeEvent('property.created', 'rid-alias', {
        ...PROPERTY_PAYLOAD,
        property_rid: 'rid-alias',
      });
      const canonicalEvent = makeEvent('property.created', 'rid-canonical', {
        ...PROPERTY_PAYLOAD,
        property_rid: 'rid-canonical',
        identifiers: [{ type: 'domain', value: 'canonical.examplepub.com' }],
      });
      const mergeEvent = makeEvent('property.merged', 'rid-alias', {
        alias_rid: 'rid-alias',
        canonical_rid: 'rid-canonical',
        evidence: 'adagents_json',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([aliasEvent, canonicalEvent, mergeEvent], { cursor: 'cursor-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getProperty('rid-alias').property_rid, 'rid-canonical');
      assert.deepStrictEqual(syncInstance.getProperty('rid-canonical').identifiers, [
        { type: 'domain', value: 'canonical.examplepub.com' },
      ]);
      assert.strictEqual(syncInstance.getPropertiesForDomain('examplepub.com').length, 1);
      assert.strictEqual(syncInstance.getStats().properties, 1);
    });

    test('property.merged records aliases before either property is indexed', async () => {
      const mergeEvent = makeEvent('property.merged', 'rid-alias', {
        alias_rid: 'rid-alias',
        canonical_rid: 'rid-canonical',
        evidence: 'manual_review',
      });
      const aliasCreateEvent = makeEvent('property.created', 'rid-alias', {
        ...PROPERTY_PAYLOAD,
        property_rid: 'rid-alias',
        publisher_domain: 'alias.example',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'alias.example',
        },
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([mergeEvent, aliasCreateEvent], { cursor: 'cursor-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getProperty('rid-alias').property_rid, 'rid-canonical');
      assert.strictEqual(syncInstance.getProperty('rid-canonical').publisher_domain, 'alias.example');
      assert.strictEqual(syncInstance.getPropertiesForDomain('alias.example').length, 1);
      assert.strictEqual(syncInstance.getStats().properties, 1);
    });

    test('property.merged indexes canonical facts from payload when no entries exist', async () => {
      const mergeEvent = makeEvent('property.merged', 'rid-alias', {
        alias_rid: 'rid-alias',
        canonical_rid: 'rid-canonical',
        publisher_domain: 'canonical.example',
        identifiers: [{ type: 'domain', value: 'canonical.example' }],
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'canonical.example',
        },
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([mergeEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.strictEqual(syncInstance.getProperty('rid-alias').property_rid, 'rid-canonical');
      assert.deepStrictEqual(syncInstance.getProperty('rid-canonical').identifiers, [
        { type: 'domain', value: 'canonical.example' },
      ]);
      assert.strictEqual(syncInstance.getPropertiesForDomain('canonical.example').length, 1);
      assert.strictEqual(syncInstance.getStats().properties, 1);
    });

    test('property.merged does not synthesize a domain-keyed placeholder', async () => {
      const mergeEvent = makeEvent('property.merged', 'rid-alias', {
        alias_rid: 'rid-alias',
        canonical_rid: 'rid-canonical',
        publisher_domain: 'canonical.example',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'canonical.example',
        },
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([mergeEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const properties = syncInstance.getPropertiesForDomain('canonical.example');
      assert.strictEqual(properties.length, 1);
      assert.strictEqual(properties[0].property_rid, 'rid-canonical');
      assert.strictEqual(syncInstance.getProperty('canonical.example'), undefined);
      assert.strictEqual(syncInstance.getStats().properties, 1);
    });

    test('property.merged cleans alias domain and later alias updates apply to canonical rid', async () => {
      const aliasEvent = makeEvent('property.created', 'rid-alias', {
        ...PROPERTY_PAYLOAD,
        property_rid: 'rid-alias',
        publisher_domain: 'alias.example',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'alias.example',
        },
      });
      const canonicalEvent = makeEvent('property.created', 'rid-canonical', {
        ...PROPERTY_PAYLOAD,
        property_rid: 'rid-canonical',
        publisher_domain: 'canonical.example',
        property: {
          ...PROPERTY_PAYLOAD.property,
          publisher_domain: 'canonical.example',
        },
      });
      const mergeEvent = makeEvent('property.merged', 'rid-alias', {
        alias_rid: 'rid-alias',
        canonical_rid: 'rid-canonical',
        evidence: 'adagents_json',
      });
      const aliasUpdateEvent = makeEvent('property.updated', 'rid-alias', {
        property_rid: 'rid-alias',
        publisher_domain: 'canonical.example',
        last_resolved_at: '2026-01-01T00:00:00.000Z',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(
              makeFeedResponse([aliasEvent, canonicalEvent, mergeEvent, aliasUpdateEvent], { cursor: 'cursor-002' })
            ),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(syncInstance.getPropertiesForDomain('alias.example'), []);
      assert.strictEqual(syncInstance.getPropertiesForDomain('canonical.example').length, 1);
      assert.strictEqual(syncInstance.getProperty('rid-alias').property_rid, 'rid-canonical');
      assert.strictEqual(syncInstance.getProperty('rid-canonical').last_resolved_at, '2026-01-01T00:00:00.000Z');
      assert.strictEqual(syncInstance.getStats().properties, 1);
    });

    test('property.stale and property.reactivated retain existing property data', async () => {
      const createEvent = makeEvent('property.created', 'rid-alpha', PROPERTY_PAYLOAD);
      const staleEvent = makeEvent('property.stale', 'rid-alpha', {
        property_rid: 'rid-alpha',
        last_resolved_at: '2026-01-02T00:00:00.000Z',
        reason: 'adagents_missing',
      });
      const reactivatedEvent = makeEvent('property.reactivated', 'rid-alpha', {
        property_rid: 'rid-alpha',
        reactivated_at: '2026-01-03T00:00:00.000Z',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([createEvent, staleEvent, reactivatedEvent], { cursor: 'cursor-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({ client });
      await syncInstance.start();
      syncInstance.stop();

      const property = syncInstance.getProperty('rid-alpha');
      assert.strictEqual(property.publisher_domain, 'ExamplePub.com');
      assert.strictEqual(property.property.properties[0].id, 'homepage');
      assert.strictEqual(property.last_resolved_at, '2026-01-02T00:00:00.000Z');
      assert.strictEqual(property.reason, 'adagents_missing');
      assert.strictEqual(property.reactivated_at, '2026-01-03T00:00:00.000Z');
      assert.strictEqual(syncInstance.getPropertiesForDomain('examplepub.com').length, 1);
    });

    test('PropertyRegistry exposes synchronous property accessors', async () => {
      const propertyEvent = makeEvent('property.created', 'rid-alpha', PROPERTY_PAYLOAD);

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([propertyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const registry = new PropertyRegistry({ registryClient: new RegistryClient({ apiKey: 'sk_test' }) });
      await registry.start();
      registry.stop();

      assert.strictEqual(registry.getProperty('rid-alpha').publisher_domain, 'ExamplePub.com');
      assert.strictEqual(registry.getPropertiesForDomain('examplepub.com').length, 1);
      assert.strictEqual(registry.getStats().properties, 1);
    });

    test('emits ignoredEvent for unindexed collection and publisher families', async () => {
      const ignoredEvents = [
        makeEvent('collection.created', 'collection-rid-1', {
          collection_rid: 'collection-rid-1',
          publisher_domain: 'examplepub.com',
        }),
        makeEvent('collection.updated', 'collection-rid-1', {
          collection_rid: 'collection-rid-1',
          publisher_domain: 'examplepub.com',
        }),
        makeEvent('collection.merged', 'collection-rid-1', {
          alias_rid: 'collection-rid-1',
          canonical_rid: 'collection-rid-2',
        }),
        makeEvent('collection.removed', 'collection-rid-1', {
          collection_rid: 'collection-rid-1',
        }),
        makeEvent('publisher.adagents_changed', 'examplepub.com', {
          publisher_domain: 'examplepub.com',
        }),
        makeEvent('publisher.adagents_discovered', 'examplepub.com', {
          publisher_domain: 'examplepub.com',
        }),
        makeEvent('future.family_changed', 'future-rid-1', {
          entity_rid: 'future-rid-1',
        }),
      ];
      const ignored = [];
      const handlerIgnored = [];

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse(ignoredEvents, { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const syncInstance = new RegistrySync({
        client,
        onIgnoredEvent: (event, reason) => handlerIgnored.push({ event, reason }),
      });
      syncInstance.on('ignoredEvent', data => ignored.push(data));
      await syncInstance.start();
      syncInstance.stop();

      assert.deepStrictEqual(
        ignored.map(item => item.event.event_type),
        ignoredEvents.map(event => event.event_type)
      );
      assert.strictEqual(handlerIgnored.length, ignoredEvents.length);
      for (const item of ignored.slice(0, 4)) assert.match(item.reason, /collection\.\*/);
      for (const item of ignored.slice(4, 6)) assert.match(item.reason, /publisher\.\*/);
      assert.match(ignored[6].reason, /unknown or unsupported/);
    });
  });

  // ============ Lifecycle ============

  describe('lifecycle', () => {
    test('stop prevents further polling', async () => {
      let fetchCount = 0;
      restore = mockFetch(async url => {
        fetchCount++;
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, pollIntervalMs: 50 });
      await sync.start();

      const countAfterStart = fetchCount;
      sync.stop();

      // Wait longer than poll interval
      await new Promise(r => setTimeout(r, 150));
      assert.strictEqual(fetchCount, countAfterStart);
    });

    test('getStats returns correct counts', async () => {
      const authEvent = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.streamhaus.example.com',
        publisher_domain: 'nytimes.com',
        authorization_type: 'full',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1, AGENT_2])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([authEvent], { cursor: 'cursor-002' })), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const stats = sync.getStats();
      assert.strictEqual(stats.agents, 2);
      assert.strictEqual(stats.authorizations, 1);
    });

    test('reset clears state and stops polling', async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      assert.strictEqual(sync.getStats().agents, 1);

      await sync.reset();
      assert.strictEqual(sync.state, 'idle');
      assert.strictEqual(sync.getStats().agents, 0);
      assert.strictEqual(sync.getCursor(), null);
    });

    test('disabled agent index skips agent loading', async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          assert.fail('should not call search when agents index disabled');
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, indexes: { agents: false } });
      await sync.start();
      sync.stop();

      assert.strictEqual(sync.getStats().agents, 0);
    });

    test('disabled brand hierarchy index skips hierarchy events', async () => {
      const hierarchyEvent = makeEvent('brand.hierarchy_updated', 'wpp-spain.com', {
        chain: BRAND_CHAIN,
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([hierarchyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, indexes: { brandHierarchies: false } });
      await sync.start();
      sync.stop();

      assert.deepStrictEqual(sync.getAncestors('wpp-spain.com'), []);
      assert.strictEqual(sync.getStats().brandHierarchies, 0);
    });

    test('disabled property index skips property events', async () => {
      const propertyEvent = makeEvent('property.created', 'rid-alpha', PROPERTY_PAYLOAD);

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([propertyEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, indexes: { properties: false } });
      await sync.start();
      sync.stop();

      assert.strictEqual(sync.getProperty('rid-alpha'), undefined);
      assert.strictEqual(sync.getPropertiesForDomain('examplepub.com').length, 0);
      assert.strictEqual(sync.getStats().properties, 0);
    });
  });

  // ============ Feed Pagination & Cursor Expiration ============

  describe('feed pagination and cursor expiration', () => {
    test('drains has_more pages during bootstrap', async () => {
      let feedCallCount = 0;
      const event1 = makeEvent('agent.discovered', 'https://agent1.example.com', { name: 'Agent1' });
      const event2 = makeEvent('agent.discovered', 'https://agent2.example.com', { name: 'Agent2' });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          feedCallCount++;
          if (feedCallCount === 1) {
            return new Response(
              JSON.stringify(makeFeedResponse([event1], { has_more: true, cursor: 'cursor-page2' })),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify(makeFeedResponse([event2], { cursor: 'cursor-final' })), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      // Bootstrap drain always uses the polling feed regardless of transport;
      // pin 'poll' so the default 'auto' SSE attempt doesn't add a feed call.
      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, transport: 'poll' });
      await sync.start();
      sync.stop();

      assert.strictEqual(feedCallCount, 2);
      assert.strictEqual(sync.getStats().agents, 2);
      assert.strictEqual(sync.getCursor(), 'cursor-final');
    });

    test('cursor_expired triggers re-bootstrap with fresh data', async () => {
      let phase = 'initial';
      const AGENT_NEW = { ...AGENT_2, url: 'https://new.agent.example.com', name: 'NewAgent' };

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          if (phase === 'initial') {
            return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
          }
          // After re-bootstrap, return different agent
          return new Response(JSON.stringify(makeSearchResponse([AGENT_NEW])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          if (phase === 'expired') {
            // First poll after bootstrap returns cursor_expired
            phase = 'rebootstrap';
            return new Response(JSON.stringify(makeFeedResponse([], { cursor_expired: true })), { status: 200 });
          }
          return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client, pollIntervalMs: 20 });

      const bootstrapEvents = [];
      sync.on('bootstrap', data => bootstrapEvents.push(data));
      sync.on('error', () => {}); // prevent unhandled error

      await sync.start();
      assert.strictEqual(sync.getStats().agents, 1);
      assert.ok(sync.getAgent('https://ads.streamhaus.example.com'));

      // Trigger cursor_expired on next poll
      phase = 'expired';

      // Wait for poll + re-bootstrap
      await new Promise(r => setTimeout(r, 200));
      sync.stop();

      // Should have re-bootstrapped with new data
      assert.strictEqual(bootstrapEvents.length, 2);
      assert.ok(sync.getAgent('https://new.agent.example.com'));
      // Old agent should be gone (indexes were cleared)
      assert.strictEqual(sync.getAgent('https://ads.streamhaus.example.com'), undefined);
    });

    test('multiple auth types for same agent+domain are preserved', async () => {
      const agentUrl = 'https://ads.example.com';
      const domain = 'pub.com';
      const compositeEntityId = `${agentUrl}:${domain}`;
      const fullAuth = makeEvent('authorization.granted', compositeEntityId, {
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'full',
      });
      const propertyAuth = makeEvent('authorization.granted', compositeEntityId, {
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
        property_ids: ['prop_1'],
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([fullAuth, propertyAuth], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      assert.strictEqual(sync.getAuthorizationsForDomain('pub.com').length, 2);
      assert.strictEqual(sync.getAuthorizationsForAgent('https://ads.example.com').length, 2);
    });

    test('revoking specific auth type preserves other types', async () => {
      const agentUrl = 'https://ads.example.com';
      const domain = 'pub.com';
      const compositeEntityId = `${agentUrl}:${domain}`;
      const fullAuth = makeEvent('authorization.granted', 'auth-1', {
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'full',
      });
      const propertyAuth = makeEvent('authorization.granted', 'auth-2', {
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
      });
      const revokeProperty = makeEvent('authorization.revoked', compositeEntityId, {
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(
            JSON.stringify(makeFeedResponse([fullAuth, propertyAuth, revokeProperty], { cursor: 'c-002' })),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const remaining = sync.getAuthorizationsForDomain('pub.com');
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].authorization_type, 'full');
    });

    test('revoking by payload id preserves same-type rows', async () => {
      const agentUrl = 'https://ads.example.com';
      const domain = 'pub.com';
      const authA = makeEvent('authorization.granted', 'auth-row-a', {
        id: 'auth-row-a',
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
        property_ids: ['prop_a'],
      });
      const authB = makeEvent('authorization.granted', 'auth-row-b', {
        id: 'auth-row-b',
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
        property_ids: ['prop_b'],
      });
      const revokeA = makeEvent('authorization.revoked', 'auth-row-a', {
        id: 'auth-row-a',
        agent_url: agentUrl,
        publisher_domain: domain,
        authorization_type: 'property_ids',
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([authA, authB, revokeA], { cursor: 'c-002' })), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const remaining = sync.getAuthorizationsForDomain(domain);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].id, 'auth-row-b');
      assert.deepStrictEqual(remaining[0].property_ids, ['prop_b']);
    });
  });

  // ============ lookupDomains ============

  describe('lookupDomains', () => {
    test('fans out individual lookupDomain calls', async () => {
      const lookupCalls = [];
      restore = mockFetch(async url => {
        const match = url.match(/\/lookup\/domain\/([^?]+)/);
        if (match) {
          const domain = decodeURIComponent(match[1]);
          lookupCalls.push(domain);
          return new Response(
            JSON.stringify({
              domain,
              authorized_agents: [{ url: 'https://agent.example.com' }],
              sales_agents_claiming: [],
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient();
      const results = await client.lookupDomains(['alpha.example.com', 'beta.example.com', 'gamma.example.com']);

      assert.strictEqual(Object.keys(results).length, 3);
      assert.strictEqual(results['alpha.example.com'].authorized_agents.length, 1);
      assert.strictEqual(lookupCalls.length, 3);
    });

    test('deduplicates domains', async () => {
      const lookupCalls = [];
      restore = mockFetch(async url => {
        const match = url.match(/\/lookup\/domain\/([^?]+)/);
        if (match) {
          const domain = decodeURIComponent(match[1]);
          lookupCalls.push(domain);
          return new Response(JSON.stringify({ domain, authorized_agents: [], sales_agents_claiming: [] }), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient();
      await client.lookupDomains(['alpha.example.com', 'alpha.example.com', 'beta.example.com']);

      assert.strictEqual(lookupCalls.length, 2);
    });

    test('omits failed domains from results', async () => {
      restore = mockFetch(async url => {
        if (url.endsWith('/lookup/domain/fail.example.com')) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(
          JSON.stringify({ domain: 'ok.example.com', authorized_agents: [], sales_agents_claiming: [] }),
          { status: 200 }
        );
      });

      const client = new RegistryClient();
      const results = await client.lookupDomains(['ok.example.com', 'fail.example.com']);

      assert.strictEqual(Object.keys(results).length, 1);
      assert.ok(results['ok.example.com']);
      assert.strictEqual(results['fail.example.com'], undefined);
    });

    test('respects concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      restore = mockFetch(async url => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        return new Response(JSON.stringify({ domain: 'x', authorized_agents: [], sales_agents_claiming: [] }), {
          status: 200,
        });
      });

      const client = new RegistryClient();
      const domains = Array.from({ length: 10 }, (_, i) => `domain${i}.com`);
      await client.lookupDomains(domains, { concurrency: 3 });

      assert.ok(maxConcurrent <= 3, `max concurrent was ${maxConcurrent}, expected <= 3`);
    });
  });

  // ============ lookupPropertyIdentifiers ============

  describe('lookupPropertyIdentifiers', () => {
    test('fans out individual lookupPropertyByIdentifier calls', async () => {
      const lookupCalls = [];
      restore = mockFetch(async url => {
        if (url.includes('/lookup/property')) {
          const parsed = new URL(url);
          const type = parsed.searchParams.get('type');
          const value = parsed.searchParams.get('value');
          lookupCalls.push({ type, value });
          return new Response(
            JSON.stringify({
              identifier_type: type,
              identifier_value: value,
              properties: [{ id: 'prop_1' }],
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient();
      const results = await client.lookupPropertyIdentifiers([
        { type: 'app_store_id', value: '12345' },
        { type: 'bundle_id', value: 'com.example.app' },
        { type: 'domain', value: 'example.com' },
      ]);

      assert.strictEqual(Object.keys(results).length, 3);
      assert.ok(results['app_store_id:12345']);
      assert.ok(results['bundle_id:com.example.app']);
      assert.strictEqual(lookupCalls.length, 3);
    });

    test('deduplicates by type:value', async () => {
      const lookupCalls = [];
      restore = mockFetch(async url => {
        if (url.includes('/lookup/property')) {
          lookupCalls.push(url);
          return new Response(JSON.stringify({ properties: [] }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient();
      await client.lookupPropertyIdentifiers([
        { type: 'app_store_id', value: '12345' },
        { type: 'app_store_id', value: '12345' },
        { type: 'bundle_id', value: 'com.example.app' },
      ]);

      assert.strictEqual(lookupCalls.length, 2);
    });

    test('omits failed lookups from results', async () => {
      restore = mockFetch(async url => {
        if (url.includes('fail_value')) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(JSON.stringify({ properties: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      const results = await client.lookupPropertyIdentifiers([
        { type: 'app_store_id', value: 'ok_value' },
        { type: 'app_store_id', value: 'fail_value' },
      ]);

      assert.strictEqual(Object.keys(results).length, 1);
      assert.ok(results['app_store_id:ok_value']);
      assert.strictEqual(results['app_store_id:fail_value'], undefined);
    });
  });

  // ============ domainsExist ============

  describe('domainsExist', () => {
    test('returns boolean map from lookupPropertiesAll', async () => {
      restore = mockFetch(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const results = {};
        for (const d of body.domains) {
          results[d] = d === 'exists.com' ? { publisher_domain: d, authorized_agents: [] } : null;
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.domainsExist(['exists.com', 'missing.com']);

      assert.strictEqual(result['exists.com'], true);
      assert.strictEqual(result['missing.com'], false);
    });
  });

  // ============ saveProperties ============

  describe('saveProperties', () => {
    test('saves multiple properties with partial failure handling', async () => {
      restore = mockFetch(async (url, opts) => {
        if (url.includes('/properties/save')) {
          const body = JSON.parse(opts.body);
          if (body.publisher_domain === 'fail.com') {
            return new Response('Conflict', { status: 409 });
          }
          return new Response(JSON.stringify({ publisher_domain: body.publisher_domain, status: 'saved' }), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const results = await client.saveProperties([
        { publisher_domain: 'ok.com', authorized_agents: [] },
        { publisher_domain: 'fail.com', authorized_agents: [] },
        { publisher_domain: 'also-ok.com', authorized_agents: [{ url: 'https://agent.example.com' }] },
      ]);

      assert.strictEqual(results['ok.com'].status, 'saved');
      assert.strictEqual(results['also-ok.com'].status, 'saved');
      assert.ok(results['fail.com'].error);
    });

    test('accepts empty authorized_agents array', async () => {
      restore = mockFetch(async (url, opts) => {
        if (url.includes('/properties/save')) {
          const body = JSON.parse(opts.body);
          return new Response(JSON.stringify({ publisher_domain: body.publisher_domain }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      // This should NOT throw — empty authorized_agents is valid for hosted properties
      const result = await client.saveProperty({
        publisher_domain: 'new-domain.com',
        authorized_agents: [],
      });
      assert.strictEqual(result.publisher_domain, 'new-domain.com');
    });

    test('allows omitted authorized_agents', async () => {
      restore = mockFetch(async (url, opts) => {
        if (url.includes('/properties/save')) {
          const body = JSON.parse(opts.body);
          return new Response(JSON.stringify({ publisher_domain: body.publisher_domain }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.saveProperty({ publisher_domain: 'test.com' });
      assert.strictEqual(result.publisher_domain, 'test.com');
    });
  });

  // ============ lookupPropertiesAll parallelism ============

  describe('lookupPropertiesAll parallelism', () => {
    test('runs batches in parallel up to concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      restore = mockFetch(async (url, opts) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        const body = JSON.parse(opts.body);
        const results = {};
        for (const d of body.domains) {
          results[d] = { publisher_domain: d, authorized_agents: [], properties: [] };
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const domains = Array.from({ length: 350 }, (_, i) => `domain${i}.com`);
      const result = await client.lookupPropertiesAll(domains, { concurrency: 2 });

      assert.strictEqual(Object.keys(result).length, 350);
      assert.ok(maxConcurrent <= 2, `max concurrent was ${maxConcurrent}, expected <= 2`);
    });
  });

  // ============ agent.compliance_changed event ============

  describe('agent.compliance_changed event', () => {
    test('updates agent compliance_summary in index', async () => {
      let requestCount = 0;
      restore = mockFetch(async url => {
        requestCount++;
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/feed')) {
          if (requestCount <= 2) {
            // Bootstrap feed: empty
            return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
          }
          // Polling feed: compliance changed
          return new Response(
            JSON.stringify(
              makeFeedResponse([
                makeEvent('agent.compliance_changed', AGENT_1.url, {
                  previous_status: 'unknown',
                  current_status: 'passing',
                  compliance_summary: {
                    status: 'passing',
                    lifecycle_stage: 'production',
                    tracks: { core: 'pass' },
                    streak_days: 7,
                    last_checked_at: '2026-04-01T00:00:00Z',
                    headline: 'All passing',
                  },
                }),
              ])
            ),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client, pollIntervalMs: 50 });

      await sync.start();

      // Wait for one poll cycle
      await new Promise(r => setTimeout(r, 150));
      sync.stop();

      const agent = sync.getAgent(AGENT_1.url);
      assert.ok(agent.compliance_summary);
      assert.strictEqual(agent.compliance_summary.status, 'passing');
      assert.strictEqual(agent.compliance_summary.streak_days, 7);
    });

    test('accepts opted_out compliance summaries', async () => {
      const complianceEvent = makeEvent('agent.compliance_changed', AGENT_1.url, {
        previous_status: 'unknown',
        current_status: 'opted_out',
        compliance_summary: {
          status: 'opted_out',
        },
      });

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([complianceEvent], { cursor: 'cursor-002' })), {
            status: 200,
          });
        }
        return new Response('{}', { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client });

      await sync.start();
      sync.stop();

      const agent = sync.getAgent(AGENT_1.url);
      assert.strictEqual(agent.compliance_summary.status, 'opted_out');
      assert.strictEqual(sync.findAgents({ compliance_status: ['opted_out'] }).length, 1);
    });

    test('emits compliance_changed event', async () => {
      let requestCount = 0;
      restore = mockFetch(async url => {
        requestCount++;
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/feed')) {
          if (requestCount <= 2) {
            return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
          }
          return new Response(
            JSON.stringify(
              makeFeedResponse([
                makeEvent('agent.compliance_changed', AGENT_1.url, {
                  previous_status: 'failing',
                  current_status: 'passing',
                }),
              ])
            ),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client, pollIntervalMs: 50 });

      const events = [];
      sync.on('compliance_changed', evt => events.push(evt));

      await sync.start();
      await new Promise(r => setTimeout(r, 150));
      sync.stop();

      assert.ok(events.length >= 1);
      assert.strictEqual(events[0].agentUrl, AGENT_1.url);
      assert.strictEqual(events[0].previousStatus, 'failing');
      assert.strictEqual(events[0].currentStatus, 'passing');
    });

    test('emits event even when indexAgents is false', async () => {
      let requestCount = 0;
      restore = mockFetch(async url => {
        requestCount++;
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([])), { status: 200 });
        }
        if (url.includes('/feed')) {
          if (requestCount <= 2) {
            return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
          }
          return new Response(
            JSON.stringify(
              makeFeedResponse([
                makeEvent('agent.compliance_changed', 'https://any.example.com', {
                  previous_status: 'unknown',
                  current_status: 'passing',
                }),
              ])
            ),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client, pollIntervalMs: 50, indexes: { agents: false } });

      const events = [];
      sync.on('compliance_changed', evt => events.push(evt));

      await sync.start();
      await new Promise(r => setTimeout(r, 150));
      sync.stop();

      assert.ok(events.length >= 1);
      assert.strictEqual(events[0].currentStatus, 'passing');
    });

    test('does not update index for unknown agent but still emits event', async () => {
      let requestCount = 0;
      restore = mockFetch(async url => {
        requestCount++;
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/feed')) {
          if (requestCount <= 2) {
            return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
          }
          return new Response(
            JSON.stringify(
              makeFeedResponse([
                makeEvent('agent.compliance_changed', 'https://unknown.example.com', {
                  previous_status: 'unknown',
                  current_status: 'passing',
                  compliance_summary: {
                    status: 'passing',
                    lifecycle_stage: 'production',
                    tracks: {},
                    streak_days: 0,
                    last_checked_at: null,
                    headline: null,
                  },
                }),
              ])
            ),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client, pollIntervalMs: 50 });

      const events = [];
      sync.on('compliance_changed', evt => events.push(evt));

      await sync.start();
      await new Promise(r => setTimeout(r, 150));
      sync.stop();

      // Agent 1 should still be in the index, unchanged
      const agent = sync.getAgent(AGENT_1.url);
      assert.ok(agent);
      assert.strictEqual(agent.compliance_summary, undefined);

      // But the event should still have been emitted
      assert.ok(events.length >= 1);
      assert.strictEqual(events[0].agentUrl, 'https://unknown.example.com');
    });
  });

  // ============ findAgents compliance_status filter ============

  describe('findAgents compliance_status filter', () => {
    test('filters agents by compliance status', async () => {
      const AGENT_PASSING = {
        ...AGENT_1,
        compliance_summary: {
          status: 'passing',
          lifecycle_stage: 'production',
          tracks: {},
          streak_days: 5,
          last_checked_at: null,
          headline: null,
        },
      };
      const AGENT_FAILING = {
        ...AGENT_2,
        compliance_summary: {
          status: 'failing',
          lifecycle_stage: 'testing',
          tracks: {},
          streak_days: 0,
          last_checked_at: null,
          headline: null,
        },
      };

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_PASSING, AGENT_FAILING])), { status: 200 });
        }
        return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const passing = sync.findAgents({ compliance_status: ['passing'] });
      assert.strictEqual(passing.length, 1);
      assert.strictEqual(passing[0].url, AGENT_1.url);

      const failing = sync.findAgents({ compliance_status: ['failing'] });
      assert.strictEqual(failing.length, 1);
      assert.strictEqual(failing[0].url, AGENT_2.url);

      const both = sync.findAgents({ compliance_status: ['passing', 'failing'] });
      assert.strictEqual(both.length, 2);
    });

    test('agents without compliance_summary default to unknown', async () => {
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1, AGENT_2])), { status: 200 });
        }
        return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const sync = new RegistrySync({ client });
      await sync.start();
      sync.stop();

      const unknown = sync.findAgents({ compliance_status: ['unknown'] });
      assert.strictEqual(unknown.length, 2);

      const passing = sync.findAgents({ compliance_status: ['passing'] });
      assert.strictEqual(passing.length, 0);
    });
  });
});
