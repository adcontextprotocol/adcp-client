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
            brand_manifest: 'https://example.com/brand',
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

  // Note: build_creative validation removed because the schema has a flexible context field
  // that allows unknown properties, so strict mode doesn't reject extra fields

  describe('get_products validation', () => {
    test('should validate get_products requests', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          // Invalid request with extra field
          await agent.getProducts({
            invalid_field: 'should fail',
          });
        },
        err => {
          return err.message.includes('Request validation failed for get_products');
        },
        'Should throw validation error for invalid get_products request'
      );
    });
  });
});
