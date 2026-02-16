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
      restore = mockFetch(async url => {
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
        err => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
    });

    test('encodes domain in URL', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupBrand('ex ample.com');

      assert.ok(capturedUrl.includes('domain=ex%20ample.com'));
    });

    test('uses custom base URL', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient({ baseUrl: 'https://custom.registry.io' });
      await client.lookupBrand('nike.com');

      assert.ok(capturedUrl.startsWith('https://custom.registry.io/api/brands/resolve'));
    });

    test('strips trailing slash from base URL', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
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
        err => {
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
        err => {
          assert.ok(err.message.includes('400'));
          return true;
        }
      );
    });
  });

  // ============ lookupProperty ============

  describe('lookupProperty', () => {
    test('resolves a domain to property info', async () => {
      restore = mockFetch(async url => {
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
        err => {
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
        err => {
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
        err => {
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
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('lookupBrand rejects whitespace-only domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('   '),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('lookupProperty rejects empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupProperty(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ authentication ============

  describe('authentication', () => {
    test('sends Authorization header when apiKey is configured', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test_123' });
      await client.lookupBrand('nike.com');

      assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_test_123');
    });

    test('sends Authorization header on bulk POST requests', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify({ results: { 'nike.com': BRAND } }), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test_456' });
      await client.lookupBrands(['nike.com']);

      assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_test_456');
      assert.strictEqual(capturedOpts.headers['Content-Type'], 'application/json');
    });

    test('does not send Authorization header when no apiKey', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      // Ensure env var is not set
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;

      try {
        const client = new RegistryClient();
        await client.lookupBrand('nike.com');

        assert.strictEqual(capturedOpts.headers['Authorization'], undefined);
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('reads apiKey from ADCP_REGISTRY_API_KEY env var', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      process.env.ADCP_REGISTRY_API_KEY = 'sk_from_env';

      try {
        const client = new RegistryClient();
        await client.lookupBrand('nike.com');

        assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_from_env');
      } finally {
        if (savedEnv !== undefined) {
          process.env.ADCP_REGISTRY_API_KEY = savedEnv;
        } else {
          delete process.env.ADCP_REGISTRY_API_KEY;
        }
      }
    });

    test('explicit apiKey takes precedence over env var', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      process.env.ADCP_REGISTRY_API_KEY = 'sk_from_env';

      try {
        const client = new RegistryClient({ apiKey: 'sk_explicit' });
        await client.lookupBrand('nike.com');

        assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_explicit');
      } finally {
        if (savedEnv !== undefined) {
          process.env.ADCP_REGISTRY_API_KEY = savedEnv;
        } else {
          delete process.env.ADCP_REGISTRY_API_KEY;
        }
      }
    });
  });

  // ============ saveBrand ============

  describe('saveBrand', () => {
    test('saves a brand with auth header', async () => {
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(
          JSON.stringify({
            success: true,
            message: 'Brand saved',
            domain: 'acme.com',
            id: 'br_123',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.saveBrand({ domain: 'acme.com', brand_name: 'Acme' });

      assert.ok(capturedUrl.includes('/api/brands/save'));
      assert.strictEqual(capturedOpts.method, 'POST');
      assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_test');
      assert.strictEqual(capturedOpts.headers['Content-Type'], 'application/json');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.domain, 'acme.com');
      assert.strictEqual(body.brand_name, 'Acme');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.id, 'br_123');
    });

    test('throws without apiKey', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () => client.saveBrand({ domain: 'acme.com', brand_name: 'Acme' }),
          err => {
            assert.ok(err.message.includes('apiKey is required'));
            return true;
          }
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('throws without domain', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () => client.saveBrand({ domain: '', brand_name: 'Acme' }),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('throws without brand_name', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () => client.saveBrand({ domain: 'acme.com', brand_name: '' }),
        err => {
          assert.ok(err.message.includes('brand_name is required'));
          return true;
        }
      );
    });

    test('throws on 409 conflict', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Cannot edit authoritative brand' }), { status: 409 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () => client.saveBrand({ domain: 'nike.com', brand_name: 'Nike' }),
        err => {
          assert.ok(err.message.includes('409'));
          return true;
        }
      );
    });

    test('includes brand_manifest when provided', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify({ success: true, message: 'ok', domain: 'acme.com', id: 'br_123' }), {
          status: 200,
        });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await client.saveBrand({
        domain: 'acme.com',
        brand_name: 'Acme',
        brand_manifest: { colors: { primary: '#FF0000' } },
      });

      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.brand_manifest, { colors: { primary: '#FF0000' } });
    });
  });

  // ============ saveProperty ============

  describe('saveProperty', () => {
    test('saves a property with auth header', async () => {
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(
          JSON.stringify({
            success: true,
            message: 'Property saved',
            id: 'pr_456',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.saveProperty({
        publisher_domain: 'example.com',
        authorized_agents: [{ url: 'https://agent.example.com' }],
      });

      assert.ok(capturedUrl.includes('/api/properties/save'));
      assert.strictEqual(capturedOpts.method, 'POST');
      assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_test');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.publisher_domain, 'example.com');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.id, 'pr_456');
    });

    test('throws without apiKey', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () =>
            client.saveProperty({
              publisher_domain: 'example.com',
              authorized_agents: [{ url: 'https://agent.example.com' }],
            }),
          err => {
            assert.ok(err.message.includes('apiKey is required'));
            return true;
          }
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('throws without publisher_domain', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.saveProperty({
            publisher_domain: '',
            authorized_agents: [{ url: 'https://agent.example.com' }],
          }),
        err => {
          assert.ok(err.message.includes('publisher_domain is required'));
          return true;
        }
      );
    });

    test('throws without authorized_agents', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.saveProperty({
            publisher_domain: 'example.com',
            authorized_agents: [],
          }),
        err => {
          assert.ok(err.message.includes('authorized_agents is required'));
          return true;
        }
      );
    });

    test('throws on 401 unauthorized', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 });
      });

      const client = new RegistryClient({ apiKey: 'sk_bad' });
      await assert.rejects(
        () =>
          client.saveProperty({
            publisher_domain: 'example.com',
            authorized_agents: [{ url: 'https://agent.example.com' }],
          }),
        err => {
          assert.ok(err.message.includes('401'));
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
        err => {
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
        err => {
          assert.ok(err.message.includes('invalid JSON'));
          return true;
        }
      );
    });
  });

  // ============ listBrands ============

  describe('listBrands', () => {
    test('lists brands without options', async () => {
      const responseData = { brands: [BRAND], stats: { total: 1 } };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(responseData), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listBrands();

      assert.ok(capturedUrl.includes('/api/brands/registry'));
      assert.ok(!capturedUrl.includes('?'));
      assert.strictEqual(result.brands.length, 1);
      assert.strictEqual(result.brands[0].brand_name, 'Nike');
    });

    test('passes search, limit, and offset params', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ brands: [], stats: {} }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listBrands({ search: 'nike', limit: 10, offset: 20 });

      assert.ok(capturedUrl.includes('search=nike'));
      assert.ok(capturedUrl.includes('limit=10'));
      assert.ok(capturedUrl.includes('offset=20'));
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.listBrands(),
        err => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
    });
  });

  // ============ getBrandJson ============

  describe('getBrandJson', () => {
    test('fetches brand.json data for a domain', async () => {
      const brandJson = { name: 'Nike', domain: 'nike.com', colors: { primary: '#111' } };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(brandJson), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getBrandJson('nike.com');

      assert.ok(capturedUrl.includes('/api/brands/brand-json?domain=nike.com'));
      assert.strictEqual(result.name, 'Nike');
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.getBrandJson('unknown.com');

      assert.strictEqual(result, null);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getBrandJson(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ enrichBrand ============

  describe('enrichBrand', () => {
    test('enriches a brand by domain', async () => {
      const enriched = { domain: 'nike.com', logo: 'https://logo.url/nike.png' };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(enriched), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.enrichBrand('nike.com');

      assert.ok(capturedUrl.includes('/api/brands/enrich?domain=nike.com'));
      assert.strictEqual(result.domain, 'nike.com');
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.enrichBrand(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ listProperties ============

  describe('listProperties', () => {
    test('lists properties without options', async () => {
      const responseData = { properties: [PROPERTY], stats: { total: 1 } };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(responseData), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listProperties();

      assert.ok(capturedUrl.includes('/api/properties/registry'));
      assert.ok(!capturedUrl.includes('?'));
      assert.strictEqual(result.properties.length, 1);
    });

    test('passes search, limit, and offset params', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ properties: [], stats: {} }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listProperties({ search: 'nytimes', limit: 5, offset: 10 });

      assert.ok(capturedUrl.includes('search=nytimes'));
      assert.ok(capturedUrl.includes('limit=5'));
      assert.ok(capturedUrl.includes('offset=10'));
    });
  });

  // ============ validateProperty ============

  describe('validateProperty', () => {
    test('validates a domain property', async () => {
      const validation = { valid: true, errors: [], warnings: [] };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(validation), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.validateProperty('nytimes.com');

      assert.ok(capturedUrl.includes('/api/properties/validate?domain=nytimes.com'));
      assert.strictEqual(result.valid, true);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.validateProperty(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ listAgents ============

  describe('listAgents', () => {
    test('lists agents without options', async () => {
      const responseData = { agents: [{ url: 'https://agent.example.com', type: 'sales' }], count: 1, sources: {} };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(responseData), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listAgents();

      assert.ok(capturedUrl.includes('/api/registry/agents'));
      assert.ok(!capturedUrl.includes('?'));
      assert.strictEqual(result.count, 1);
    });

    test('passes type, health, capabilities, and properties params', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ agents: [], count: 0, sources: {} }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listAgents({ type: 'sales', health: true, capabilities: true, properties: true });

      assert.ok(capturedUrl.includes('type=sales'));
      assert.ok(capturedUrl.includes('health=true'));
      assert.ok(capturedUrl.includes('capabilities=true'));
      assert.ok(capturedUrl.includes('properties=true'));
    });
  });

  // ============ listPublishers ============

  describe('listPublishers', () => {
    test('lists publishers', async () => {
      const responseData = { publishers: [{ domain: 'nytimes.com' }], count: 1, sources: {} };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(responseData), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listPublishers();

      assert.ok(capturedUrl.includes('/api/registry/publishers'));
      assert.strictEqual(result.count, 1);
    });
  });

  // ============ getRegistryStats ============

  describe('getRegistryStats', () => {
    test('fetches registry statistics', async () => {
      const stats = { total_agents: 42, total_publishers: 15, total_brands: 100 };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(stats), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getRegistryStats();

      assert.ok(capturedUrl.includes('/api/registry/stats'));
      assert.strictEqual(result.total_agents, 42);
    });
  });

  // ============ lookupDomain ============

  describe('lookupDomain', () => {
    test('looks up agents authorized for a domain', async () => {
      const domainResult = { domain: 'nytimes.com', authorized_agents: [{ url: 'https://agent.example.com' }] };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(domainResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupDomain('nytimes.com');

      assert.ok(capturedUrl.includes('/api/registry/lookup/domain/nytimes.com'));
      assert.strictEqual(result.domain, 'nytimes.com');
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupDomain(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ lookupPropertyByIdentifier ============

  describe('lookupPropertyByIdentifier', () => {
    test('looks up property by type and value', async () => {
      const propertyResult = { publisher_domain: 'nytimes.com', type: 'domain', value: 'nytimes.com' };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(propertyResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupPropertyByIdentifier('domain', 'nytimes.com');

      assert.ok(capturedUrl.includes('/api/registry/lookup/property'));
      assert.ok(capturedUrl.includes('type=domain'));
      assert.ok(capturedUrl.includes('value=nytimes.com'));
      assert.strictEqual(result.publisher_domain, 'nytimes.com');
    });

    test('throws on empty type', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupPropertyByIdentifier('', 'nytimes.com'),
        err => {
          assert.ok(err.message.includes('type is required'));
          return true;
        }
      );
    });

    test('throws on empty value', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupPropertyByIdentifier('domain', ''),
        err => {
          assert.ok(err.message.includes('value is required'));
          return true;
        }
      );
    });
  });

  // ============ getAgentDomains ============

  describe('getAgentDomains', () => {
    test('gets domains for an agent', async () => {
      const domainsResult = { agent_url: 'https://agent.example.com', domains: ['nytimes.com', 'wsj.com'], count: 2 };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(domainsResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getAgentDomains('https://agent.example.com');

      assert.ok(capturedUrl.includes('/api/registry/lookup/agent/'));
      assert.ok(capturedUrl.includes('/domains'));
      assert.strictEqual(result.count, 2);
      assert.deepStrictEqual(result.domains, ['nytimes.com', 'wsj.com']);
    });

    test('throws on empty agentUrl', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getAgentDomains(''),
        err => {
          assert.ok(err.message.includes('agentUrl is required'));
          return true;
        }
      );
    });
  });

  // ============ validatePropertyAuthorization ============

  describe('validatePropertyAuthorization', () => {
    test('validates property authorization', async () => {
      const authResult = {
        agent_url: 'https://agent.example.com',
        identifier_type: 'domain',
        identifier_value: 'nytimes.com',
        authorized: true,
        checked_at: '2025-01-01T00:00:00Z',
      };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(authResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.validatePropertyAuthorization('https://agent.example.com', 'domain', 'nytimes.com');

      assert.ok(capturedUrl.includes('/api/registry/validate/property-authorization'));
      assert.ok(capturedUrl.includes('identifier_type=domain'));
      assert.ok(capturedUrl.includes('identifier_value=nytimes.com'));
      assert.strictEqual(result.authorized, true);
    });

    test('throws on empty agentUrl', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.validatePropertyAuthorization('', 'domain', 'nytimes.com'),
        err => {
          assert.ok(err.message.includes('agentUrl is required'));
          return true;
        }
      );
    });
  });

  // ============ validateProductAuthorization ============

  describe('validateProductAuthorization', () => {
    test('validates product authorization via POST', async () => {
      const authResult = { authorized: true, results: [] };
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(authResult), { status: 200 });
      });

      const publisherProperties = [{ publisher_domain: 'nytimes.com', property_ids: ['prop_1'] }];
      const client = new RegistryClient();
      const result = await client.validateProductAuthorization('https://agent.example.com', publisherProperties);

      assert.ok(capturedUrl.includes('/api/registry/validate/product-authorization'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.agent_url, 'https://agent.example.com');
      assert.deepStrictEqual(body.publisher_properties, publisherProperties);
      assert.strictEqual(result.authorized, true);
    });
  });

  // ============ expandProductIdentifiers ============

  describe('expandProductIdentifiers', () => {
    test('expands product identifiers via POST', async () => {
      const expandResult = { expanded: [{ id: 'prod_1', identifiers: ['ident_a'] }] };
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(expandResult), { status: 200 });
      });

      const publisherProperties = [{ publisher_domain: 'nytimes.com', property_ids: ['prop_1'] }];
      const client = new RegistryClient();
      const result = await client.expandProductIdentifiers('https://agent.example.com', publisherProperties);

      assert.ok(capturedUrl.includes('/api/registry/expand/product-identifiers'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.agent_url, 'https://agent.example.com');
    });
  });

  // ============ validateAdagents ============

  describe('validateAdagents', () => {
    test('validates adagents.json for a domain via POST', async () => {
      const validationResult = { valid: true, errors: [], warnings: [] };
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(validationResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.validateAdagents('nytimes.com');

      assert.ok(capturedUrl.includes('/api/adagents/validate'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.domain, 'nytimes.com');
      assert.strictEqual(result.valid, true);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.validateAdagents(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ createAdagents ============

  describe('createAdagents', () => {
    test('creates adagents.json via POST', async () => {
      const created = { adagents: { version: '1.0', agents: [] } };
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(created), { status: 200 });
      });

      const config = { publisher_domain: 'nytimes.com', agents: [{ url: 'https://agent.example.com' }] };
      const client = new RegistryClient();
      const result = await client.createAdagents(config);

      assert.ok(capturedUrl.includes('/api/adagents/create'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.publisher_domain, 'nytimes.com');
      assert.strictEqual(result.adagents.version, '1.0');
    });
  });

  // ============ search ============

  describe('search', () => {
    test('searches brands, publishers, and properties', async () => {
      const searchResult = { brands: [BRAND], publishers: [], properties: [] };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(searchResult), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.search('nike');

      assert.ok(capturedUrl.includes('/api/search?q=nike'));
      assert.strictEqual(result.brands.length, 1);
    });

    test('encodes query parameter', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ brands: [], publishers: [], properties: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.search('new york times');

      assert.ok(capturedUrl.includes('q=new%20york%20times'));
    });

    test('throws on empty query', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.search(''),
        err => {
          assert.ok(err.message.includes('query is required'));
          return true;
        }
      );
    });
  });

  // ============ lookupManifestRef ============

  describe('lookupManifestRef', () => {
    test('looks up manifest ref by domain', async () => {
      const manifestRef = { domain: 'nike.com', ref: 'https://nike.com/.well-known/brand.json' };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(manifestRef), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupManifestRef('nike.com');

      assert.ok(capturedUrl.includes('/api/manifest-refs/lookup'));
      assert.ok(capturedUrl.includes('domain=nike.com'));
      assert.strictEqual(result.domain, 'nike.com');
    });

    test('passes optional type parameter', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupManifestRef('nike.com', 'brand');

      assert.ok(capturedUrl.includes('type=brand'));
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupManifestRef(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });

  // ============ discoverAgent ============

  describe('discoverAgent', () => {
    test('discovers agent capabilities by URL', async () => {
      const agentInfo = { url: 'https://agent.example.com', protocols: ['a2a', 'mcp'], name: 'Test Agent' };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(agentInfo), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.discoverAgent('https://agent.example.com');

      assert.ok(capturedUrl.includes('/api/public/discover-agent'));
      assert.strictEqual(result.name, 'Test Agent');
    });

    test('throws on empty url', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.discoverAgent(''),
        err => {
          assert.ok(err.message.includes('url is required'));
          return true;
        }
      );
    });
  });

  // ============ getAgentFormats ============

  describe('getAgentFormats', () => {
    test('gets creative formats for an agent', async () => {
      const formats = { url: 'https://agent.example.com', formats: ['banner', 'video', 'native'] };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(formats), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getAgentFormats('https://agent.example.com');

      assert.ok(capturedUrl.includes('/api/public/agent-formats'));
      assert.deepStrictEqual(result.formats, ['banner', 'video', 'native']);
    });

    test('throws on empty url', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getAgentFormats(''),
        err => {
          assert.ok(err.message.includes('url is required'));
          return true;
        }
      );
    });
  });

  // ============ getAgentProducts ============

  describe('getAgentProducts', () => {
    test('gets products for an agent', async () => {
      const products = { url: 'https://agent.example.com', products: [{ id: 'prod_1', name: 'Leaderboard' }] };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(products), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getAgentProducts('https://agent.example.com');

      assert.ok(capturedUrl.includes('/api/public/agent-products'));
      assert.strictEqual(result.products[0].id, 'prod_1');
    });

    test('throws on empty url', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getAgentProducts(''),
        err => {
          assert.ok(err.message.includes('url is required'));
          return true;
        }
      );
    });
  });

  // ============ validatePublisher ============

  describe('validatePublisher', () => {
    test('validates a publisher domain', async () => {
      const validation = { domain: 'nytimes.com', valid: true, checks: { dns: true, adagents: true } };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(validation), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.validatePublisher('nytimes.com');

      assert.ok(capturedUrl.includes('/api/public/validate-publisher'));
      assert.ok(capturedUrl.includes('domain=nytimes.com'));
      assert.strictEqual(result.valid, true);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.validatePublisher(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });
  });
});
