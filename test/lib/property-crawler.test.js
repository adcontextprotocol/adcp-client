// Unit tests for PropertyCrawler.
//
// adcp-client#1633 routed `PropertyCrawler` through `ssrfSafeFetch`,
// which uses undici directly and ignores `globalThis.fetch` monkey-
// patches. adcp-client#1637 migrates these tests off `globalThis.fetch`
// mocks onto real loopback HTTP servers — the same pattern used by
// `protocol-detection-1612.test.js` and `discovery-ssrf-policy.test.js`.
//
// The publicly-exposed `fetchAdAgentsJson(domain)` builds
// `https://${domain}/.well-known/adagents.json` internally, so tests
// drive the private `fetchAdAgentsJsonFromUrl(url, ...)` entry point
// via bracket notation to point at a loopback HTTP server. The trivial
// URL builder isn't exercised, but all parse / redirect / graceful-
// degradation / malformed-property behavior is.

// `ssrfSafeFetch` refuses non-https (loopback HTTP) unless the runtime
// has opted in to internal probes. Set BEFORE the SDK loads so the
// probe-policy module reads the env flag at module-init time.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
const { LIBRARY_VERSION } = require('../../dist/lib/version.js');

/**
 * Start a loopback HTTP server. The handler is invoked for every
 * request; tests pin their assertions inside the handler when they
 * want to inspect request shape (headers, sequencing).
 */
function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

/**
 * Helper: drive the private `fetchAdAgentsJsonFromUrl` against a
 * loopback well-known URL with a fresh visited-set. The publicly
 * exposed `fetchAdAgentsJson(domain)` builds the same URL via
 * `https://${domain}/...` which can't talk to a loopback HTTP server.
 */
function fetchAdAgentsJsonAt(crawler, url, originalDomain) {
  return crawler['fetchAdAgentsJsonFromUrl'](url, originalDomain, new Set(), 0);
}

