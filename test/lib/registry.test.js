const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { RegistryClient, buildCommunityMirrorAdagents } = require('../../dist/lib/registry/index.js');

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

  // ============ findCompany ============

  describe('findCompany', () => {
    const COMPANY_RESULTS = [
      {
        domain: 'coca-cola.com',
        canonical_domain: 'coca-cola.com',
        brand_name: 'Coca-Cola',
        house_domain: 'coca-cola.com',
        keller_type: 'master',
        source: 'brand_json',
      },
      {
        domain: 'coke.com',
        canonical_domain: 'coke.com',
        brand_name: 'Coke',
        parent_brand: 'Coca-Cola',
        keller_type: 'sub_brand',
        brand_agent_url: 'https://agent.coca-cola.com',
        source: 'brand_json',
      },
    ];

    test('searches companies by query', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: COMPANY_RESULTS }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.findCompany('Coke');

      assert.ok(capturedUrl.includes('/api/brands/find?'));
      assert.ok(capturedUrl.includes('q=Coke'));
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.results[0].brand_name, 'Coca-Cola');
      assert.strictEqual(result.results[1].keller_type, 'sub_brand');
    });

    test('encodes special characters in query', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.findCompany('Procter & Gamble');

      assert.ok(capturedUrl.includes('q=Procter%20%26%20Gamble'));
    });

    test('passes limit option', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.findCompany('nike', { limit: 5 });

      assert.ok(capturedUrl.includes('limit=5'));
    });

    test('omits limit when not provided', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.findCompany('nike');

      assert.ok(!capturedUrl.includes('limit='));
    });

    test('throws on empty query', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.findCompany(''),
        err => {
          assert.ok(err.message.includes('query is required'));
          return true;
        }
      );
    });

    test('throws on whitespace-only query', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.findCompany('   '),
        err => {
          assert.ok(err.message.includes('query is required'));
          return true;
        }
      );
    });

    test('throws on server error', async () => {
      restore = mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.findCompany('nike'),
        err => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
    });

    test('sends limit=0 when explicitly passed', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.findCompany('nike', { limit: 0 });

      assert.ok(capturedUrl.includes('limit=0'));
    });

    test('uses custom base URL', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });

      const client = new RegistryClient({ baseUrl: 'https://custom.registry.example.com' });
      await client.findCompany('nike');

      assert.ok(capturedUrl.startsWith('https://custom.registry.example.com/api/brands/find'));
    });
  });

  // ============ brand logo assets ============

  describe('brand logo assets', () => {
    const LOGO_ASSET = {
      id: 'logo_123',
      content_type: 'image/svg+xml',
      source: 'community',
      review_status: 'approved',
      tags: ['primary', 'light'],
      url: 'https://agenticadvertising.org/assets/brands/acme.com/logo_123.svg',
      legacy_url: '/logos/brands/acme.com/logo_123',
      width: 512,
      height: 128,
    };

    test('lists logo assets and serializes tags as a comma-separated query param', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ domain: 'acme.com', logos: [LOGO_ASSET] }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listBrandLogos('acme.com', ['primary', 'light-bg']);

      const parsed = new URL(capturedUrl);
      assert.strictEqual(parsed.pathname, '/api/brands/acme.com/logos');
      assert.strictEqual(parsed.searchParams.get('tags'), 'primary,light-bg');
      assert.strictEqual(result.domain, 'acme.com');
      assert.strictEqual(result.logos[0].id, 'logo_123');
    });

    test('accepts options object for logo tag filters', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ domain: 'acme.com', logos: [] }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listBrandLogos('acme.com', { tags: ['dark-bg'] });

      const parsed = new URL(capturedUrl);
      assert.strictEqual(parsed.searchParams.get('tags'), 'dark-bg');
      assert.deepStrictEqual(result.logos, []);
    });

    test('uploads logo assets as multipart form data', async () => {
      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/brands/acme.com/logos'));
        assert.strictEqual(opts.method, 'POST');
        assert.strictEqual(opts.headers.Authorization, 'Bearer sk_test');
        assert.strictEqual(opts.headers['Content-Type'], undefined);
        assert.ok(opts.body instanceof FormData);

        const file = opts.body.get('file');
        assert.strictEqual(file.name, 'logo.png');
        assert.strictEqual(file.type, 'image/png');
        assert.strictEqual(await file.text(), 'logo-bytes');
        assert.strictEqual(opts.body.get('tags'), 'primary,dark-bg');
        assert.strictEqual(opts.body.get('note'), 'Use for dark backgrounds');

        return new Response(
          JSON.stringify({
            success: true,
            domain: 'acme.com',
            logo_id: 'logo_pending',
            review_status: 'pending',
            message: 'Logo submitted for review',
            review_sla_hours: 24,
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.uploadBrandLogo({
        domain: 'acme.com',
        data: Buffer.from('logo-bytes'),
        filename: 'logo.png',
        mimeType: 'image/png',
        tags: ['primary', 'dark-bg'],
        note: 'Use for dark backgrounds',
      });

      assert.strictEqual(result.logo_id, 'logo_pending');
      assert.strictEqual(result.review_status, 'pending');
      assert.strictEqual(result.review_sla_hours, 24);
    });

    test('accepts Blob and ArrayBuffer logo data', async () => {
      const seen = [];
      restore = mockFetch(async (_url, opts) => {
        const file = opts.body.get('file');
        seen.push({ name: file.name, type: file.type, text: await file.text() });
        return new Response(
          JSON.stringify({
            success: true,
            domain: 'acme.com',
            logo_id: `logo_${seen.length}`,
            review_status: 'pending',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await client.uploadBrandLogo({
        domain: 'acme.com',
        data: new Blob(['blob-logo'], { type: 'text/plain' }),
        filename: 'blob.txt',
        mimeType: 'image/svg+xml',
        tags: ['primary'],
      });
      await client.uploadBrandLogo({
        domain: 'acme.com',
        data: new TextEncoder().encode('array-buffer-logo').buffer,
        filename: 'array-buffer.svg',
        mimeType: 'image/svg+xml',
        tags: ['primary'],
      });

      assert.deepStrictEqual(seen, [
        { name: 'blob.txt', type: 'image/svg+xml', text: 'blob-logo' },
        { name: 'array-buffer.svg', type: 'image/svg+xml', text: 'array-buffer-logo' },
      ]);
    });

    test('throws without apiKey when uploading a logo', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () =>
          client.uploadBrandLogo({
            domain: 'acme.com',
            data: Buffer.from('logo'),
            filename: 'logo.png',
            mimeType: 'image/png',
            tags: ['primary'],
          }),
        err => {
          assert.ok(err.message.includes('apiKey is required'));
          return true;
        }
      );
    });

    test('rejects empty brand logo inputs', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(() => client.listBrandLogos(''), { message: /domain is required/ });
      await assert.rejects(
        () =>
          client.uploadBrandLogo({
            domain: 'acme.com',
            data: Buffer.from('logo'),
            filename: '',
            mimeType: 'image/png',
            tags: ['primary'],
          }),
        { message: /filename is required/ }
      );
      await assert.rejects(
        () =>
          client.uploadBrandLogo({
            domain: 'acme.com',
            data: Buffer.from('logo'),
            filename: 'logo.png',
            mimeType: 'image/png',
            tags: [],
          }),
        { message: /tags are required/ }
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

  // ============ lookupPropertiesAll ============

  describe('lookupPropertiesAll', () => {
    test('auto-paginates in batches of 100', async () => {
      const domains = Array.from({ length: 250 }, (_, i) => `domain${i}.com`);
      const batchCalls = [];

      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/properties/resolve/bulk'));
        const body = JSON.parse(opts.body);
        batchCalls.push(body.domains.length);
        const results = {};
        for (const d of body.domains) {
          results[d] = { publisher_domain: d, authorized_agents: [], properties: [] };
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupPropertiesAll(domains);

      assert.deepStrictEqual(batchCalls, [100, 100, 50]);
      assert.strictEqual(Object.keys(result).length, 250);
      assert.strictEqual(result['domain0.com'].publisher_domain, 'domain0.com');
      assert.strictEqual(result['domain249.com'].publisher_domain, 'domain249.com');
    });

    test('deduplicates domains', async () => {
      const callBodies = [];
      restore = mockFetch(async (url, opts) => {
        const body = JSON.parse(opts.body);
        callBodies.push(body.domains);
        const results = {};
        for (const d of body.domains) {
          results[d] = { publisher_domain: d, authorized_agents: [], properties: [] };
        }
        return new Response(JSON.stringify({ results }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupPropertiesAll(['a.com', 'b.com', 'a.com', 'b.com', 'c.com']);

      assert.strictEqual(callBodies.length, 1);
      assert.deepStrictEqual(callBodies[0], ['a.com', 'b.com', 'c.com']);
      assert.strictEqual(Object.keys(result).length, 3);
    });

    test('returns empty object for empty array', async () => {
      const client = new RegistryClient();
      const result = await client.lookupPropertiesAll([]);
      assert.deepStrictEqual(result, {});
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

  // ============ transport options ============

  describe('transport options', () => {
    test('uses safe default request options', async () => {
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupBrand('nike.com');

      assert.ok(capturedUrl.startsWith('https://agenticadvertising.org/api/brands/resolve'));
      assert.strictEqual(capturedOpts.redirect, 'error');
      assert.strictEqual(capturedOpts.headers.Accept, 'application/json');
      assert.ok(capturedOpts.signal instanceof AbortSignal);
    });

    test('allows callers to opt into following redirects', async () => {
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });

      const client = new RegistryClient({ redirect: 'follow' });
      await client.lookupBrand('nike.com');

      assert.strictEqual(capturedOpts.redirect, 'follow');
    });

    test('uses injected fetch implementation', async () => {
      let capturedUrl;
      const client = new RegistryClient({
        fetch: async (url, opts) => {
          capturedUrl = url;
          assert.strictEqual(opts.redirect, 'error');
          return new Response(JSON.stringify(BRAND), { status: 200 });
        },
      });

      const result = await client.lookupBrand('nike.com');

      assert.ok(capturedUrl.includes('/api/brands/resolve?domain=nike.com'));
      assert.strictEqual(result.brand_name, 'Nike');
    });

    test('times out hung requests', async () => {
      const client = new RegistryClient({
        timeoutMs: 5,
        fetch: async () => new Promise(() => {}),
      });

      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('timed out after 5ms'));
          return true;
        }
      );
    });

    test('times out responses that send headers but stall the body', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"brand_name"'));
        },
      });
      const client = new RegistryClient({
        timeoutMs: 5,
        fetch: async () => new Response(stream, { status: 200 }),
      });

      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('timed out after 5ms'));
          return true;
        }
      );
    });

    test('clears timeout when injected fetch throws synchronously', async () => {
      const client = new RegistryClient({
        timeoutMs: 5,
        fetch: () => {
          throw new Error('sync fetch failure');
        },
      });

      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('sync fetch failure'));
          return true;
        }
      );
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    test('rejects oversized responses declared by content-length', async () => {
      restore = mockFetch(async () => {
        return new Response('{}', { status: 200, headers: { 'content-length': '5' } });
      });

      const client = new RegistryClient({ maxBodyBytes: 4 });
      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('exceeded 4 bytes'));
          return true;
        }
      );
    });

    test('rejects oversized responses while reading the body', async () => {
      restore = mockFetch(async () => {
        return new Response('hello', { status: 200 });
      });

      const client = new RegistryClient({ maxBodyBytes: 4 });
      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('exceeded 4 bytes'));
          return true;
        }
      );
    });

    test('truncates error response bodies in thrown messages', async () => {
      restore = mockFetch(async () => {
        return new Response('x'.repeat(300), { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          const prefix = 'Registry request failed (500): ';
          assert.ok(err.message.startsWith(prefix));
          assert.strictEqual(err.message.length, prefix.length + 200);
          return true;
        }
      );
    });

    test('allows large public agent catalog responses by default', async () => {
      const largeResponse = { formats: [{ id: 'large', payload: 'x'.repeat(300 * 1024) }] };
      restore = mockFetch(async () => new Response(JSON.stringify(largeResponse), { status: 200 }));

      const client = new RegistryClient();
      const result = await client.getAgentFormats('https://agent.example.com');

      assert.strictEqual(result.formats[0].id, 'large');
    });

    test('allows large storyboard status responses by default', async () => {
      const largeResponse = { status: 'passing', detail: 'x'.repeat(300 * 1024) };
      restore = mockFetch(async () => new Response(JSON.stringify(largeResponse), { status: 200 }));

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.getAgentStoryboardStatus('https://agent.example.com');

      assert.strictEqual(result.status, 'passing');
    });

    test('allows large bulk resolution responses by default', async () => {
      const payload = 'x'.repeat(300 * 1024);
      restore = mockFetch(async url => {
        if (url.includes('/api/brands/resolve/bulk')) {
          return new Response(JSON.stringify({ results: { 'nike.com': { ...BRAND, payload } } }), { status: 200 });
        }
        if (url.includes('/api/properties/resolve/bulk')) {
          return new Response(JSON.stringify({ results: { 'nytimes.com': { ...PROPERTY, payload } } }), {
            status: 200,
          });
        }
        if (url.includes('/api/policies/resolve/bulk')) {
          return new Response(JSON.stringify({ results: [{ policy_id: 'policy_1', payload }] }), { status: 200 });
        }
        throw new Error(`unexpected URL: ${url}`);
      });

      const client = new RegistryClient();

      const brands = await client.lookupBrands(['nike.com']);
      assert.strictEqual(brands['nike.com'].payload, payload);

      const properties = await client.lookupProperties(['nytimes.com']);
      assert.strictEqual(properties['nytimes.com'].payload, payload);

      const policies = await client.resolvePoliciesBulk({ policy_ids: ['policy_1'] });
      assert.strictEqual(policies.results[0].payload, payload);
    });

    test('allows large community mirror responses by default', async () => {
      const payload = 'x'.repeat(300 * 1024);
      restore = mockFetch(async url => {
        if (url.endsWith('/api/registry/mirrors/meta')) {
          return new Response(
            JSON.stringify({
              platform: 'meta',
              catalog_etag: 'large-mirror',
              superseded_by: null,
              adagents_json: {
                authorized_agents: [],
                catalog_etag: 'large-mirror',
                formats: [{ format_option_id: 'large', format_kind: 'image', params: { payload } }],
              },
              created_at: '2026-06-05T12:00:00.000Z',
              updated_at: '2026-06-05T12:00:00.000Z',
            }),
            { status: 200 }
          );
        }
        if (url.endsWith('/api/registry/mirrors')) {
          return new Response(
            JSON.stringify({
              mirrors: [
                {
                  platform: 'meta',
                  catalog_etag: 'large-mirror',
                  superseded_by: null,
                  updated_at: '2026-06-05T12:00:00.000Z',
                  payload,
                },
              ],
              total: 1,
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected URL: ${url}`);
      });

      const client = new RegistryClient();
      const mirror = await client.getCommunityMirrorAdagents('meta');
      assert.strictEqual(mirror.formats[0].params.payload, payload);

      const mirrors = await client.listCommunityMirrorAdagents();
      assert.strictEqual(mirrors.mirrors[0].payload, payload);
    });

    test('escapes control characters in error response previews', async () => {
      restore = mockFetch(async () => {
        return new Response('bad\n\u001b[31m', { status: 500 });
      });

      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupBrand('nike.com'),
        err => {
          assert.ok(err.message.includes('bad\\u000a\\u001b[31m'));
          assert.ok(!err.message.includes('bad\n'));
          return true;
        }
      );
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

    test('passes source filter', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ brands: [], stats: {} }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listBrands({ source: 'brand_json' });

      assert.ok(capturedUrl.includes('source=brand_json'));
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
      const responseData = { agents: [{ url: 'https://agent.example.com', type: 'sales' }], count: 1 };
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
      assert.deepStrictEqual(result.sources, {});
    });

    test('passes current list filters', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ agents: [], count: 0 }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listAgents({
        type: 'measurement',
        health: true,
        capabilities: true,
        properties: true,
        compliance: true,
        metric_id: ['attention_units', 'viewability'],
        accreditation: 'MRC',
        q: 'attention',
        verification_mode: ['spec', 'live'],
        verified: true,
      });

      assert.ok(capturedUrl.includes('type=measurement'));
      assert.ok(capturedUrl.includes('health=true'));
      assert.ok(capturedUrl.includes('capabilities=true'));
      assert.ok(capturedUrl.includes('properties=true'));
      assert.ok(capturedUrl.includes('compliance=true'));
      assert.ok(capturedUrl.includes('metric_id=attention_units'));
      assert.ok(capturedUrl.includes('metric_id=viewability'));
      assert.ok(capturedUrl.includes('accreditation=MRC'));
      assert.ok(capturedUrl.includes('q=attention'));
      assert.ok(capturedUrl.includes('verification_mode=spec'));
      assert.ok(capturedUrl.includes('verification_mode=live'));
      assert.ok(capturedUrl.includes('verified=true'));
    });

    test('preserves legacy si type alias', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ agents: [], count: 0 }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listAgents({ type: 'si' });

      assert.ok(capturedUrl.includes('type=si'));
    });

    test('preserves server-provided sources summary', async () => {
      const sources = { registry: 2 };
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ agents: [], count: 0, sources }), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listAgents();

      assert.deepStrictEqual(result.sources, sources);
    });
  });

  // ============ listPublishers ============

  describe('listPublishers', () => {
    test('lists publishers', async () => {
      const responseData = { publishers: [{ domain: 'nytimes.com' }], count: 1 };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(responseData), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listPublishers();

      assert.ok(capturedUrl.includes('/api/registry/publishers'));
      assert.strictEqual(result.count, 1);
      assert.deepStrictEqual(result.sources, {});
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
      const created = {
        success: true,
        data: { success: true, adagents_json: { version: '1.0', agents: [] } },
        timestamp: '2026-05-27T00:00:00Z',
      };
      let capturedUrl, capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(created), { status: 200 });
      });

      const config = { authorized_agents: [{ url: 'https://agent.example.com', authorized_for: 'sell' }] };
      const client = new RegistryClient();
      const result = await client.createAdagents(config);

      assert.ok(capturedUrl.includes('/api/adagents/create'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.strictEqual(body.authorized_agents[0].url, 'https://agent.example.com');
      assert.strictEqual(result.data.adagents_json.version, '1.0');
    });

    test('passes catalog-only community mirror fields through to the registry', async () => {
      const created = { success: true, data: { success: true, adagents_json: {} } };
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(created), { status: 200 });
      });

      const config = {
        authorized_agents: [],
        catalog_etag: 'meta-creative-formats-2026-05',
        properties: [{ domain: 'creative.adcontextprotocol.org', platform: 'meta' }],
        formats: [
          {
            format_option_id: 'meta-feed-image',
            format_kind: 'display',
            v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/translated/meta', id: 'feed_image' }],
          },
        ],
        placements: [{ placement_id: 'feed', format_option_ids: ['meta-feed-image'] }],
        placement_tags: { feed: { label: 'Feed' } },
      };
      const client = new RegistryClient();
      await client.createAdagents(config);

      assert.ok(capturedUrl.endsWith('/api/adagents/create'));
      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.authorized_agents, []);
      assert.strictEqual(body.catalog_etag, 'meta-creative-formats-2026-05');
      assert.strictEqual(body.formats[0].format_kind, 'display');
      assert.strictEqual(body.placements[0].format_option_ids[0], 'meta-feed-image');
      assert.strictEqual(body.placement_tags.feed.label, 'Feed');
    });

    test('builds community mirror catalogs without authorization claims', () => {
      const catalog = buildCommunityMirrorAdagents({
        platform: 'meta',
        catalog_etag: 'meta-creative-formats-2026-05',
        formats: [
          {
            format_option_id: 'meta-feed-image',
            format_kind: 'image',
            params: { width: 1080, height: 1080 },
            v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/translated/meta', id: 'feed_image' }],
          },
        ],
        placements: [
          {
            placement_id: 'feed',
            name: 'Feed',
            property_tags: ['feed'],
            format_options: [{ format_option_id: 'meta-feed-image' }],
          },
        ],
        placement_tags: { feed: { name: 'Feed', description: 'Main feed placement' } },
      });

      assert.deepStrictEqual(catalog.authorized_agents, []);
      assert.strictEqual(catalog.platform, undefined);
      assert.strictEqual(catalog.catalog_etag, 'meta-creative-formats-2026-05');
      assert.strictEqual(catalog.formats[0].format_kind, 'image');
      assert.strictEqual(catalog.placements[0].format_options[0].format_option_id, 'meta-feed-image');
    });

    test('builds community mirror catalogs from non-format content', () => {
      const catalog = buildCommunityMirrorAdagents({
        properties: [{ domain: 'example.com', platform: 'meta' }],
      });

      assert.deepStrictEqual(catalog.authorized_agents, []);
      assert.strictEqual(catalog.catalog_etag, undefined);
      assert.strictEqual(catalog.properties[0].domain, 'example.com');
      assert.strictEqual(catalog.formats, undefined);
    });

    test('rejects empty community mirror catalogs', () => {
      assert.throws(
        () =>
          buildCommunityMirrorAdagents({
            catalog_etag: 'meta-empty-2026-06',
          }),
        /at least one non-empty catalog collection/
      );
    });

    test('rejects authorization claims in community mirror helper', () => {
      assert.throws(
        () =>
          buildCommunityMirrorAdagents({
            authorized_agents: [{ url: 'https://agent.example.com' }],
            catalog_etag: 'meta-creative-formats-2026-05',
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /authorized_agents is not accepted/
      );
    });

    test('rejects generator-only flags in community mirror helper', () => {
      assert.throws(
        () =>
          buildCommunityMirrorAdagents({
            include_schema: false,
            catalog_etag: 'meta-creative-formats-2026-05',
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /include_schema and include_timestamp are not accepted/
      );
    });

    test('creates community mirror catalogs via the generator endpoint', async () => {
      const created = { success: true, data: { success: true, adagents_json: {} } };
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(created), { status: 200 });
      });

      const client = new RegistryClient();
      await client.createCommunityMirrorAdagents({
        catalog_etag: 'meta-creative-formats-2026-05',
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.ok(capturedUrl.endsWith('/api/adagents/create'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.authorized_agents, []);
      assert.strictEqual(body.catalog_etag, 'meta-creative-formats-2026-05');
    });

    test('upserts community mirror catalogs via keyed helper', async () => {
      const published = {
        success: true,
        platform: 'meta',
        catalog_etag: 'meta-creative-formats-2026-05',
        superseded_by: null,
        updated_at: '2026-06-05T12:00:00.000Z',
      };
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(published), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.upsertCommunityMirrorAdagents({
        platform: 'Meta',
        catalog_etag: 'meta-creative-formats-2026-05',
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.strictEqual(result.platform, 'meta');
      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
      assert.strictEqual(capturedOpts.method, 'PUT');
      assert.strictEqual(capturedOpts.headers.Authorization, 'Bearer sk_test');
      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.authorized_agents, []);
      assert.strictEqual(body.catalog_etag, 'meta-creative-formats-2026-05');
      assert.strictEqual(body.platform, undefined);
    });

    test('upsertCommunityMirrorAdagents accepts platform as first argument', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            success: true,
            platform: 'meta',
            catalog_etag: 'meta-creative-formats-2026-05',
            superseded_by: null,
            updated_at: '2026-06-05T12:00:00.000Z',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await client.upsertCommunityMirrorAdagents('Meta', {
        catalog_etag: 'meta-creative-formats-2026-05',
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
    });

    test('upsertCommunityMirrorAdagents infers platform from a single property platform', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            success: true,
            platform: 'meta',
            catalog_etag: 'meta-creative-formats-2026-05',
            superseded_by: null,
            updated_at: '2026-06-05T12:00:00.000Z',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await client.upsertCommunityMirrorAdagents({
        catalog_etag: 'meta-creative-formats-2026-05',
        properties: [{ domain: 'creative.adcontextprotocol.org', platform: 'Meta' }],
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
    });

    test('upsertCommunityMirrorAdagents requires a platform identity', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.upsertCommunityMirrorAdagents({
            catalog_etag: 'meta-creative-formats-2026-05',
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /platform is required for community mirror publish/
      );
    });

    test('upsertCommunityMirrorAdagents rejects ambiguous property platforms', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.upsertCommunityMirrorAdagents({
            catalog_etag: 'meta-creative-formats-2026-05',
            properties: [
              { domain: 'creative.adcontextprotocol.org', platform: 'meta' },
              { domain: 'creative.adcontextprotocol.org', platform: 'tiktok' },
            ],
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /platform is ambiguous; pass upsertCommunityMirrorAdagents\(platform, config\)/
      );
    });

    test('upsertCommunityMirrorAdagents requires config with first-argument platform', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(() => client.upsertCommunityMirrorAdagents('meta'), /config is required/);
    });

    test('previews community mirror catalogs via the generator endpoint', async () => {
      const created = { success: true, data: { success: true, adagents_json: {} } };
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(created), { status: 200 });
      });

      const client = new RegistryClient();
      await client.previewCommunityMirrorAdagents({
        catalog_etag: 'meta-creative-formats-2026-05',
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.ok(capturedUrl.endsWith('/api/adagents/create'));
      assert.strictEqual(capturedOpts.method, 'POST');
      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.authorized_agents, []);
      assert.strictEqual(body.catalog_etag, 'meta-creative-formats-2026-05');
    });

    test('publishes community mirror catalogs with PUT and auth', async () => {
      const published = {
        success: true,
        platform: 'meta',
        catalog_etag: 'meta-creative-formats-2026-05',
        superseded_by: null,
        updated_at: '2026-06-05T12:00:00.000Z',
      };
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify(published), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.publishCommunityMirrorAdagents('Meta', {
        catalog_etag: 'meta-creative-formats-2026-05',
        superseded_by: 'https://meta.example/.well-known/adagents.json',
        properties: [{ domain: 'creative.adcontextprotocol.org', platform: 'meta' }],
        formats: [{ format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } }],
      });

      assert.strictEqual(result.platform, 'meta');
      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
      assert.strictEqual(capturedOpts.method, 'PUT');
      assert.strictEqual(capturedOpts.headers.Authorization, 'Bearer sk_test');
      assert.strictEqual(capturedOpts.headers['Content-Type'], 'application/json');
      const body = JSON.parse(capturedOpts.body);
      assert.deepStrictEqual(body.authorized_agents, []);
      assert.strictEqual(body.catalog_etag, 'meta-creative-formats-2026-05');
      assert.strictEqual(body.superseded_by, 'https://meta.example/.well-known/adagents.json');
      assert.strictEqual(body.formats[0].format_kind, 'image');
    });

    test('publishCommunityMirrorAdagents rejects property platform mismatches', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.publishCommunityMirrorAdagents('meta', {
            catalog_etag: 'meta-creative-formats-2026-05',
            properties: [{ domain: 'creative.adcontextprotocol.org', platform: 'google' }],
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /properties\[\]\.platform must match meta/
      );
    });

    test('publishCommunityMirrorAdagents requires an api key', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () =>
            client.publishCommunityMirrorAdagents('meta', {
              catalog_etag: 'meta-creative-formats-2026-05',
              formats: [
                { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
              ],
            }),
          /apiKey is required for save operations/
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('publishCommunityMirrorAdagents rejects empty platform', async () => {
      const client = new RegistryClient({ apiKey: 'sk_test' });
      await assert.rejects(
        () =>
          client.publishCommunityMirrorAdagents('   ', {
            catalog_etag: 'meta-creative-formats-2026-05',
            formats: [
              { format_option_id: 'meta-feed-image', format_kind: 'image', params: { width: 1080, height: 1080 } },
            ],
          }),
        /platform is required/
      );
    });

    test('getCommunityMirrorAdagents returns the stored adagents catalog', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            platform: 'meta',
            catalog_etag: 'meta-creative-formats-2026-05',
            superseded_by: 'https://meta.example/.well-known/adagents.json',
            adagents_json: {
              authorized_agents: [],
              catalog_etag: 'meta-creative-formats-2026-05',
              formats: [
                {
                  format_option_id: 'meta-feed-image',
                  format_kind: 'image',
                  params: { width: 1080, height: 1080 },
                },
              ],
            },
            created_at: '2026-06-05T12:00:00.000Z',
            updated_at: '2026-06-05T12:00:00.000Z',
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient();
      const result = await client.getCommunityMirrorAdagents('meta');

      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
      assert.deepStrictEqual(result.authorized_agents, []);
      assert.strictEqual(result.catalog_etag, 'meta-creative-formats-2026-05');
      assert.strictEqual(result.superseded_by, 'https://meta.example/.well-known/adagents.json');
      assert.strictEqual(result.formats[0].format_option_id, 'meta-feed-image');
    });

    test('getCommunityMirrorAdagents rejects mismatched platform responses', async () => {
      restore = mockFetch(async () => {
        return new Response(
          JSON.stringify({
            platform: 'google',
            adagents_json: {
              authorized_agents: [],
              catalog_etag: 'meta-creative-formats-2026-05',
              formats: [
                {
                  format_option_id: 'meta-feed-image',
                  format_kind: 'image',
                  params: { width: 1080, height: 1080 },
                },
              ],
            },
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient();
      await assert.rejects(() => client.getCommunityMirrorAdagents('meta'), /mismatched community mirror platform/);
    });

    test('getCommunityMirrorAdagents rejects non-catalog mirror responses', async () => {
      restore = mockFetch(async () => {
        return new Response(
          JSON.stringify({
            platform: 'meta',
            adagents_json: {
              authorized_agents: [{ url: 'https://agent.example.com' }],
              catalog_etag: 'meta-creative-formats-2026-05',
              formats: [
                {
                  format_option_id: 'meta-feed-image',
                  format_kind: 'image',
                  params: { width: 1080, height: 1080 },
                },
              ],
            },
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient();
      await assert.rejects(() => client.getCommunityMirrorAdagents('meta'), /invalid community mirror catalog/);
    });

    test('getCommunityMirrorAdagents rejects malformed success responses', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ platform: 'meta' }), { status: 200 });
      });

      const client = new RegistryClient();
      await assert.rejects(() => client.getCommunityMirrorAdagents('meta'), /invalid community mirror catalog/);
    });

    test('getCommunityMirrorAdagents returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Community mirror not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.getCommunityMirrorAdagents('meta');

      assert.strictEqual(result, null);
    });

    test('getCommunityMirrorAdagents rejects invalid platform', async () => {
      const client = new RegistryClient();
      await assert.rejects(() => client.getCommunityMirrorAdagents('bad platform!'), /platform must match/);
    });

    test('listCommunityMirrorAdagents lists mirrors without pagination options', async () => {
      let capturedUrl;
      const listed = {
        mirrors: [
          {
            platform: 'meta',
            catalog_etag: 'meta-creative-formats-2026-05',
            superseded_by: null,
            updated_at: '2026-06-05T12:00:00.000Z',
          },
        ],
        total: 1,
      };
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(listed), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.listCommunityMirrorAdagents();

      assert.ok(capturedUrl.endsWith('/api/registry/mirrors'));
      assert.strictEqual(result.total, 1);
      assert.strictEqual(result.mirrors[0].platform, 'meta');
    });

    test('listCommunityMirrorAdagents encodes pagination options', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ mirrors: [], total: 0 }), { status: 200 });
      });

      const client = new RegistryClient();
      await client.listCommunityMirrorAdagents({ limit: 25, offset: 50 });

      const url = new URL(capturedUrl);
      assert.strictEqual(url.pathname, '/api/registry/mirrors');
      assert.strictEqual(url.searchParams.get('limit'), '25');
      assert.strictEqual(url.searchParams.get('offset'), '50');
    });

    test('deletes community mirror catalogs with auth', async () => {
      let capturedUrl;
      let capturedOpts;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response(JSON.stringify({ success: true, platform: 'meta' }), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.deleteCommunityMirrorAdagents('Meta');

      assert.strictEqual(result.platform, 'meta');
      assert.ok(capturedUrl.endsWith('/api/registry/mirrors/meta'));
      assert.strictEqual(capturedOpts.method, 'DELETE');
      assert.strictEqual(capturedOpts.headers.Authorization, 'Bearer sk_test');
    });

    test('deleteCommunityMirrorAdagents encodes force option', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ success: true, platform: 'meta' }), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      await client.deleteCommunityMirrorAdagents('meta', { force: true });

      const url = new URL(capturedUrl);
      assert.strictEqual(url.pathname, '/api/registry/mirrors/meta');
      assert.strictEqual(url.searchParams.get('force'), 'true');
    });

    test('deleteCommunityMirrorAdagents requires an api key', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () => client.deleteCommunityMirrorAdagents('meta'),
          /apiKey is required for save operations/
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
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

  // ============ checkPropertyList ============

  describe('checkPropertyList', () => {
    test('posts domains and returns buckets with report_id', async () => {
      const response = {
        summary: { total: 3, remove: 1, modify: 1, assess: 0, ok: 1 },
        remove: [
          { input: 'doubleclick.net', canonical: 'doubleclick.net', reason: 'blocked', domain_type: 'ad_server' },
        ],
        modify: [{ input: 'www.nytimes.com', canonical: 'nytimes.com', reason: 'www stripped' }],
        assess: [],
        ok: [{ domain: 'nytimes.com', source: 'adagents_json' }],
        report_id: 'rpt_abc123',
      };
      let capturedUrl, capturedBody;
      restore = mockFetch(async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(response), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.checkPropertyList(['doubleclick.net', 'www.nytimes.com', 'nytimes.com']);

      assert.ok(capturedUrl.includes('/api/properties/check'));
      assert.deepStrictEqual(capturedBody.domains, ['doubleclick.net', 'www.nytimes.com', 'nytimes.com']);
      assert.strictEqual(result.report_id, 'rpt_abc123');
      assert.strictEqual(result.summary.total, 3);
      assert.strictEqual(result.remove[0].reason, 'blocked');
      assert.strictEqual(result.modify[0].canonical, 'nytimes.com');
    });

    test('throws on empty domains array', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.checkPropertyList([]),
        err => {
          assert.ok(err.message.includes('domains is required'));
          return true;
        }
      );
    });

    test('throws when domains exceeds 10000 limit', async () => {
      const client = new RegistryClient();
      const tooMany = Array.from({ length: 10001 }, (_, i) => `domain${i}.com`);
      await assert.rejects(
        () => client.checkPropertyList(tooMany),
        err => {
          assert.ok(err.message.includes('Cannot check more than 10000'));
          return true;
        }
      );
    });
  });

  // ============ getPropertyCheckReport ============

  describe('getPropertyCheckReport', () => {
    test('fetches stored report by id', async () => {
      const response = { summary: { total: 50, remove: 5, modify: 10, assess: 20, ok: 15 } };
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(response), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getPropertyCheckReport('rpt_abc123');

      assert.ok(capturedUrl.includes('/api/properties/check/rpt_abc123'));
      assert.strictEqual(result.summary.total, 50);
      assert.strictEqual(result.summary.ok, 15);
    });

    test('url-encodes the report id', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify({ summary: { total: 0, remove: 0, modify: 0, assess: 0, ok: 0 } }), {
          status: 200,
        });
      });

      const client = new RegistryClient();
      await client.getPropertyCheckReport('rpt/with spaces');

      assert.ok(capturedUrl.includes('rpt%2Fwith%20spaces'));
    });

    test('throws on empty reportId', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getPropertyCheckReport(''),
        err => {
          assert.ok(err.message.includes('reportId is required'));
          return true;
        }
      );
    });

    test('throws on whitespace-only reportId', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getPropertyCheckReport('   '),
        err => {
          assert.ok(err.message.includes('reportId is required'));
          return true;
        }
      );
    });
  });

  // ============ getFeed ============

  describe('getFeed', () => {
    const FEED_RESPONSE = {
      events: [
        {
          event_id: '01953abc-0000-7000-8000-000000000001',
          event_type: 'agent.discovered',
          entity_type: 'agent',
          entity_id: 'https://ads.example.com',
          payload: { agent_url: 'https://ads.example.com' },
          actor: 'crawler',
          created_at: '2026-04-01T10:00:00Z',
        },
      ],
      cursor: '01953abc-0000-7000-8000-000000000001',
      has_more: false,
    };

    test('polls feed without cursor', async () => {
      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/registry/feed'));
        assert.ok(!url.includes('cursor='));
        assert.strictEqual(opts.headers.Authorization, 'Bearer test-key');
        return new Response(JSON.stringify(FEED_RESPONSE), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.getFeed();

      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].event_type, 'agent.discovered');
      assert.strictEqual(result.has_more, false);
      assert.strictEqual(result.cursor, '01953abc-0000-7000-8000-000000000001');
    });

    test('passes cursor and types params', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('cursor=01953abc'));
        assert.ok(url.includes('types=property.*'));
        assert.ok(url.includes('limit=500'));
        return new Response(JSON.stringify({ ...FEED_RESPONSE, has_more: true }), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.getFeed({
        cursor: '01953abc',
        types: 'property.*',
        limit: 500,
      });

      assert.strictEqual(result.has_more, true);
    });

    test('throws without apiKey', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getFeed(),
        err => {
          assert.ok(err.message.includes('apiKey is required'));
          return true;
        }
      );
    });

    test('throws on 401', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      });

      const client = new RegistryClient({ apiKey: 'bad-key' });
      await assert.rejects(
        () => client.getFeed(),
        err => {
          assert.ok(err.message.includes('401'));
          return true;
        }
      );
    });
  });

  // ============ searchAgents ============

  describe('searchAgents', () => {
    const SEARCH_RESPONSE = {
      results: [
        {
          url: 'https://ads.streamhaus.example.com',
          name: 'StreamHaus Ad Sales',
          type: 'sales',
          inventory_profile: {
            channels: ['ctv', 'olv'],
            property_types: ['ctv_app'],
            markets: ['US', 'GB'],
            categories: ['IAB-7'],
            tags: ['premium'],
            delivery_types: ['guaranteed'],
            property_count: 42,
            publisher_count: 3,
            has_tmp: true,
          },
          match: {
            score: 0.92,
            matched_filters: ['channels', 'markets'],
          },
        },
      ],
      cursor: null,
      has_more: false,
    };

    test('searches with no filters', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('/api/registry/agents/search'));
        return new Response(JSON.stringify(SEARCH_RESPONSE), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.searchAgents();

      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].name, 'StreamHaus Ad Sales');
    });

    test('passes all filter params', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('type=sales'));
        assert.ok(url.includes('channels=ctv%2Colv'));
        assert.ok(url.includes('markets=US'));
        assert.ok(url.includes('categories=IAB-7'));
        assert.ok(url.includes('property_types=ctv_app'));
        assert.ok(url.includes('tags=premium'));
        assert.ok(url.includes('delivery_types=guaranteed'));
        assert.ok(url.includes('has_tmp=true'));
        assert.ok(url.includes('min_properties=10'));
        assert.ok(url.includes('sort=relevance'));
        assert.ok(url.includes('limit=20'));
        return new Response(JSON.stringify(SEARCH_RESPONSE), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.searchAgents({
        type: 'sales',
        channels: 'ctv,olv',
        markets: 'US',
        categories: 'IAB-7',
        property_types: 'ctv_app',
        tags: 'premium',
        delivery_types: 'guaranteed',
        has_tmp: true,
        min_properties: 10,
        sort: 'relevance',
        limit: 20,
      });

      assert.strictEqual(result.results.length, 1);
    });

    test('passes cursor for pagination', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('cursor=abc123'));
        return new Response(JSON.stringify({ ...SEARCH_RESPONSE, has_more: true, cursor: 'def456' }), {
          status: 200,
        });
      });

      const client = new RegistryClient({ apiKey: 'sk_test' });
      const result = await client.searchAgents({ cursor: 'abc123' });

      assert.strictEqual(result.has_more, true);
      assert.strictEqual(result.cursor, 'def456');
    });

    test('requires authentication', async () => {
      const client = new RegistryClient();
      await assert.rejects(() => client.searchAgents(), { message: /apiKey is required/ });
    });
  });

  // ============ requestCrawl ============

  describe('requestCrawl', () => {
    test('requests crawl for a domain', async () => {
      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/api/registry/crawl-request'));
        assert.strictEqual(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.domain, 'publisher.example.com');
        assert.strictEqual(opts.headers.Authorization, 'Bearer test-key');
        return new Response(JSON.stringify({ status: 'accepted', domain: 'publisher.example.com' }), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.requestCrawl('publisher.example.com');

      assert.strictEqual(result.status, 'accepted');
      assert.strictEqual(result.domain, 'publisher.example.com');
    });

    test('handles rate limited response', async () => {
      restore = mockFetch(async () => {
        return new Response(
          JSON.stringify({
            status: 'rate_limited',
            domain: 'publisher.example.com',
            last_crawled: '2026-04-01T09:55:00Z',
            retry_after: 300,
          }),
          { status: 200 }
        );
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.requestCrawl('publisher.example.com');

      assert.strictEqual(result.status, 'rate_limited');
      assert.strictEqual(result.retry_after, 300);
    });

    test('throws without apiKey', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.requestCrawl('publisher.example.com'),
        err => {
          assert.ok(err.message.includes('apiKey is required'));
          return true;
        }
      );
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient({ apiKey: 'test-key' });
      await assert.rejects(
        () => client.requestCrawl(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('throws on 429', async () => {
      restore = mockFetch(async () => {
        return new Response(
          JSON.stringify({
            status: 'rate_limited',
            domain: 'publisher.example.com',
            retry_after: 300,
          }),
          { status: 429 }
        );
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      await assert.rejects(
        () => client.requestCrawl('publisher.example.com'),
        err => {
          assert.ok(err.message.includes('429'));
          return true;
        }
      );
    });
  });

  // ============ getAgentCompliance ============

  describe('getAgentCompliance', () => {
    const COMPLIANCE = {
      status: 'passing',
      lifecycle_stage: 'production',
      tracks: { core: 'pass', products: 'pass' },
      streak_days: 14,
      last_checked_at: '2026-04-01T00:00:00Z',
      headline: 'All tracks passing',
      storyboards_passing: 5,
      storyboards_total: 6,
    };

    test('returns compliance data for an agent', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('/api/registry/agents/'));
        assert.ok(url.includes('/compliance'));
        return new Response(JSON.stringify(COMPLIANCE), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.getAgentCompliance('https://ads.example.com');
      assert.strictEqual(result.status, 'passing');
      assert.strictEqual(result.storyboards_passing, 5);
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.getAgentCompliance('https://unknown.example.com');
      assert.strictEqual(result, null);
    });

    test('throws on empty agentUrl', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.getAgentCompliance(''),
        err => {
          assert.ok(err.message.includes('agentUrl is required'));
          return true;
        }
      );
    });

    test('encodes agentUrl in path', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(COMPLIANCE), { status: 200 });
      });

      const client = new RegistryClient();
      await client.getAgentCompliance('https://ads.example.com/v1');
      assert.ok(capturedUrl.includes(encodeURIComponent('https://ads.example.com/v1')));
    });
  });

  // ============ getAgentStoryboardStatus ============

  describe('getAgentStoryboardStatus', () => {
    const STORYBOARD_RESPONSE = {
      agent_url: 'https://ads.example.com',
      storyboards: [
        {
          storyboard_id: 'media_buy_seller',
          title: 'Media Buy (Seller)',
          status: 'passing',
          category: 'sales',
          track: 'media_buy',
          steps_passed: 5,
          steps_total: 5,
          last_tested_at: '2026-04-01T00:00:00Z',
        },
        {
          storyboard_id: 'core_seller',
          title: 'Core (Seller)',
          status: 'failing',
          category: 'sales',
          track: 'core',
          steps_passed: 2,
          steps_total: 4,
          last_tested_at: '2026-04-01T00:00:00Z',
        },
      ],
      passing_count: 1,
      total_count: 2,
    };

    test('returns storyboard detail', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('/storyboard-status'));
        return new Response(JSON.stringify(STORYBOARD_RESPONSE), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.getAgentStoryboardStatus('https://ads.example.com');
      assert.strictEqual(result.storyboards.length, 2);
      assert.strictEqual(result.storyboards[0].storyboard_id, 'media_buy_seller');
      assert.strictEqual(result.passing_count, 1);
    });

    test('throws without apiKey', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () => client.getAgentStoryboardStatus('https://ads.example.com'),
          err => {
            assert.ok(err.message.includes('apiKey is required'));
            return true;
          }
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('throws on empty agentUrl', async () => {
      const client = new RegistryClient({ apiKey: 'test-key' });
      await assert.rejects(
        () => client.getAgentStoryboardStatus(''),
        err => {
          assert.ok(err.message.includes('agentUrl is required'));
          return true;
        }
      );
    });

    test('sends Authorization header', async () => {
      restore = mockFetch(async (url, opts) => {
        assert.ok(opts.headers?.['Authorization']?.includes('Bearer test-key'));
        return new Response(JSON.stringify(STORYBOARD_RESPONSE), { status: 200 });
      });
      const client = new RegistryClient({ apiKey: 'test-key' });
      await client.getAgentStoryboardStatus('https://ads.example.com');
    });
  });

  // ============ getAgentStoryboardStatusBulk ============

  describe('getAgentStoryboardStatusBulk', () => {
    test('posts agent_urls and returns results', async () => {
      const bulkResponse = {
        agents: {
          'https://ads.example.com': [
            {
              storyboard_id: 'core_seller',
              title: 'Core',
              status: 'passing',
              category: 'sales',
              track: 'core',
              steps_passed: 3,
              steps_total: 3,
              last_tested_at: '2026-04-01T00:00:00Z',
            },
          ],
        },
      };

      restore = mockFetch(async (url, opts) => {
        assert.ok(url.includes('/agents/storyboard-status'));
        const body = JSON.parse(opts.body);
        assert.deepStrictEqual(body.agent_urls, ['https://ads.example.com']);
        return new Response(JSON.stringify(bulkResponse), { status: 200 });
      });

      const client = new RegistryClient({ apiKey: 'test-key' });
      const result = await client.getAgentStoryboardStatusBulk(['https://ads.example.com']);
      assert.ok(result.agents['https://ads.example.com']);
    });

    test('throws when array exceeds 100', async () => {
      const client = new RegistryClient({ apiKey: 'test-key' });
      const urls = Array.from({ length: 101 }, (_, i) => `https://agent${i}.example.com`);
      await assert.rejects(
        () => client.getAgentStoryboardStatusBulk(urls),
        err => {
          assert.ok(err.message.includes('Cannot query more than 100'));
          return true;
        }
      );
    });

    test('throws without apiKey', async () => {
      const savedEnv = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      try {
        const client = new RegistryClient();
        await assert.rejects(
          () => client.getAgentStoryboardStatusBulk(['https://ads.example.com']),
          err => {
            assert.ok(err.message.includes('apiKey is required'));
            return true;
          }
        );
      } finally {
        if (savedEnv !== undefined) process.env.ADCP_REGISTRY_API_KEY = savedEnv;
      }
    });

    test('throws on empty array', async () => {
      const client = new RegistryClient({ apiKey: 'test-key' });
      await assert.rejects(
        () => client.getAgentStoryboardStatusBulk([]),
        err => {
          assert.ok(err.message.includes('agentUrls is required'));
          return true;
        }
      );
    });

    test('sends Authorization header', async () => {
      restore = mockFetch(async (url, opts) => {
        assert.ok(opts.headers?.['Authorization']?.includes('Bearer test-key'));
        return new Response(JSON.stringify({ agents: {} }), { status: 200 });
      });
      const client = new RegistryClient({ apiKey: 'test-key' });
      await client.getAgentStoryboardStatusBulk(['https://ads.example.com']);
    });

    test('deduplicates and strips whitespace from URLs', async () => {
      let sentBody;
      restore = mockFetch(async (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ agents: {} }), { status: 200 });
      });
      const client = new RegistryClient({ apiKey: 'test-key' });
      await client.getAgentStoryboardStatusBulk([
        'https://ads.example.com',
        '  https://ads.example.com  ',
        'https://other.example.com',
      ]);
      assert.deepStrictEqual(sentBody.agent_urls.sort(), ['https://ads.example.com', 'https://other.example.com']);
    });

    test('throws on array of only whitespace entries', async () => {
      const client = new RegistryClient({ apiKey: 'test-key' });
      await assert.rejects(
        () => client.getAgentStoryboardStatusBulk(['', '  ']),
        err => {
          assert.ok(err.message.includes('no valid entries'));
          return true;
        }
      );
    });
  });

  // ============ lookupOperator ============

  describe('lookupOperator', () => {
    const OPERATOR = {
      domain: 'pubmatic.com',
      member: { slug: 'pubmatic', display_name: 'PubMatic' },
      agents: [{ url: 'https://ads.pubmatic.com', name: 'PubMatic Ads', type: 'sales', authorized_by: [] }],
    };

    test('returns operator data', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('/api/registry/operator?domain=pubmatic.com'));
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupOperator('pubmatic.com');
      assert.strictEqual(result.domain, 'pubmatic.com');
      assert.strictEqual(result.agents.length, 1);
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.lookupOperator('unknown.com');
      assert.strictEqual(result, null);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupOperator(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('appends scope=public when opts.scope is "public"', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupOperator('pubmatic.com', { scope: 'public' });
      assert.ok(capturedUrl.includes('domain=pubmatic.com'));
      assert.ok(capturedUrl.includes('scope=public'));
    });

    test('appends scope=member when opts.scope is "member"', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupOperator('pubmatic.com', { scope: 'member' });
      assert.ok(capturedUrl.includes('scope=member'));
    });

    test('appends scope=private when opts.scope is "private"', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupOperator('pubmatic.com', { scope: 'private' });
      assert.ok(capturedUrl.includes('scope=private'));
    });

    test('omits scope param when opts.scope is "all"', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupOperator('pubmatic.com', { scope: 'all' });
      assert.ok(capturedUrl.includes('domain=pubmatic.com'));
      assert.ok(!capturedUrl.includes('scope='));
    });

    test('omits scope param when no opts passed', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(OPERATOR), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupOperator('pubmatic.com');
      assert.ok(!capturedUrl.includes('scope='));
    });
  });

  // ============ lookupPublisher ============

  describe('lookupPublisher', () => {
    const PUBLISHER = {
      domain: 'voxmedia.com',
      member: { slug: 'voxmedia', display_name: 'Vox Media' },
      adagents_valid: true,
      authorized_agents: [{ url: 'https://ads.vox.com', name: 'Vox Ads', type: 'sales' }],
    };

    test('returns publisher data', async () => {
      restore = mockFetch(async url => {
        assert.ok(url.includes('/api/registry/publisher?domain=voxmedia.com'));
        return new Response(JSON.stringify(PUBLISHER), { status: 200 });
      });

      const client = new RegistryClient();
      const result = await client.lookupPublisher('voxmedia.com');
      assert.strictEqual(result.domain, 'voxmedia.com');
    });

    test('returns null on 404', async () => {
      restore = mockFetch(async () => {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      });

      const client = new RegistryClient();
      const result = await client.lookupPublisher('unknown.com');
      assert.strictEqual(result, null);
    });

    test('throws on empty domain', async () => {
      const client = new RegistryClient();
      await assert.rejects(
        () => client.lookupPublisher(''),
        err => {
          assert.ok(err.message.includes('domain is required'));
          return true;
        }
      );
    });

    test('does not send a scope param', async () => {
      let capturedUrl;
      restore = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(PUBLISHER), { status: 200 });
      });

      const client = new RegistryClient();
      await client.lookupPublisher('voxmedia.com');
      assert.ok(!capturedUrl.includes('scope='));
    });
  });
});
