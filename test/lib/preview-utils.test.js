const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { batchPreviewFormats, clearPreviewCache } = require('../../dist/lib/index.js');

describe('preview utilities', () => {
  beforeEach(() => {
    clearPreviewCache();
  });

  function previewFormat(id = 'leaderboard') {
    return {
      name: 'Leaderboard',
      format_card: {
        format_id: {
          agent_url: 'https://creative.example/mcp',
          id,
        },
        manifest: {
          headline: 'Sale',
        },
      },
    };
  }

  function creativeAgentClient({ previewUrl = 'https://assets.example/previews/preview_1.png', expiresAt } = {}) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      previewCreative: async () => {
        calls += 1;
        return {
          data: {
            response_type: 'single',
            expires_at: expiresAt,
            previews: [
              {
                preview_id: `preview_${calls}`,
                renders: [
                  {
                    output_format: 'url',
                    preview_url: previewUrl,
                  },
                ],
              },
            ],
          },
        };
      },
    };
  }

  test('batchPreviewFormats can use a shared cache backend', async () => {
    const format = previewFormat();

    const cache = new Map();
    const backend = {
      get: key => cache.get(key),
      set: (key, entry) => cache.set(key, entry),
      delete: key => cache.delete(key),
      clear: () => cache.clear(),
    };

    const client = creativeAgentClient();

    const first = await batchPreviewFormats([format], client, { cacheBackend: backend });
    const second = await batchPreviewFormats([format], client, { cacheBackend: backend });

    assert.strictEqual(client.calls, 1);
    assert.strictEqual(first[0].previewUrl, 'https://assets.example/previews/preview_1.png');
    assert.strictEqual(second[0].previewUrl, 'https://assets.example/previews/preview_1.png');
    assert.strictEqual(second[0].previewId, 'preview_1');
  });

  test('batchPreviewFormats expires cached entries through the backend', async () => {
    const format = previewFormat('medium_rectangle');

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

    const client = creativeAgentClient({ previewUrl: 'https://assets.example/previews/fresh.png' });

    const result = await batchPreviewFormats([format], client, {
      cacheBackend: backend,
      cacheTtl: 1,
    });

    assert.strictEqual(deletedKey, cacheKey);
    assert.strictEqual(result[0].previewUrl, 'https://assets.example/previews/fresh.png');
  });

  test('batchPreviewFormats expires cached entries by preview response expires_at', async () => {
    const format = previewFormat('expiring_preview');
    const expiredEntry = {
      previewUrl: 'https://assets.example/previews/old.png',
      previewId: 'old_preview',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      timestamp: Date.now(),
    };
    let deletedKey;
    const backend = {
      get: () => expiredEntry,
      set: () => {},
      delete: key => {
        deletedKey = key;
      },
    };

    const client = creativeAgentClient({ previewUrl: 'https://assets.example/previews/fresh.png' });

    const result = await batchPreviewFormats([format], client, {
      cacheBackend: backend,
      cacheTtl: 3600000,
    });

    assert.strictEqual(client.calls, 1);
    assert.ok(deletedKey);
    assert.strictEqual(result[0].previewUrl, 'https://assets.example/previews/fresh.png');
  });

  test('batchPreviewFormats stores preview response expires_at in cache entries', async () => {
    const format = previewFormat('store_expiry');
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    let cachedEntry;
    const backend = {
      get: () => null,
      set: (_key, entry) => {
        cachedEntry = entry;
      },
    };

    const client = creativeAgentClient({ expiresAt });

    await batchPreviewFormats([format], client, {
      cacheBackend: backend,
    });

    assert.strictEqual(cachedEntry.expiresAt, expiresAt);
  });

  test('batchPreviewFormats treats cache read failures as misses', async () => {
    const format = previewFormat('read_failure');
    const backend = {
      get: async () => {
        throw new Error('cache unavailable');
      },
      set: () => {},
    };

    const client = creativeAgentClient({ previewUrl: 'https://assets.example/previews/from-agent.png' });

    const result = await batchPreviewFormats([format], client, {
      cacheBackend: backend,
    });

    assert.strictEqual(client.calls, 1);
    assert.strictEqual(result[0].previewUrl, 'https://assets.example/previews/from-agent.png');
  });

  test('batchPreviewFormats returns successful previews when cache writes fail', async () => {
    const format = previewFormat('write_failure');
    const backend = {
      get: () => null,
      set: async () => {
        throw new Error('cache write failed');
      },
    };

    const client = creativeAgentClient({ previewUrl: 'https://assets.example/previews/uncached.png' });

    const result = await batchPreviewFormats([format], client, {
      cacheBackend: backend,
    });

    assert.strictEqual(result[0].previewUrl, 'https://assets.example/previews/uncached.png');
    assert.strictEqual(result[0].error, undefined);
  });
});