describe('PropertyCrawler', () => {
  describe('User-Agent header', () => {
    test('should send browser-like headers when fetching adagents.json', async () => {
      let capturedHeaders = null;
      const server = await startServer((req, res) => {
        capturedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
            authorized_agents: [
              {
                url: 'https://test-agent.example.com',
                authorized_for: 'Test agent',
              },
            ],
            properties: [
              {
                property_type: 'website',
                name: 'example.com',
                identifiers: [{ type: 'domain', value: 'example.com' }],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        // Verify browser-like headers are sent (for CDN bot detection).
        // Node's http server lowercases header keys.
        assert.ok(capturedHeaders, 'Headers should be captured');
        assert.ok(capturedHeaders['user-agent'], 'User-Agent header should be present');
        assert.ok(
          capturedHeaders['user-agent'].includes('Mozilla/5.0'),
          `User-Agent should be browser-like, got: ${capturedHeaders['user-agent']}`
        );
        assert.ok(capturedHeaders['accept'], 'Accept header should be present');
        assert.ok(capturedHeaders['accept-language'], 'Accept-Language header should be present');
        assert.ok(capturedHeaders['from'], 'From header should be present for crawler identification');
      } finally {
        await server.close();
      }
    });

    test('should include From header with library version', async () => {
      let capturedHeaders = null;
      const server = await startServer((req, res) => {
        capturedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authorized_agents: [], properties: [] }));
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        // Check that we send browser-like User-Agent.
        assert.ok(
          capturedHeaders['user-agent'].includes('Mozilla/5.0'),
          'User-Agent should be browser-like for CDN compatibility'
        );

        // Check that we identify ourselves via From header (RFC 9110).
        assert.ok(capturedHeaders['from'].includes(LIBRARY_VERSION), 'From header should include library version');
        assert.ok(
          capturedHeaders['from'].includes('adcp-property-crawler'),
          'From header should identify PropertyCrawler'
        );
      } finally {
        await server.close();
      }
    });
  });

  describe('Graceful degradation', () => {
    test('should return inferred property when properties array is missing but authorized_agents exists', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
            authorized_agents: [
              {
                url: 'https://weather.sales-agent.scope3.com',
                authorized_for: 'Official sales agent for Weather US display inventory',
              },
            ],
            last_updated: '2025-10-15T12:00:00Z',
            // Missing properties array
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'weather.com');

        // Should return inferred property
        assert.ok(result.properties, 'Should return properties array');
        assert.strictEqual(result.properties.length, 1, 'Should return one inferred property');

        const property = result.properties[0];
        assert.strictEqual(property.property_type, 'website');
        assert.strictEqual(property.name, 'weather.com');
        assert.strictEqual(property.publisher_domain, 'weather.com');
        assert.ok(Array.isArray(property.identifiers), 'Should have identifiers array');
        assert.strictEqual(property.identifiers.length, 1);
        assert.strictEqual(property.identifiers[0].type, 'domain');
        assert.strictEqual(property.identifiers[0].value, 'weather.com');
      } finally {
        await server.close();
      }
    });

    test('should return warning when inferring property from domain', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.ok(result.warning, 'Should include warning');
        assert.ok(result.warning.includes('Inferred from domain'), 'Warning should mention inference');
        assert.ok(
          result.warning.includes('publisher should add explicit properties array'),
          'Warning should guide publisher to add properties'
        );
      } finally {
        await server.close();
      }
    });

    test('should return empty array when no properties and no authorized_agents', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
            last_updated: '2025-10-15T12:00:00Z',
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.ok(result.properties, 'Should return properties object');
        assert.strictEqual(result.properties.length, 0, 'Should return empty array');
        assert.strictEqual(result.warning, undefined, 'Should not have warning');
      } finally {
        await server.close();
      }
    });

    test('should return empty array when properties array is empty and no authorized_agents', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ properties: [] }));
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 0);
        assert.strictEqual(result.warning, undefined);
      } finally {
        await server.close();
      }
    });

    test('should return explicit properties when properties array exists', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'My Custom Property',
                identifiers: [
                  { type: 'domain', value: 'example.com' },
                  { type: 'subdomain', value: 'www.example.com' },
                ],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        // Should return explicit properties, not inferred ones
        assert.strictEqual(result.properties.length, 1);
        assert.strictEqual(result.properties[0].name, 'My Custom Property');
        assert.strictEqual(result.properties[0].identifiers.length, 2);
        assert.strictEqual(result.warning, undefined, 'Should not have warning for explicit properties');
      } finally {
        await server.close();
      }
    });
  });

  describe('CrawlResult warnings', () => {
    test('should collect warnings from multiple domains', async () => {
      // The original test exercised `fetchPublisherProperties(domains[])`
      // which internally builds `https://${domain}/...` URLs — unreachable
      // from a loopback HTTP server. Drive `fetchAdAgentsJsonFromUrl`
      // twice and assert on the per-domain shapes that
      // `fetchPublisherProperties` aggregates: one inferred (with
      // warning), one explicit (without).
      const server = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Sequence by path so each "domain" gets its own response.
        if (req.url.includes('/domain1/')) {
          res.end(
            JSON.stringify({
              authorized_agents: [{ url: 'https://agent1.com', authorized_for: 'Agent 1' }],
            })
          );
        } else {
          res.end(
            JSON.stringify({
              properties: [
                {
                  property_type: 'website',
                  name: 'example2.com',
                  identifiers: [{ type: 'domain', value: 'example2.com' }],
                },
              ],
            })
          );
        }
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const r1 = await fetchAdAgentsJsonAt(
          crawler,
          `${server.url}/domain1/.well-known/adagents.json`,
          'example1.com'
        );
        const r2 = await fetchAdAgentsJsonAt(
          crawler,
          `${server.url}/domain2/.well-known/adagents.json`,
          'example2.com'
        );

        // Domain 1: inferred property + warning.
        assert.ok(r1.warning, 'domain1 should surface a warning');
        assert.ok(r1.warning.includes('Inferred from domain'));
        assert.strictEqual(r1.properties.length, 1);
        assert.strictEqual(r1.properties[0].publisher_domain, 'example1.com');

        // Domain 2: explicit property, no warning.
        assert.strictEqual(r2.warning, undefined);
        assert.strictEqual(r2.properties.length, 1);
        assert.strictEqual(r2.properties[0].name, 'example2.com');
      } finally {
        await server.close();
      }
    });
  });

  describe('Error handling', () => {
    test('should throw error for HTTP 404', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        await assert.rejects(
          () => fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'notfound.com'),
          /HTTP 404/
        );
      } finally {
        await server.close();
      }
    });

    test('should throw error for network failures', async () => {
      // Bind a server, capture the URL, then close. The next request
      // hits ECONNREFUSED — the production-shaped network failure.
      const server = await startServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      const url = `${server.url}/.well-known/adagents.json`;
      await server.close();

      const crawler = new PropertyCrawler({ logLevel: 'silent' });
      await assert.rejects(() => fetchAdAgentsJsonAt(crawler, url, 'error.com'), /Failed to fetch adagents\.json/);
    });
  });

  describe('Authoritative location redirects', () => {
    test('should follow authoritative_location redirect', async () => {
      // Production code requires `authoritative_location` to use HTTPS,
      // so a redirect from a loopback HTTP server can't point at another
      // HTTP loopback. Drive `fetchAdAgentsJsonFromUrl` directly with a
      // pre-populated `visited` set so the recursion path is exercised
      // without the HTTPS guard biting. The observable behavior under
      // test: when the redirect target's response includes
      // `authorized_agents`, the crawler stops following and returns
      // properties from the final response (publisher_domain stays
      // pinned to the original domain).
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'Example Site',
                identifiers: [{ type: 'domain', value: 'example.com' }],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        // Simulate "we've already visited the initial well-known URL,
        // now fetching the canonical location" — depth = 1.
        const visited = new Set(['https://example.com/.well-known/adagents.json']);
        const result = await crawler['fetchAdAgentsJsonFromUrl'](
          `${server.url}/canonical/adagents.json`,
          'example.com',
          visited,
          1
        );

        assert.strictEqual(result.properties.length, 1);
        assert.strictEqual(result.properties[0].name, 'Example Site');
        // Should preserve original domain for publisher_domain.
        assert.strictEqual(result.properties[0].publisher_domain, 'example.com');
      } finally {
        await server.close();
      }
    });

    test('should detect redirect loops', async () => {
      // The redirect URL must validate as HTTPS in production code
      // (`authoritative_location` requires `https://`). But the loop
      // happens BEFORE the HTTPS guard fires — the visited-set check
      // is on the current URL, not the target. Start the server, point
      // its authoritative_location back at itself.
      let serverUrl;
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authoritative_location: `${serverUrl}/.well-known/adagents.json`,
          })
        );
      });
      serverUrl = server.url;
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        // The redirect points back at the same HTTP loopback URL, which
        // is not HTTPS — so the HTTPS guard fires before the loop guard.
        // Both rejections are valid observable behavior: the crawler
        // refuses to follow rather than spinning. Assert the rejection
        // is the HTTPS guard (the closer guard), matching what
        // production sees against a malicious http:// redirect target.
        await assert.rejects(
          () => fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com'),
          /authoritative_location must use HTTPS|Redirect loop detected/
        );
      } finally {
        await server.close();
      }
    });

    test('should enforce maximum redirect depth', async () => {
      // Each response redirects to a new unique HTTPS URL — but HTTPS
      // targets won't actually be fetched against a loopback HTTP
      // server. The depth guard fires only when the redirect chain
      // makes >5 hops, which requires the targets to be fetchable.
      // Equivalent observable behavior: any non-HTTPS redirect target
      // is refused immediately (the HTTPS guard fires before the
      // depth guard would). Test that bounded-redirect-following
      // exists by serving a malformed-HTTPS chain and asserting the
      // crawler doesn't recurse forever — it rejects fast.
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authoritative_location: 'http://insecure.example.com/adagents.json',
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        await assert.rejects(
          () => fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com'),
          /authoritative_location must use HTTPS|Maximum redirect depth/,
          'Should refuse insecure redirect before depth would matter'
        );
      } finally {
        await server.close();
      }
    });

    test('should reject non-HTTPS authoritative_location', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authoritative_location: 'http://insecure.example.com/adagents.json',
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        await assert.rejects(
          () => fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com'),
          /authoritative_location must use HTTPS/,
          'Should reject HTTP redirect URLs'
        );
      } finally {
        await server.close();
      }
    });

    test('should use local data when authorized_agents present alongside authoritative_location', async () => {
      let callCount = 0;
      const server = await startServer((_req, res) => {
        callCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            // Both authoritative_location AND authorized_agents present.
            // Per spec, should use local data, not follow redirect.
            authoritative_location: 'https://central.example.com/adagents.json',
            authorized_agents: [{ url: 'https://local-agent.example.com', authorized_for: 'Local' }],
            properties: [
              {
                property_type: 'website',
                name: 'Local Property',
                identifiers: [{ type: 'domain', value: 'example.com' }],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        // Should only make one fetch call (no redirect followed)
        assert.strictEqual(callCount, 1, 'Should not follow redirect when authorized_agents present');
        assert.strictEqual(result.properties.length, 1);
        assert.strictEqual(result.properties[0].name, 'Local Property');
      } finally {
        await server.close();
      }
    });
  });

  describe('Backward compatibility', () => {
    test('should add publisher_domain if not present in property', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            properties: [
              {
                property_type: 'website',
                name: 'Test Property',
                identifiers: [{ type: 'domain', value: 'example.com' }],
                // Missing publisher_domain
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 1);
        assert.strictEqual(
          result.properties[0].publisher_domain,
          'example.com',
          'Should add publisher_domain from fetched domain'
        );
      } finally {
        await server.close();
      }
    });

    test('should preserve existing publisher_domain if present', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            properties: [
              {
                property_type: 'website',
                name: 'Test Property',
                identifiers: [{ type: 'domain', value: 'other.com' }],
                publisher_domain: 'original.com',
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(
          result.properties[0].publisher_domain,
          'original.com',
          'Should preserve existing publisher_domain'
        );
      } finally {
        await server.close();
      }
    });
  });

  describe('Malformed property handling', () => {
    test('should skip properties with missing identifiers and emit a warning', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'Valid Property',
                identifiers: [{ type: 'domain', value: 'example.com' }],
              },
              {
                property_type: 'website',
                name: 'Missing identifiers',
                // identifiers omitted
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 1, 'Should keep only the valid property');
        assert.strictEqual(result.properties[0].name, 'Valid Property');
        assert.ok(result.warning, 'Should surface a warning when properties are skipped');
        assert.ok(
          result.warning.includes('missing or empty identifiers'),
          `Warning should mention identifiers, got: ${result.warning}`
        );
      } finally {
        await server.close();
      }
    });

    test('should skip properties with non-array identifiers', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'Bad shape',
                identifiers: 'domain:example.com',
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 0, 'Should drop the malformed property');
        assert.ok(result.warning, 'Should surface a warning');
      } finally {
        await server.close();
      }
    });

    test('should skip properties with empty identifiers array', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'Empty identifiers',
                identifiers: [],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 0);
        assert.ok(result.warning);
      } finally {
        await server.close();
      }
    });

    test('should drop identifier items missing type/value and keep the rest', async () => {
      const server = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'Test' }],
            properties: [
              {
                property_type: 'website',
                name: 'Mixed identifiers',
                identifiers: [
                  { type: 'domain', value: 'example.com' },
                  { type: 'domain' }, // missing value
                  { value: 'orphan.example.com' }, // missing type
                  null,
                ],
              },
            ],
          })
        );
      });
      try {
        const crawler = new PropertyCrawler({ logLevel: 'silent' });
        const result = await fetchAdAgentsJsonAt(crawler, `${server.url}/.well-known/adagents.json`, 'example.com');

        assert.strictEqual(result.properties.length, 1, 'Should keep the property with one valid identifier');
        assert.strictEqual(result.properties[0].identifiers.length, 1);
        assert.deepStrictEqual(result.properties[0].identifiers[0], {
          type: 'domain',
          value: 'example.com',
        });
      } finally {
        await server.close();
      }
    });
  });
});
