const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { RegistryClient, RegistrySync } = require('../../dist/lib/registry/index.js');

// Helper to mock global fetch
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
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

      let pollCount = 0;
      restore = mockFetch(async () => {
        pollCount++;
        if (pollCount === 1) {
          return new Response(JSON.stringify(makeFeedResponse([authEvent], { cursor: 'cursor-002' })), { status: 200 });
        }
        return new Response(JSON.stringify(EMPTY_FEED), { status: 200 });
      });

      // Manually trigger a poll by restarting with short interval
      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync2 = new RegistrySync({ client, pollIntervalMs: 10 });

      // We'll apply events directly via internal mechanism by starting fresh
      // Instead, test the lookup methods after applying auth events during bootstrap
      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([authEvent], { cursor: 'cursor-002' })), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const syncWithAuth = new RegistrySync({ client: new RegistryClient({ apiKey: 'sk_test' }) });
      await syncWithAuth.start();
      syncWithAuth.stop();

      assert.ok(syncWithAuth.isAuthorized('https://ads.streamhaus.example.com', 'nytimes.com'));
      assert.strictEqual(syncWithAuth.getAuthorizationsForDomain('nytimes.com').length, 1);
      assert.strictEqual(syncWithAuth.getAuthorizationsForAgent('https://ads.streamhaus.example.com').length, 1);
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
      const removeEvent = makeEvent('agent.removed', 'https://ads.streamhaus.example.com', {});

      restore = mockFetch(async url => {
        if (url.includes('/agents/search')) {
          return new Response(JSON.stringify(makeSearchResponse([AGENT_1])), { status: 200 });
        }
        if (url.includes('/registry/feed')) {
          return new Response(JSON.stringify(makeFeedResponse([removeEvent], { cursor: 'cursor-002' })), {
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

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const sync = new RegistrySync({ client });
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
      const fullAuth = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
        authorization_type: 'full',
      });
      const propertyAuth = makeEvent('authorization.granted', 'auth-2', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
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
      const fullAuth = makeEvent('authorization.granted', 'auth-1', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
        authorization_type: 'full',
      });
      const propertyAuth = makeEvent('authorization.granted', 'auth-2', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
        authorization_type: 'property_ids',
      });
      const revokeProperty = makeEvent('authorization.revoked', 'auth-3', {
        agent_url: 'https://ads.example.com',
        publisher_domain: 'pub.com',
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
      const results = await client.lookupDomains(['a.com', 'b.com', 'c.com']);

      assert.strictEqual(Object.keys(results).length, 3);
      assert.strictEqual(results['a.com'].authorized_agents.length, 1);
      assert.ok(lookupCalls.includes('a.com'));
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
      await client.lookupDomains(['a.com', 'a.com', 'b.com']);

      assert.strictEqual(lookupCalls.length, 2);
    });

    test('omits failed domains from results', async () => {
      restore = mockFetch(async url => {
        if (url.includes('fail.com')) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(JSON.stringify({ domain: 'ok.com', authorized_agents: [], sales_agents_claiming: [] }), {
          status: 200,
        });
      });

      const client = new RegistryClient();
      const results = await client.lookupDomains(['ok.com', 'fail.com']);

      assert.strictEqual(Object.keys(results).length, 1);
      assert.ok(results['ok.com']);
      assert.strictEqual(results['fail.com'], undefined);
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
});
