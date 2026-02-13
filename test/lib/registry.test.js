const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { RegistryClient } = require('../../dist/lib/registry/index.js');

// Helper to mock global fetch
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const BRAND = {
  canonical_id: 'nike.com',
  canonical_domain: 'nike.com',
  brand_name: 'Nike',
  keller_type: 'master',
  source: 'brand_json',
};

const PROPERTY = {
  publisher_domain: 'nytimes.com',
  source: 'adagents_json',
  authorized_agents: [{ url: 'https://agent.example.com' }],
  properties: [
    {
      id: 'prop_1',
      type: 'website',
      name: 'NYTimes',
      identifiers: [{ type: 'domain', value: 'nytimes.com' }],
    },
  ],
  verified: true,
};

describe('RegistryClient', () => {
  let restore;

  afterEach(() => {
    if (restore) restore();
  });

  // ============ lookupBrand ============

  describe('lookupBrand', () => {
    test('resolves a domain to a brand', async () => {
      restore = mockFetch(async (url) => {
        assert.ok(url.includes('/api/brands/resolve?domain=nike.com'));
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupBrand('nike.com');

      assert.strictEqual(result.canonical_id, 'nike.com');
      assert.strictEqual(result.brand_name, 'Nike');
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Brand not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.lookupBrand('unknown.com');

      assert.strictEqual(result, null);
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('error.com'),
        (err) => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
    });

    test('encodes domain in URL', async () => {
      let capturedUrl;
      restore = mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupBrand('ex ample.com');

      assert.ok(capturedUrl.includes('domain=ex%20ample.com'));
    });

    test('uses custom base URL', async () => {
      let capturedUrl;
      restore = mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient({ baseUrl: 'https://custom.registry.io' });
      await client.lookupBrand('nike.com');

      assert.ok(capturedUrl.startsWith('https://custom.registry.io/api/brands/resolve'));
    });

    test('strips trailing slash from base URL', async () => {
      let capturedUrl;
      restore = mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient({ baseUrl: 'https://custom.io/' });
      await client.lookupBrand('nike.com');

      assert.ok(capturedUrl.startsWith('https://custom.io/api/'));
      assert.ok(!capturedUrl.includes('//api/'));
    });
  });

  // ============ lookupBrands ============

  describe('lookupBrands', () => {
    test('bulk resolves domains', async () => {
      const results = { 'nike.com': BRAND, 'unknown.com': null };

      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/brands/resolve/bulk'));
        assert.strictEqual(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        assert.deepStrictEqual(body.domains, ['nike.com', 'unknown.com']);
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupBrands(['nike.com', 'unknown.com']);

      assert.strictEqual(result['nike.com'].brand_name, 'Nike');
      assert.strictEqual(result['unknown.com'], null);
    });

    test('returns empty object for empty array', async () => {
      const client = new RegistryClient();
      const result = await client.lookupBrands([]);

      assert.deepStrictEqual(result, {});
    });

    test('rejects more than 100 domains', async () => {
      const client = new RegistryClient();
      const domains = Array.from({ length: 101 }, (_, i) => `domain${i}.com`);

      await assert.rejects(
        () => client.lookupBrands(domains),
        (err) => {
          assert.ok(err.message.includes('100'));
          return true;
        }
      );
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Bad Request', { status: 400 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrands(['x.com']),
        (err) => {
          assert.ok(err.message.includes('400'));
          return true;
        }
      );
    });
  });

  // ============ lookupProperty ============

  describe('lookupProperty', () => {
    test('resolves a domain to property info', async () => {
      restore = mockFetch(async (url) => {
        assert.ok(url.includes('/api/properties/resolve?domain=nytimes.com'));
        return new Response(JSON.stringify(PROPERTY), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupProperty('nytimes.com');

      assert.strictEqual(result.publisher_domain, 'nytimes.com');
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.properties.length, 1);
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Property not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.lookupProperty('unknown.com');

      assert.strictEqual(result, null);
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupProperty('error.com'),
        (err) => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
    });
  });

  // ============ lookupProperties ============

  describe('lookupProperties', () => {
    test('bulk resolves domains', async () => {
      const results = { 'nytimes.com': PROPERTY, 'unknown.com': null };

      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/properties/resolve/bulk'));
        assert.strictEqual(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        assert.deepStrictEqual(body.domains, ['nytimes.com', 'unknown.com']);
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupProperties(['nytimes.com', 'unknown.com']);

      assert.strictEqual(result['nytimes.com'].publisher_domain, 'nytimes.com');
      assert.strictEqual(result['unknown.com'], null);
    });

    test('returns empty object for empty array', async () => {
      const client = new RegistryClient();
      const result = await client.lookupProperties([]);

      assert.deepStrictEqual(result, {});
    });

    test('rejects more than 100 domains', async () => {
      const client = new RegistryClient();
      const domains = Array.from({ length: 101 }, (_, i) => `domain${i}.com`);

      await assert.rejects(
        () => client.lookupProperties(domains),
        (err) => {
          assert.ok(err.message.includes('100'));
          return true;
        }
      );
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Server Error', { status: 503 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupProperties(['x.com']),
        (err) => {
          assert.ok(err.message.includes('503'));
          return true;
        }
      );
    });
  });

  // ============ input validation ============

  describe('input validation', () => {
    test('lookupBrand rejects empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand(''),
        (err) => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('lookupBrand rejects whitespace-only domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('   '),
        (err) => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('lookupProperty rejects empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupProperty(''),
        (err) => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ malformed JSON ============

  describe('malformed JSON', () => {
    test('throws on invalid JSON from brand lookup', async () => {
      restore = mockFetch(async () => {
        return new Response('<html>not json</html>', { status: 200 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('test.com'),
        (err) => {
          assert.ok(err.message.includes('invalid JSON'));
          return true;
        }
      );
    });

    test('throws on invalid JSON from bulk lookup', async () => {
      restore = mockFetch(async () => {
        return new Response('gateway timeout', { status: 200 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrands(['test.com']),
        (err) => {
          assert.ok(err.message.includes('invalid JSON'));
          return true;
        }
      );
    });
  });
});
