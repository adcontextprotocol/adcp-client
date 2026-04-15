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
        // Support redirect responses (301/302 with location header)
        if (config.location) {
          return {
            ok: false,
            status,
            statusText: config.statusText || 'Moved',
            headers: new Map([['location', config.location]]),
            json: async () => null,
            text: async () => '',
          };
        }
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
      json: async () => {
        throw new Error('Not Found');
      },
      text: async () => 'Not Found',
    };
  };
}

function makeAuthoritativeFile(properties, agents) {
  return {
    $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
    authorized_agents: agents || [{ url: 'https://seller.example.com/mcp', authorized_for: 'Programmatic sales' }],
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

  describe('core checks', () => {
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
      assert.ok(report.checkedAt, 'checkedAt should be set');
      assert.ok(!isNaN(Date.parse(report.checkedAt)), 'checkedAt should be valid ISO 8601');
      assert.strictEqual(report.coverage, 1);
      assert.strictEqual(report.orphanedPointers.length, 0);
      assert.strictEqual(report.stalePointers.length, 0);
      assert.strictEqual(report.missingPointers.length, 0);
      assert.strictEqual(report.schemaErrors.length, 0);
      assert.strictEqual(report.agentHealth.length, 1);
      assert.strictEqual(report.agentHealth[0].reachable, true);
      assert.strictEqual(report.domains.length, 2);
      assert.ok(report.domains.every(d => d.status === 'ok'));
      assert.ok(report.domains.every(d => d.errors.length === 0));
      // Summary
      assert.strictEqual(report.summary.totalDomains, 2);
      assert.strictEqual(report.summary.validPointers, 2);
      assert.strictEqual(report.summary.totalIssues, 0);
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
      // Coverage is based on authoritative domains only (cookingdaily.com), not orphans
      assert.strictEqual(report.coverage, 1);
      const orphanDetail = report.domains.find(d => d.domain === 'orphan.com');
      assert.strictEqual(orphanDetail.status, 'orphaned_pointer');
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
      assert.strictEqual(report.stalePointers[0].expectedUrl, AUTH_URL);
      assert.strictEqual(report.coverage, 0.5);
    });

    test('missing pointer — domain returns 404', async () => {
      const authFile = makeAuthoritativeFile();

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
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

      assert.strictEqual(report.schemaErrors.length, 3);
      const fields = report.schemaErrors.map(e => e.field);
      assert.ok(fields.includes('authorized_agents'));
      assert.ok(fields.includes('properties[0].name'));
      assert.ok(fields.includes('properties[0].property_type'));
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
      assert.strictEqual(report.summary.totalDomains, 3);
      assert.strictEqual(report.summary.validPointers, 1);
      assert.strictEqual(report.summary.missingPointers, 1);
      assert.strictEqual(report.summary.stalePointers, 1);
      assert.strictEqual(report.summary.totalIssues, 2);
    });
  });

  describe('agent health', () => {
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
      assert.strictEqual(healthy.error, undefined);
      assert.strictEqual(broken.reachable, false);
      assert.strictEqual(broken.statusCode, 500);
    });

    test('agent returning 405 is treated as reachable', async () => {
      const authFile = makeAuthoritativeFile(undefined, [
        { url: 'https://no-head.example.com/mcp', authorized_for: 'Sales' },
      ]);

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'gardenweekly.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'no-head.example.com/mcp': { status: 405, statusText: 'Method Not Allowed', data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.agentHealth.length, 1);
      assert.strictEqual(report.agentHealth[0].reachable, true);
      assert.strictEqual(report.agentHealth[0].statusCode, 405);
    });
  });

  describe('authoritative file resolution', () => {
    test('domains-only mode — discovers authoritative URL from first domain pointer', async () => {
      const authFile = makeAuthoritativeFile(
        [
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
        ],
        [{ url: 'https://seller.example.com/mcp', authorized_for: 'Sales' }]
      );

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

    test('domains-only mode — first domain serves full file directly', async () => {
      const authFile = makeAuthoritativeFile(
        [
          {
            property_type: 'website',
            name: 'primary.com',
            identifiers: [{ type: 'domain', value: 'primary.com' }],
          },
        ],
        [{ url: 'https://seller.example.com/mcp', authorized_for: 'Sales' }]
      );

      routedFetch({
        'primary.com/.well-known/adagents.json': { data: authFile },
        'seller.example.com/mcp': { data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        domains: ['primary.com'],
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.authoritativeUrl, 'https://primary.com/.well-known/adagents.json');
      assert.strictEqual(report.schemaErrors.length, 0);
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

    test('self-referential authoritative_location is reported as schema error', async () => {
      routedFetch({
        'network.example.com/adagents.json': {
          data: { authoritative_location: AUTH_URL },
        },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.ok(report.schemaErrors.some(e => e.message.includes('points to itself')));
      assert.strictEqual(report.coverage, 0);
    });

    test('non-HTTPS authoritative_location redirect is rejected', async () => {
      routedFetch({
        'network.example.com/adagents.json': {
          data: { authoritative_location: 'http://insecure.example.com/adagents.json' },
        },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.ok(report.schemaErrors.some(e => e.message.includes('must use HTTPS')));
      assert.strictEqual(report.coverage, 0);
    });

    test('authoritative_location redirect is followed one hop', async () => {
      const authFile = makeAuthoritativeFile(
        [
          {
            property_type: 'website',
            name: 'pub.com',
            identifiers: [{ type: 'domain', value: 'pub.com' }],
          },
        ],
        [{ url: 'https://seller.example.com/mcp', authorized_for: 'Sales' }]
      );

      const redirectUrl = 'https://canonical.example.com/adagents.json';

      routedFetch({
        'network.example.com/adagents.json': {
          data: { authoritative_location: redirectUrl },
        },
        'canonical.example.com/adagents.json': { data: authFile },
        'pub.com/.well-known/adagents.json': { data: makePointer(redirectUrl) },
        'seller.example.com/mcp': { data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.authoritativeUrl, redirectUrl);
      assert.strictEqual(report.coverage, 1);
      assert.strictEqual(report.schemaErrors.length, 0);
    });
  });

  describe('domain pointer edge cases', () => {
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
        'standalone.com/.well-known/adagents.json': {
          data: {
            authorized_agents: [{ url: 'https://other.example.com/mcp', authorized_for: 'Sales' }],
            properties: [
              {
                property_type: 'website',
                name: 'standalone.com',
                identifiers: [{ type: 'domain', value: 'standalone.com' }],
              },
            ],
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
      assert.strictEqual(report.stalePointers[0].expectedUrl, AUTH_URL);
      assert.strictEqual(report.coverage, 0);
    });

    test('subdomain identifier type is extracted for pointer checks', async () => {
      const authFile = makeAuthoritativeFile(
        [
          {
            property_type: 'website',
            name: 'Blog',
            identifiers: [{ type: 'subdomain', value: 'blog.example.com' }],
          },
        ],
        [{ url: 'https://seller.example.com/mcp', authorized_for: 'Sales' }]
      );

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'blog.example.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'seller.example.com/mcp': { data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.coverage, 1);
      assert.strictEqual(report.domains.length, 1);
      assert.strictEqual(report.domains[0].status, 'ok');
    });
  });

  describe('HTTP redirect following', () => {
    test('follows one redirect on pointer fetch (CDN www redirect)', async () => {
      const authFile = makeAuthoritativeFile([
        {
          property_type: 'website',
          name: 'example.com',
          identifiers: [{ type: 'domain', value: 'example.com' }],
        },
      ]);

      // Use a function handler to disambiguate bare domain vs www
      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'example.com/.well-known/adagents.json': urlStr => {
          if (urlStr.includes('www.example.com')) {
            return { data: makePointer(AUTH_URL) };
          }
          return { status: 301, location: 'https://www.example.com/.well-known/adagents.json' };
        },
        'seller.example.com/mcp': { data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.coverage, 1);
      assert.strictEqual(report.missingPointers.length, 0);
      assert.strictEqual(report.domains[0].status, 'ok');
    });

    test('follows one redirect on agent health check', async () => {
      const authFile = makeAuthoritativeFile(undefined, [
        { url: 'https://agent.example.com/mcp', authorized_for: 'Sales' },
      ]);

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'gardenweekly.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        // Agent endpoint redirects
        'agent.example.com/mcp': {
          status: 301,
          location: 'https://agent-v2.example.com/mcp',
        },
        'agent-v2.example.com/mcp': { data: {} },
      });

      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
      });

      const report = await checker.check();

      assert.strictEqual(report.agentHealth.length, 1);
      assert.strictEqual(report.agentHealth[0].reachable, true);
    });

    test('rejects redirect to non-HTTPS URL on pointer fetch', async () => {
      const authFile = makeAuthoritativeFile([
        {
          property_type: 'website',
          name: 'insecure.com',
          identifiers: [{ type: 'domain', value: 'insecure.com' }],
        },
      ]);

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'insecure.com/.well-known/adagents.json': {
          status: 301,
          location: 'http://insecure.com/.well-known/adagents.json',
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
      assert.strictEqual(report.coverage, 0);
    });
  });

  describe('progress callback', () => {
    test('onProgress is called for each domain check', async () => {
      const authFile = makeAuthoritativeFile();

      routedFetch({
        'network.example.com/adagents.json': { data: authFile },
        'cookingdaily.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'gardenweekly.com/.well-known/adagents.json': { data: makePointer(AUTH_URL) },
        'seller.example.com/mcp': { data: {} },
      });

      const events = [];
      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      const checker = new NetworkConsistencyChecker({
        authoritativeUrl: AUTH_URL,
        logLevel: 'silent',
        onProgress: progress => events.push(progress),
      });

      await checker.check();

      const pointerEvents = events.filter(e => e.phase === 'pointers');
      const agentEvents = events.filter(e => e.phase === 'agents');
      assert.strictEqual(pointerEvents.length, 2);
      assert.strictEqual(agentEvents.length, 1);
      assert.ok(pointerEvents.every(e => e.total === 2));
      assert.ok(pointerEvents.some(e => e.completed === 1));
      assert.ok(pointerEvents.some(e => e.completed === 2));
    });
  });

  describe('constructor validation', () => {
    test('throws if neither authoritativeUrl nor domains provided', () => {
      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      assert.throws(() => {
        new NetworkConsistencyChecker({ logLevel: 'silent' });
      }, /Either authoritativeUrl or domains must be provided/);
    });

    test('throws if concurrency is less than 1', () => {
      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      assert.throws(() => {
        new NetworkConsistencyChecker({
          authoritativeUrl: AUTH_URL,
          concurrency: 0,
          logLevel: 'silent',
        });
      }, /concurrency must be >= 1/);
    });

    test('throws if timeoutMs is less than 1', () => {
      const { NetworkConsistencyChecker } = require('../../dist/lib/index.js');
      assert.throws(() => {
        new NetworkConsistencyChecker({
          authoritativeUrl: AUTH_URL,
          timeoutMs: 0,
          logLevel: 'silent',
        });
      }, /timeoutMs must be >= 1/);
    });
  });
});
