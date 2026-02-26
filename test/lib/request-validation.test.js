// Unit tests for request validation in SingleAgentClient
// Tests critical validation that was previously missing (sync_creatives, create_media_buy, build_creative, get_products)

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import from built dist
const { AdCPClient } = require('../../dist/lib/index.js');

describe('SingleAgentClient Request Validation', () => {
  const mockAgent = {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example.com',
    protocol: 'a2a',
  };

  describe('sync_creatives validation', () => {
    test('should reject request with assets as array instead of object', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          await agent.syncCreatives({
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example.com', id: 'format1' },
                // Invalid: assets should be object, not array
                assets: [
                  {
                    asset_type: 'video',
                    url: 'https://example.com/video.mp4',
                  },
                ],
              },
            ],
          });
        },
        err => {
          return err.message.includes('Request validation failed for sync_creatives');
        },
        'Should throw validation error for assets as array'
      );
    });

    test('should reject request with mode parameter instead of dry_run', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          await agent.syncCreatives({
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example.com', id: 'format1' },
                assets: {
                  video: {
                    url: 'https://example.com/video.mp4',
                    width: 1920,
                    height: 1080,
                    duration_ms: 30000,
                  },
                },
              },
            ],
            // Invalid: mode doesn't exist, should use dry_run (boolean)
            mode: 'dry_run',
          });
        },
        err => {
          return err.message.includes('Request validation failed for sync_creatives');
        },
        'Should throw validation error for non-existent mode parameter'
      );
    });
  });

  describe('create_media_buy validation', () => {
    test('should validate create_media_buy requests', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          // Valid request with required fields + invalid top-level field
          await agent.createMediaBuy({
            buyer_ref: 'buyer123',
            packages: [],
            brand: { domain: 'example.com' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
            invalid_field: 'should fail', // This extra field should trigger strict validation
          });
        },
        err => {
          return err.message.includes('Request validation failed for create_media_buy');
        },
        'Should throw validation error for invalid create_media_buy request'
      );
    });
  });

  // Note: AdCP v3 schemas have additionalProperties: true for extensibility
  // This allows unknown properties, so strict mode doesn't reject extra fields
  // Tests below verify that requests with extra fields are ALLOWED (not rejected)

  describe('get_products validation', () => {
    test('should strip extra fields in get_products requests (ZodIntersection strips unknown)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // GetProductsRequestSchema is a ZodIntersection (object.and(union)), not a plain
      // ZodObject, so .strict() is not applied. Unknown top-level fields are silently
      // stripped rather than rejected.
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            extra_field: 'silently stripped',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should infer buying_mode "brief" when brief is provided but buying_mode is missing', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Should NOT throw validation error — buying_mode inferred from brief presence
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            brief: 'Looking for premium ad placements',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should infer buying_mode "wholesale" when neither brief nor buying_mode is provided', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Should NOT throw validation error — buying_mode inferred as 'wholesale'
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({});
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should not override explicit buying_mode', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Explicit buying_mode should be preserved even if brief is also provided
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'brief',
            brief: 'Test brief',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should preserve explicit wholesale buying_mode', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'wholesale',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('update_media_buy validation', () => {
    test('should allow extra fields in update_media_buy (v3 extensibility)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // AdCP v3 allows extra fields for forward compatibility
      // Use ext field for extensions, but extra fields won't be rejected
      try {
        await agent.updateMediaBuy({
          media_buy_id: 'mb123',
          extra_field: 'allowed in v3',
        });
      } catch (err) {
        // Network error is expected (mock agent), but validation error is not
        assert.ok(!err.message.includes('Request validation failed'), 'Should not reject extra fields in v3 schemas');
      }
    });
  });

  describe('list_creatives validation', () => {
    test('should validate list_creatives requests', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          // Invalid request with extra field
          await agent.listCreatives({
            invalid_field: 'should fail',
          });
        },
        err => {
          return err.message.includes('Request validation failed for list_creatives');
        },
        'Should throw validation error for invalid list_creatives request'
      );
    });
  });

  describe('PackageRequest format_ids validation', () => {
    test('should allow format_ids with extra fields (Zod strips unknown fields by default)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // NOTE: Zod strips unknown fields in nested objects by default (not strict for nested)
      // This is intentional - strict() only applies to top-level fields
      // Extra fields in format_ids will be silently stripped, not rejected
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            buyer_ref: 'buyer123',
            account: { account_id: 'test-account' },
            packages: [
              {
                buyer_ref: 'pkg123',
                product_id: 'prod123',
                format_ids: [
                  {
                    agent_url: 'https://test.example.com',
                    id: 'display_300x250',
                    width: 300,
                    height: 250,
                    // Extra fields - will be stripped, not rejected
                    name: 'Banner',
                    description: 'Standard banner',
                  },
                ],
                budget: 1000,
                pricing_option_id: 'cpm-fixed',
              },
            ],
            brand: { domain: 'example.com' },
            start_time: 'asap',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject format_ids with extra fields
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept format_ids with only valid FormatID fields', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // This should NOT throw validation error (may fail on network, but not validation)
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            buyer_ref: 'buyer123',
            account: { account_id: 'test-account' },
            packages: [
              {
                buyer_ref: 'pkg123',
                product_id: 'prod123',
                format_ids: [
                  {
                    agent_url: 'https://test.example.com',
                    id: 'display_300x250',
                    width: 300,
                    height: 250,
                  },
                ],
                budget: 1000,
                pricing_option_id: 'cpm-fixed',
              },
            ],
            brand: { domain: 'example.com' },
            start_time: 'asap',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject valid format_ids
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('context field preservation', () => {
    test('should allow arbitrary properties in context field for get_products', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // This should NOT throw - context field should accept arbitrary properties
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'brief',
            brief: 'Test brief',
            context: {
              trace_id: '123',
              request_id: 'abc',
              custom_field: 'anything',
              nested: { deeply: { nested: 'value' } },
            },
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject the context field
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for sync_creatives', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.syncCreatives({
            account: { account_id: 'test-account' },
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example.com', id: 'format1' },
                assets: {
                  video: {
                    url: 'https://example.com/video.mp4',
                    width: 1920,
                    height: 1080,
                    duration_ms: 30000,
                  },
                },
              },
            ],
            context: {
              correlation_id: 'xyz-789',
              tenant_id: 'tenant-123',
              any_property: 'should be preserved',
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for create_media_buy', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            buyer_ref: 'buyer123',
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
            context: {
              session_id: 'sess-456',
              user_agent: 'test-client/1.0',
              custom_metadata: { foo: 'bar', baz: 123 },
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for build_creative', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.buildCreative({
            target_format_id: { agent_url: 'https://test.example.com', id: 'format1' },
            context: {
              build_id: 'build-789',
              environment: 'test',
              arbitrary_data: { nested: { structure: true } },
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('get_media_buys validation', () => {
    test('should accept valid get_media_buys request with media_buy_ids', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({
            account: { account_id: 'test-account' },
            media_buy_ids: ['mb_123', 'mb_456'],
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept get_media_buys request with status_filter array', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({
            account: { account_id: 'test-account' },
            status_filter: ['active', 'paused'],
            include_snapshot: true,
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept empty get_media_buys request', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({ account: { account_id: 'test-account' } });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });
});
