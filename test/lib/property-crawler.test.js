// Unit tests for PropertyCrawler
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Mock fetch globally
let originalFetch;
let fetchMock;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock = null;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(responses) {
  let callCount = 0;
  global.fetch = async (url, options) => {
    const response = responses[callCount++];
    if (!response) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText || 'OK',
      headers: options?.headers || {},
      json: async () => response.data
    };
  };
}

describe('PropertyCrawler', () => {
  describe('User-Agent header', () => {
    test('should send browser-like headers when fetching adagents.json', async () => {
      let capturedHeaders = null;

      global.fetch = async (url, options) => {
        capturedHeaders = options?.headers || {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
            authorized_agents: [
              {
                url: 'https://test-agent.example.com',
                authorized_for: 'Test agent'
              }
            ],
            properties: [
              {
                property_type: 'website',
                name: 'example.com',
                identifiers: [{ type: 'domain', value: 'example.com' }]
              }
            ]
          })
        };
      };

      // Import PropertyCrawler after setting up mock
      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      // Verify browser-like headers are sent (for CDN bot detection)
      assert.ok(capturedHeaders, 'Headers should be captured');
      assert.ok(capturedHeaders['User-Agent'], 'User-Agent header should be present');
      assert.ok(
        capturedHeaders['User-Agent'].includes('Mozilla/5.0'),
        `User-Agent should be browser-like, got: ${capturedHeaders['User-Agent']}`
      );
      assert.ok(capturedHeaders['Accept'], 'Accept header should be present');
      assert.ok(capturedHeaders['Accept-Language'], 'Accept-Language header should be present');
      assert.ok(capturedHeaders['From'], 'From header should be present for crawler identification');
    });

    test('should include From header with library version', async () => {
      let capturedHeaders = null;

      global.fetch = async (url, options) => {
        capturedHeaders = options?.headers || {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            authorized_agents: [],
            properties: []
          })
        };
      };

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const { LIBRARY_VERSION } = require('../../dist/lib/version.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      await crawler.fetchAdAgentsJson('example.com');

      // Check that we send browser-like User-Agent
      assert.ok(
        capturedHeaders['User-Agent'].includes('Mozilla/5.0'),
        'User-Agent should be browser-like for CDN compatibility'
      );

      // Check that we identify ourselves via From header (RFC 9110)
      assert.ok(
        capturedHeaders['From'].includes(LIBRARY_VERSION),
        'From header should include library version'
      );
      assert.ok(
        capturedHeaders['From'].includes('adcp-property-crawler'),
        'From header should identify PropertyCrawler'
      );
    });
  });

  describe('Graceful degradation', () => {
    test('should return inferred property when properties array is missing but authorized_agents exists', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
          authorized_agents: [
            {
              url: 'https://weather.sales-agent.scope3.com',
              authorized_for: 'Official sales agent for Weather US display inventory'
            }
          ],
          last_updated: '2025-10-15T12:00:00Z'
          // Missing properties array
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('weather.com');

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
    });

    test('should return warning when inferring property from domain', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          authorized_agents: [
            { url: 'https://agent.example.com', authorized_for: 'Test' }
          ]
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      assert.ok(result.warning, 'Should include warning');
      assert.ok(
        result.warning.includes('Inferred from domain'),
        'Warning should mention inference'
      );
      assert.ok(
        result.warning.includes('publisher should add explicit properties array'),
        'Warning should guide publisher to add properties'
      );
    });

    test('should return empty array when no properties and no authorized_agents', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
          last_updated: '2025-10-15T12:00:00Z'
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      assert.ok(result.properties, 'Should return properties object');
      assert.strictEqual(result.properties.length, 0, 'Should return empty array');
      assert.strictEqual(result.warning, undefined, 'Should not have warning');
    });

    test('should return empty array when properties array is empty and no authorized_agents', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          properties: []
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      assert.strictEqual(result.properties.length, 0);
      assert.strictEqual(result.warning, undefined);
    });

    test('should return explicit properties when properties array exists', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          authorized_agents: [
            { url: 'https://agent.example.com', authorized_for: 'Test' }
          ],
          properties: [
            {
              property_type: 'website',
              name: 'My Custom Property',
              identifiers: [
                { type: 'domain', value: 'example.com' },
                { type: 'subdomain', value: 'www.example.com' }
              ]
            }
          ]
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      // Should return explicit properties, not inferred ones
      assert.strictEqual(result.properties.length, 1);
      assert.strictEqual(result.properties[0].name, 'My Custom Property');
      assert.strictEqual(result.properties[0].identifiers.length, 2);
      assert.strictEqual(result.warning, undefined, 'Should not have warning for explicit properties');
    });
  });

  describe('CrawlResult warnings', () => {
    test('should collect warnings from multiple domains', async () => {
      let fetchCallCount = 0;
      const responses = [
        // Domain 1: has authorized_agents, no properties
        {
          authorized_agents: [{ url: 'https://agent1.com', authorized_for: 'Agent 1' }]
        },
        // Domain 2: has explicit properties
        {
          properties: [
            {
              property_type: 'website',
              name: 'example2.com',
              identifiers: [{ type: 'domain', value: 'example2.com' }]
            }
          ]
        }
      ];

      global.fetch = async (url) => {
        const response = responses[fetchCallCount++];
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => response
        };
      };

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchPublisherProperties(['example1.com', 'example2.com']);

      // Should have warnings array
      assert.ok(result.warnings, 'Should return warnings array');
      assert.strictEqual(result.warnings.length, 1, 'Should have one warning');
      assert.strictEqual(result.warnings[0].domain, 'example1.com');
      assert.ok(result.warnings[0].message.includes('Inferred from domain'));

      // Should have properties from both domains
      assert.ok(result.properties['example1.com'], 'Should have inferred property for domain1');
      assert.ok(result.properties['example2.com'], 'Should have explicit property for domain2');
    });
  });

  describe('Error handling', () => {
    test('should throw error for HTTP 404', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({})
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      await assert.rejects(
        async () => await crawler.fetchAdAgentsJson('notfound.com'),
        /HTTP 404/
      );
    });

    test('should throw error for network failures', async () => {
      global.fetch = async () => {
        throw new Error('Network error');
      };

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      await assert.rejects(
        async () => await crawler.fetchAdAgentsJson('error.com'),
        /Network error/
      );
    });
  });

  describe('Backward compatibility', () => {
    test('should add publisher_domain if not present in property', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          properties: [
            {
              property_type: 'website',
              name: 'Test Property',
              identifiers: [{ type: 'domain', value: 'example.com' }]
              // Missing publisher_domain
            }
          ]
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      assert.strictEqual(result.properties.length, 1);
      assert.strictEqual(
        result.properties[0].publisher_domain,
        'example.com',
        'Should add publisher_domain from fetched domain'
      );
    });

    test('should preserve existing publisher_domain if present', async () => {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          properties: [
            {
              property_type: 'website',
              name: 'Test Property',
              identifiers: [{ type: 'domain', value: 'other.com' }],
              publisher_domain: 'original.com'
            }
          ]
        })
      });

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      const result = await crawler.fetchAdAgentsJson('example.com');

      assert.strictEqual(
        result.properties[0].publisher_domain,
        'original.com',
        'Should preserve existing publisher_domain'
      );
    });
  });
});
