const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * Helper: build a mock fetch that dispatches by URL pattern.
 * @param {Record<string, object|function>} routes - URL substring → response config or handler
 */
function routedFetch(routes) {
  global.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) {
        const config = typeof handler === 'function' ? handler(urlStr, options) : handler;
        const status = config.status || 200;
        const body = JSON.stringify(config.data);
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: config.statusText || 'OK',
          headers: new Map([['content-length', String(body.length)]]),
          json: async () => config.data,
          text: async () => body,
        };
      }
    }
    // Default: 404
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map(),
      json: async () => { throw new Error('Not Found'); },
      text: async () => 'Not Found',
    };
  };
}

function makeAuthoritativeFile(properties, agents) {
  return {
    $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
    authorized_agents: agents || [
      { url: 'https://seller.example.com/mcp', authorized_for: 'Programmatic sales' },
    ],
    properties: properties || [
      {
        property_type: 'website',
        name: 'cookingdaily.com',
        identifiers: [{ type: 'domain', value: 'cookingdaily.com' }],
        publisher_domain: 'cookingdaily.com',
      },
      {
        property_type: 'website',
        name: 'gardenweekly.com',
        identifiers: [{ type: 'domain', value: 'gardenweekly.com' }],
        publisher_domain: 'gardenweekly.com',
      },
    ],
  };
}

function makePointer(authoritativeUrl) {
  return {
    authoritative_location: authoritativeUrl,
  };
}

