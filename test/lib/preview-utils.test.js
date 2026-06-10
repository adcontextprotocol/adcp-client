const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { batchPreviewFormats, clearPreviewCache } = require('../../dist/lib/index.js');

describe('preview utilities', () => {
  beforeEach(() => {
    clearPreviewCache();
  });

  test('batchPreviewFormats can use a shared cache backend', async () => {
    const format = {
      name: 'Leaderboard',
      format_card: {
        format_id: {
          agent_url: 'https://creative.example/mcp',
          id: 'leaderboard',
        },
        manifest: {
          headline: 'Sale',
        },
      },
    };

    const cache = new Map();
    const backend = {
      get: key => cache.get(key),
      set: (key, entry) => cache.set(key, entry),
      delete: key => cache.delete(key),
      clear: () => cache.clear(),
    };

    let calls = 0;
    const creativeAgentClient = {
      previewCreative: async () => {
        calls += 1;
        return {
          data: {
            previews: [
              {
                preview_id: 'preview_1',
                renders: [
                  {
                    output_format: 'url',
                    preview_url: 'https://assets.example/previews/preview_1.png',
                  },
                ],
              },
            ],
          },
        };
      },
    };

    const first = await batchPreviewFormats([format], creativeAgentClient, { cacheBackend: backend });
    const second = await batchPreviewFormats([format], creativeAgentClient, { cacheBackend: backend });

    assert.strictEqual(calls, 1);
    assert.strictEqual(first[0].previewUrl, 'https://assets.example/previews/preview_1.png');
    assert.strictEqual(second[0].previewUrl, 'https://assets.example/previews/preview_1.png');
    assert.strictEqual(second[0].previewId, 'preview_1');
  });

  test('batchPreviewFormats expires cached entries through the backend', async () => {
    const format = {
      name: 'Medium Rectangle',
      format_card: {
        format_id: {
          agent_url: 'https://creative.example/mcp',
          id: 'medium_rectangle',
        },
        manifest: {
          headline: 'Fresh',
        },
      },
    };

    const expiredEntry = {
      previewUrl: 'https://assets.example/previews/old.png',
      previewId: 'old_preview',
      timestamp: Date.now() - 10000,
    };
    let cacheKey;
    let deletedKey;
    const backend = {
      get: key => {
        cacheKey = key;
        return expiredEntry;
      },
      set: () => {},
      delete: key => {
        deletedKey = key;
      },
    };

    const creativeAgentClient = {
      previewCreative: async () => ({
        data: {
          previews: [
            {
              preview_id: 'fresh_preview',
              renders: [
                {
                  output_format: 'url',
                  preview_url: 'https://assets.example/previews/fresh.png',
                },
              ],
            },
          ],
        },
      }),
    };

    const result = await batchPreviewFormats([format], creativeAgentClient, {
      cacheBackend: backend,
      cacheTtl: 1,
    });

    assert.strictEqual(deletedKey, cacheKey);
    assert.strictEqual(result[0].previewUrl, 'https://assets.example/previews/fresh.png');
  });
});