describe('NetworkConsistencyChecker', () => {
  const AUTH_URL = 'https://network.example.com/adagents.json';

  test('clean network — all pointers valid, 100% coverage', async () => {
    const authFile = makeAuthoritativeFile();

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'gardenweekly.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.authoritativeUrl, AUTH_URL);
    assert.strictEqual(report.coverage, 1);
    assert.strictEqual(report.orphanedPointers.length, 0);
    assert.strictEqual(report.stalePointers.length, 0);
    assert.strictEqual(report.missingPointers.length, 0);
    assert.strictEqual(report.schemaErrors.length, 0);
    assert.strictEqual(report.agentHealth.length, 1);
    assert.strictEqual(report.agentHealth[0].reachable, true);
    assert.strictEqual(report.domains.length, 2);
    assert.ok(report.domains.every(d => d.status === 'ok'));
  });

  test('orphaned pointer — domain points here but not in properties', async () => {
    const authFile = makeAuthoritativeFile([
      {
        property_type: 'website',
        name: 'cookingdaily.com',
        identifiers: [{ type: 'domain', value: 'cookingdaily.com' }],
      },
    ]);

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'orphan.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      domains: ['cookingdaily.com', 'orphan.com'],
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.orphanedPointers.length, 1);
    assert.strictEqual(report.orphanedPointers[0].domain, 'orphan.com');
    assert.strictEqual(report.orphanedPointers[0].pointerUrl, AUTH_URL);
  });

  test('stale pointer — domain points to different authoritative URL', async () => {
    const authFile = makeAuthoritativeFile();

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'gardenweekly.com/.well-known/adagents.json': {
        data: makePointer('https://old-network.example.com/adagents.json'),
      },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.stalePointers.length, 1);
    assert.strictEqual(report.stalePointers[0].domain, 'gardenweekly.com');
    assert.strictEqual(report.stalePointers[0].pointerUrl, 'https://old-network.example.com/adagents.json');
    assert.strictEqual(report.coverage, 0.5);
  });

  test('missing pointer — domain returns 404', async () => {
    const authFile = makeAuthoritativeFile();

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      // gardenweekly.com not routed → 404
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.missingPointers.length, 1);
    assert.strictEqual(report.missingPointers[0].domain, 'gardenweekly.com');
    assert.strictEqual(report.coverage, 0.5);
  });

  test('schema errors — authoritative file missing required fields', async () => {
    const badAuthFile = {
      properties: [
        {
          identifiers: [{ type: 'domain', value: 'example.com' }],
        },
      ],
    };

    routedFetch({
      'network.example.com/adagents.json': { data: badAuthFile },
      'example.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.ok(report.schemaErrors.length >= 2, `Expected at least 2 schema errors, got ${report.schemaErrors.length}`);
    const fields = report.schemaErrors.map(e => e.field);
    assert.ok(fields.some(f => f === 'authorized_agents'));
    assert.ok(fields.some(f => f.includes('name') || f.includes('property_type')));
  });

  test('unreachable agent — endpoint returns 500', async () => {
    const authFile = makeAuthoritativeFile(undefined, [
      { url: 'https://healthy.example.com/mcp', authorized_for: 'Sales' },
      { url: 'https://broken.example.com/mcp', authorized_for: 'Sales' },
    ]);

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'gardenweekly.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'healthy.example.com/mcp': { data: {} },
      'broken.example.com/mcp': { status: 500, statusText: 'Internal Server Error', data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.agentHealth.length, 2);
    const healthy = report.agentHealth.find(a => a.url.includes('healthy'));
    const broken = report.agentHealth.find(a => a.url.includes('broken'));
    assert.strictEqual(healthy.reachable, true);
    assert.strictEqual(broken.reachable, false);
    assert.strictEqual(broken.statusCode, 500);
  });

  test('mixed results — combination of issues', async () => {
    const authFile = makeAuthoritativeFile([
      {
        property_type: 'website',
        name: 'good.com',
        identifiers: [{ type: 'domain', value: 'good.com' }],
      },
      {
        property_type: 'website',
        name: 'stale.com',
        identifiers: [{ type: 'domain', value: 'stale.com' }],
      },
      {
        property_type: 'website',
        name: 'missing.com',
        identifiers: [{ type: 'domain', value: 'missing.com' }],
      },
    ]);

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      'good.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'stale.com/.well-known/adagents.json': {
        data: makePointer('https://other.example.com/adagents.json'),
      },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.missingPointers.length, 1);
    assert.strictEqual(report.stalePointers.length, 1);
    assert.ok(Math.abs(report.coverage - 1 / 3) < 0.01, `Expected ~33% coverage, got ${report.coverage}`);
  });

  test('domains-only mode — discovers authoritative URL from first domain', async () => {
    const authFile = makeAuthoritativeFile([
      {
        property_type: 'website',
        name: 'site-a.com',
        identifiers: [{ type: 'domain', value: 'site-a.com' }],
      },
      {
        property_type: 'website',
        name: 'site-b.com',
        identifiers: [{ type: 'domain', value: 'site-b.com' }],
      },
    ], [
      { url: 'https://seller.example.com/mcp', authorized_for: 'Sales' },
    ]);

    routedFetch({
      'site-a.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'network.example.com/adagents.json': { data: authFile },
      'site-b.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      domains: ['site-a.com', 'site-b.com'],
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.authoritativeUrl, AUTH_URL);
    assert.strictEqual(report.coverage, 1);
  });

  test('constructor throws if neither authoritativeUrl nor domains provided', () => {
    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    assert.throws(() => {
      new NetworkConsistencyChecker({ logLevel: 'silent' });
    }, /Either authoritativeUrl or domains must be provided/);
  });

  test('authoritative URL fetch failure returns early with schema error', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.coverage, 0);
    assert.ok(report.schemaErrors.length >= 1);
    assert.ok(report.schemaErrors.some(e => e.field === '$root'));
    assert.strictEqual(report.domains.length, 0);
  });

  test('domain without authoritative_location is stale', async () => {
    const authFile = makeAuthoritativeFile([
      {
        property_type: 'website',
        name: 'standalone.com',
        identifiers: [{ type: 'domain', value: 'standalone.com' }],
      },
    ]);

    routedFetch({
      'network.example.com/adagents.json': { data: authFile },
      // standalone.com has an adagents.json but no authoritative_location
      'standalone.com/.well-known/adagents.json': {
        data: {
          authorized_agents: [{ url: 'https://other.example.com/mcp', authorized_for: 'Sales' }],
          properties: [{ property_type: 'website', name: 'standalone.com', identifiers: [{ type: 'domain', value: 'standalone.com' }] }],
        },
      },
      'seller.example.com/mcp': { data: {} },
    });

    const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
    const checker = new NetworkConsistencyChecker({
      authoritativeUrl: AUTH_URL,
      logLevel: 'silent',
    });

    const report = await checker.check();

    assert.strictEqual(report.stalePointers.length, 1);
    assert.strictEqual(report.stalePointers[0].domain, 'standalone.com');
    assert.strictEqual(report.coverage, 0);
  });
});
