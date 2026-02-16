const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const { handleRegistryCommand } = require('../../bin/adcp-registry.js');

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
      property_type: 'website',
      name: 'NYTimes',
      identifiers: [{ type: 'domain', value: 'nytimes.com' }],
    },
  ],
  verified: true,
};

// Mock global fetch and capture calls
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

// Capture console.log output
function captureOutput() {
  const lines = [];
  const errLines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errLines.push(args.join(' '));
  return {
    get stdout() {
      return lines.join('\n');
    },
    get stderr() {
      return errLines.join('\n');
    },
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

describe('CLI registry command', () => {
  let restoreFetch;
  let output;

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    if (output) output.restore();
  });

  // ============ brand subcommand ============

  describe('brand', () => {
    test('looks up a single brand and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(BRAND), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand', 'nike.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Brand: Nike'));
      assert.ok(output.stdout.includes('nike.com'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(BRAND), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand', 'nike.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.brand_name, 'Nike');
    });

    test('prints not-found for null result', async () => {
      restoreFetch = mockFetch(async () => new Response('', { status: 404 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand', 'unknown.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes("No brand found for 'unknown.com'"));
    });
  });

  // ============ brands subcommand ============

  describe('brands', () => {
    test('bulk looks up brands', async () => {
      const results = { 'nike.com': BRAND, 'unknown.com': null };
      restoreFetch = mockFetch(async () => new Response(JSON.stringify({ results }), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brands', 'nike.com', 'unknown.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Brand: Nike'));
      assert.ok(output.stdout.includes("No brand found for 'unknown.com'"));
    });
  });

  // ============ brand-json subcommand ============

  describe('brand-json', () => {
    const BRAND_JSON = { name: 'Nike', domain: 'nike.com', colors: { primary: '#111' } };

    test('fetches and pretty-prints brand.json data', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(BRAND_JSON), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand-json', 'nike.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Brand JSON: nike.com'));
      assert.ok(output.stdout.includes('name'));
      assert.ok(output.stdout.includes('Nike'));
    });

    test('prints not-found when brand.json does not exist', async () => {
      restoreFetch = mockFetch(async () => new Response('', { status: 404 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand-json', 'unknown.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes("No brand.json found for 'unknown.com'"));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(BRAND_JSON), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['brand-json', 'nike.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.name, 'Nike');
    });

    test('returns exit code 2 when domain is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['brand-json']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });
  });

  // ============ enrich-brand subcommand ============

  describe('enrich-brand', () => {
    const ENRICHED = { domain: 'nike.com', logo: 'https://logo.url/nike.png', industry: 'Apparel' };

    test('enriches and pretty-prints brand data', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(ENRICHED), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['enrich-brand', 'nike.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Enriched brand: nike.com'));
      assert.ok(output.stdout.includes('logo'));
      assert.ok(output.stdout.includes('industry'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(ENRICHED), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['enrich-brand', 'nike.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.domain, 'nike.com');
      assert.strictEqual(parsed.logo, 'https://logo.url/nike.png');
    });

    test('returns exit code 2 when domain is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['enrich-brand']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });

    test('calls the correct API endpoint', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(ENRICHED), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['enrich-brand', 'nike.com']);

      assert.ok(capturedUrl.includes('/api/brands/enrich?domain=nike.com'));
    });
  });

  // ============ property subcommand ============

  describe('property', () => {
    test('looks up a single property and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(PROPERTY), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['property', 'nytimes.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Property: nytimes.com'));
      assert.ok(output.stdout.includes('Verified: Yes'));
      assert.ok(output.stdout.includes('NYTimes'));
    });

    test('prints not-found for null result', async () => {
      restoreFetch = mockFetch(async () => new Response('', { status: 404 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['property', 'unknown.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes("No property found for 'unknown.com'"));
    });
  });

  // ============ properties subcommand ============

  describe('properties', () => {
    test('bulk looks up properties', async () => {
      const results = { 'nytimes.com': PROPERTY, 'unknown.com': null };
      restoreFetch = mockFetch(async () => new Response(JSON.stringify({ results }), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['properties', 'nytimes.com', 'unknown.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Property: nytimes.com'));
      assert.ok(output.stdout.includes("No property found for 'unknown.com'"));
    });
  });

  // ============ authentication ============

  describe('authentication', () => {
    test('--auth flag passes API key to fetch as Bearer token', async () => {
      let capturedOpts;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['brand', 'nike.com', '--auth', 'sk_test_key']);

      assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_test_key');
    });

    test('ADCP_REGISTRY_API_KEY env var is used when no --auth flag', async () => {
      let capturedOpts;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedOpts = opts;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });
      output = captureOutput();

      const saved = process.env.ADCP_REGISTRY_API_KEY;
      process.env.ADCP_REGISTRY_API_KEY = 'sk_env_key';

      try {
        await handleRegistryCommand(['brand', 'nike.com']);
        assert.strictEqual(capturedOpts.headers['Authorization'], 'Bearer sk_env_key');
      } finally {
        if (saved !== undefined) {
          process.env.ADCP_REGISTRY_API_KEY = saved;
        } else {
          delete process.env.ADCP_REGISTRY_API_KEY;
        }
      }
    });
  });

  // ============ --registry-url flag ============

  describe('--registry-url', () => {
    test('uses custom registry URL', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(BRAND), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['brand', 'nike.com', '--registry-url', 'https://custom.registry.io']);

      assert.ok(capturedUrl.startsWith('https://custom.registry.io/api/brands/resolve'));
    });
  });

  // ============ save-brand subcommand ============

  describe('save-brand', () => {
    const SAVE_RESULT = {
      success: true,
      message: 'Brand saved',
      domain: 'acme.com',
      id: 'brand_123',
      revision_number: 1,
    };

    test('saves a brand and pretty-prints result', async () => {
      let capturedBody;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(SAVE_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['save-brand', 'acme.com', 'Acme Corp', '--auth', 'sk_test']);

      assert.strictEqual(code, 0);
      assert.strictEqual(capturedBody.domain, 'acme.com');
      assert.strictEqual(capturedBody.brand_name, 'Acme Corp');
      assert.ok(output.stdout.includes('Saved successfully'));
      assert.ok(output.stdout.includes('brand_123'));
    });

    test('saves a brand with inline manifest JSON', async () => {
      let capturedBody;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(SAVE_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand([
        'save-brand',
        'acme.com',
        'Acme Corp',
        '{"colors":{"primary":"#FF0000"}}',
        '--auth',
        'sk_test',
      ]);

      assert.strictEqual(code, 0);
      assert.deepStrictEqual(capturedBody.brand_manifest, { colors: { primary: '#FF0000' } });
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(SAVE_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['save-brand', 'acme.com', 'Acme Corp', '--auth', 'sk_test', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.id, 'brand_123');
    });

    test('returns exit code 2 when domain or name is missing', async () => {
      output = captureOutput();
      const code = await handleRegistryCommand(['save-brand', 'acme.com', '--auth', 'sk_test']);
      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain and brand name are required'));
    });

    test('returns exit code 1 when no API key is provided', async () => {
      const saved = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      output = captureOutput();

      try {
        const code = await handleRegistryCommand(['save-brand', 'acme.com', 'Acme Corp']);
        assert.strictEqual(code, 1);
        assert.ok(output.stderr.includes('apiKey is required'));
      } finally {
        if (saved !== undefined) process.env.ADCP_REGISTRY_API_KEY = saved;
      }
    });

    test('sends auth header on save requests', async () => {
      let capturedHeaders;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedHeaders = opts.headers;
        return new Response(JSON.stringify(SAVE_RESULT), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['save-brand', 'acme.com', 'Acme Corp', '--auth', 'sk_save_key']);

      assert.strictEqual(capturedHeaders['Authorization'], 'Bearer sk_save_key');
    });
  });

  // ============ save-property subcommand ============

  describe('save-property', () => {
    const SAVE_RESULT = {
      success: true,
      message: 'Property saved',
      id: 'prop_456',
      revision_number: 1,
    };

    test('saves a property and pretty-prints result', async () => {
      let capturedBody;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(SAVE_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand([
        'save-property',
        'example.com',
        'https://agent.example.com',
        '--auth',
        'sk_test',
      ]);

      assert.strictEqual(code, 0);
      assert.strictEqual(capturedBody.publisher_domain, 'example.com');
      assert.deepStrictEqual(capturedBody.authorized_agents, [{ url: 'https://agent.example.com' }]);
      assert.ok(output.stdout.includes('Saved successfully'));
      assert.ok(output.stdout.includes('prop_456'));
    });

    test('saves a property with extra payload JSON', async () => {
      let capturedBody;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(SAVE_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand([
        'save-property',
        'example.com',
        'https://agent.example.com',
        '{"contact":{"email":"admin@example.com"}}',
        '--auth',
        'sk_test',
      ]);

      assert.strictEqual(code, 0);
      assert.strictEqual(capturedBody.publisher_domain, 'example.com');
      assert.strictEqual(capturedBody.contact.email, 'admin@example.com');
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(SAVE_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand([
        'save-property',
        'example.com',
        'https://agent.example.com',
        '--auth',
        'sk_test',
        '--json',
      ]);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.id, 'prop_456');
    });

    test('returns exit code 2 when domain or agent URL is missing', async () => {
      output = captureOutput();
      const code = await handleRegistryCommand(['save-property', 'example.com', '--auth', 'sk_test']);
      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain and agent URL are required'));
    });

    test('returns exit code 1 when no API key is provided', async () => {
      const saved = process.env.ADCP_REGISTRY_API_KEY;
      delete process.env.ADCP_REGISTRY_API_KEY;
      output = captureOutput();

      try {
        const code = await handleRegistryCommand(['save-property', 'example.com', 'https://agent.example.com']);
        assert.strictEqual(code, 1);
        assert.ok(output.stderr.includes('apiKey is required'));
      } finally {
        if (saved !== undefined) process.env.ADCP_REGISTRY_API_KEY = saved;
      }
    });
  });

  // ============ error handling ============

  describe('error handling', () => {
    test('returns exit code 2 for missing subcommand', async () => {
      output = captureOutput();
      const code = await handleRegistryCommand([]);
      assert.strictEqual(code, 2);
    });

    test('returns exit code 2 for unknown subcommand', async () => {
      output = captureOutput();
      const code = await handleRegistryCommand(['unknown', 'nike.com']);
      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes("Unknown registry command: 'unknown'"));
    });

    test('returns exit code 2 for missing domain', async () => {
      output = captureOutput();
      const code = await handleRegistryCommand(['brand']);
      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });

    test('returns exit code 1 on fetch error', async () => {
      restoreFetch = mockFetch(async () => {
        throw new Error('Network failure');
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['brand', 'nike.com']);

      assert.strictEqual(code, 1);
      assert.ok(output.stderr.includes('Network failure'));
    });
  });

  // ============ list-brands ============

  describe('list-brands', () => {
    const LIST_BRANDS_RESULT = {
      brands: [
        { brand_name: 'Nike', canonical_domain: 'nike.com' },
        { brand_name: 'Adidas', canonical_domain: 'adidas.com' },
      ],
      stats: { total: 2 },
    };

    test('lists brands and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LIST_BRANDS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['list-brands']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Brands: 2 results'));
      assert.ok(output.stdout.includes('Nike (nike.com)'));
      assert.ok(output.stdout.includes('Adidas (adidas.com)'));
    });

    test('passes --search to the API as a query parameter', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(LIST_BRANDS_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['list-brands', '--search', 'nike']);

      assert.strictEqual(code, 0);
      assert.ok(capturedUrl.includes('search=nike'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LIST_BRANDS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['list-brands', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.brands.length, 2);
      assert.strictEqual(parsed.brands[0].brand_name, 'Nike');
    });
  });

  // ============ list-properties ============

  describe('list-properties', () => {
    const LIST_PROPS_RESULT = {
      properties: [
        { publisher_domain: 'nytimes.com', source: 'adagents_json' },
        { publisher_domain: 'washpost.com', source: 'manual' },
      ],
      stats: { total: 2 },
    };

    test('lists properties and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LIST_PROPS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['list-properties']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Properties: 2 results'));
      assert.ok(output.stdout.includes('nytimes.com (adagents_json)'));
      assert.ok(output.stdout.includes('washpost.com (manual)'));
    });

    test('passes --search to the API as a query parameter', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(LIST_PROPS_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['list-properties', '--search', 'nyt']);

      assert.strictEqual(code, 0);
      assert.ok(capturedUrl.includes('search=nyt'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LIST_PROPS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['list-properties', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.properties.length, 2);
      assert.strictEqual(parsed.properties[0].publisher_domain, 'nytimes.com');
    });
  });

  // ============ search ============

  describe('search', () => {
    const SEARCH_RESULT = {
      brands: [{ brand_name: 'Nike', canonical_domain: 'nike.com' }],
      publishers: [{ domain: 'nike-publisher.com' }],
      properties: [],
    };

    test('searches and pretty-prints result counts', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(SEARCH_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['search', 'nike']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes("Search results for 'nike':"));
      assert.ok(output.stdout.includes('Brands: 1'));
      assert.ok(output.stdout.includes('Publishers: 1'));
      assert.ok(output.stdout.includes('Properties: 0'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(SEARCH_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['search', 'nike', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.brands.length, 1);
      assert.strictEqual(parsed.publishers.length, 1);
      assert.strictEqual(parsed.properties.length, 0);
    });

    test('returns exit code 2 when query is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['search']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('query is required'));
    });
  });

  // ============ agents ============

  describe('agents', () => {
    const AGENTS_RESULT = {
      agents: [
        { name: 'Test Agent', agent_url: 'https://agent.example.com', type: 'sales' },
        { name: 'Creative Agent', agent_url: 'https://creative.example.com', type: 'creative' },
      ],
      count: 2,
      sources: {},
    };

    test('lists agents and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(AGENTS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['agents']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Agents: 2 registered'));
      assert.ok(output.stdout.includes('Test Agent (sales)'));
      assert.ok(output.stdout.includes('URL: https://agent.example.com'));
    });

    test('passes --type filter to the API', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(AGENTS_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['agents', '--type', 'sales']);

      assert.strictEqual(code, 0);
      assert.ok(capturedUrl.includes('type=sales'));
    });

    test('passes --health flag to the API', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(AGENTS_RESULT), { status: 200 });
      });
      output = captureOutput();

      const code = await handleRegistryCommand(['agents', '--health']);

      assert.strictEqual(code, 0);
      assert.ok(capturedUrl.includes('health=true'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(AGENTS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['agents', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.agents.length, 2);
      assert.strictEqual(parsed.count, 2);
    });
  });

  // ============ publishers ============

  describe('publishers', () => {
    const PUBLISHERS_RESULT = {
      publishers: [{ domain: 'nytimes.com' }, { domain: 'washpost.com' }],
      count: 2,
      sources: {},
    };

    test('lists publishers and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(PUBLISHERS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['publishers']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Publishers: 2 registered'));
      assert.ok(output.stdout.includes('nytimes.com'));
      assert.ok(output.stdout.includes('washpost.com'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(PUBLISHERS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['publishers', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.publishers.length, 2);
      assert.strictEqual(parsed.count, 2);
    });
  });

  // ============ stats ============

  describe('stats', () => {
    const STATS_RESULT = {
      total_brands: 150,
      total_properties: 75,
      total_agents: 12,
      total_publishers: 30,
    };

    test('prints registry statistics', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(STATS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['stats']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Registry Statistics:'));
      assert.ok(output.stdout.includes('total_brands: 150'));
      assert.ok(output.stdout.includes('total_agents: 12'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(STATS_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['stats', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.total_brands, 150);
      assert.strictEqual(parsed.total_properties, 75);
    });
  });

  // ============ validate ============

  describe('validate', () => {
    const VALIDATE_PASS = {
      valid: true,
      errors: [],
      warnings: [],
    };

    const VALIDATE_FAIL = {
      valid: false,
      errors: ['Missing required field: authorized_agents'],
      warnings: ['No properties defined'],
    };

    test('prints PASS for valid adagents.json', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(VALIDATE_PASS), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['validate', 'nytimes.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Validation: PASS'));
      assert.ok(output.stdout.includes('Domain: nytimes.com'));
    });

    test('prints FAIL with errors and warnings', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(VALIDATE_FAIL), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['validate', 'bad.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Validation: FAIL'));
      assert.ok(output.stdout.includes('Errors: 1'));
      assert.ok(output.stdout.includes('Missing required field: authorized_agents'));
      assert.ok(output.stdout.includes('Warnings: 1'));
      assert.ok(output.stdout.includes('No properties defined'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(VALIDATE_PASS), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['validate', 'nytimes.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.valid, true);
    });

    test('returns exit code 2 when domain is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['validate']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });

    test('sends domain as POST body', async () => {
      let capturedBody;
      restoreFetch = mockFetch(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify(VALIDATE_PASS), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['validate', 'example.com']);

      assert.strictEqual(capturedBody.domain, 'example.com');
    });
  });

  // ============ validate-publisher ============

  describe('validate-publisher', () => {
    const VALIDATE_PUB_RESULT = {
      domain: 'nytimes.com',
      has_adagents: true,
      has_ads_txt: true,
      valid: true,
    };

    test('prints publisher validation result', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(VALIDATE_PUB_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['validate-publisher', 'nytimes.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Publisher validation: nytimes.com'));
      assert.ok(output.stdout.includes('has_adagents'));
      assert.ok(output.stdout.includes('valid'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(VALIDATE_PUB_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['validate-publisher', 'nytimes.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.domain, 'nytimes.com');
      assert.strictEqual(parsed.valid, true);
    });

    test('returns exit code 2 when domain is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['validate-publisher']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });
  });

  // ============ lookup ============

  describe('lookup', () => {
    const LOOKUP_RESULT = {
      authorized_agents: [{ url: 'https://agent1.example.com' }, { url: 'https://agent2.example.com' }],
    };

    test('looks up domain and pretty-prints authorized agents', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LOOKUP_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['lookup', 'nytimes.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Domain lookup: nytimes.com'));
      assert.ok(output.stdout.includes('Authorized agents: 2'));
      assert.ok(output.stdout.includes('https://agent1.example.com'));
      assert.ok(output.stdout.includes('https://agent2.example.com'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(LOOKUP_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['lookup', 'nytimes.com', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.authorized_agents.length, 2);
    });

    test('returns exit code 2 when domain is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['lookup']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('domain is required'));
    });

    test('calls the correct API endpoint with encoded domain', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(LOOKUP_RESULT), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['lookup', 'nytimes.com']);

      assert.ok(capturedUrl.includes('/api/registry/lookup/domain/nytimes.com'));
    });
  });

  // ============ discover ============

  describe('discover', () => {
    const DISCOVER_RESULT = {
      agent_url: 'https://test-agent.adcontextprotocol.org',
      protocols: ['a2a', 'mcp'],
      name: 'Test Agent',
      status: 'healthy',
    };

    test('discovers agent and pretty-prints key-value pairs', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(DISCOVER_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['discover', 'https://test-agent.adcontextprotocol.org']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Agent discovery: https://test-agent.adcontextprotocol.org'));
      assert.ok(output.stdout.includes('protocols'));
      assert.ok(output.stdout.includes('name'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(DISCOVER_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['discover', 'https://test-agent.adcontextprotocol.org', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.agent_url, 'https://test-agent.adcontextprotocol.org');
      assert.deepStrictEqual(parsed.protocols, ['a2a', 'mcp']);
    });

    test('returns exit code 2 when URL is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['discover']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('agent URL is required'));
    });

    test('calls the correct API endpoint with encoded URL', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(DISCOVER_RESULT), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['discover', 'https://test-agent.adcontextprotocol.org']);

      assert.ok(capturedUrl.includes('/api/public/discover-agent?url='));
      assert.ok(capturedUrl.includes(encodeURIComponent('https://test-agent.adcontextprotocol.org')));
    });
  });

  // ============ check-auth ============

  describe('check-auth', () => {
    const CHECK_AUTH_RESULT = {
      agent_url: 'https://agent.example.com',
      identifier_type: 'domain',
      identifier_value: 'nytimes.com',
      authorized: true,
      checked_at: '2025-10-01T12:00:00Z',
    };

    test('checks authorization and pretty-prints', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(CHECK_AUTH_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['check-auth', 'https://agent.example.com', 'domain', 'nytimes.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Authorization check:'));
      assert.ok(output.stdout.includes('Agent:      https://agent.example.com'));
      assert.ok(output.stdout.includes('Type:       domain'));
      assert.ok(output.stdout.includes('Value:      nytimes.com'));
      assert.ok(output.stdout.includes('Authorized: Yes'));
      assert.ok(output.stdout.includes('Checked at: 2025-10-01T12:00:00Z'));
    });

    test('prints Authorized: No when not authorized', async () => {
      const unauthorized = { ...CHECK_AUTH_RESULT, authorized: false };
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(unauthorized), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand(['check-auth', 'https://agent.example.com', 'domain', 'evil.com']);

      assert.strictEqual(code, 0);
      assert.ok(output.stdout.includes('Authorized: No'));
    });

    test('outputs JSON with --json flag', async () => {
      restoreFetch = mockFetch(async () => new Response(JSON.stringify(CHECK_AUTH_RESULT), { status: 200 }));
      output = captureOutput();

      const code = await handleRegistryCommand([
        'check-auth',
        'https://agent.example.com',
        'domain',
        'nytimes.com',
        '--json',
      ]);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.strictEqual(parsed.authorized, true);
      assert.strictEqual(parsed.agent_url, 'https://agent.example.com');
      assert.strictEqual(parsed.identifier_type, 'domain');
      assert.strictEqual(parsed.identifier_value, 'nytimes.com');
    });

    test('returns exit code 2 when all three args are missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['check-auth']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('agent URL, identifier type, and identifier value are required'));
    });

    test('returns exit code 2 when identifier type is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['check-auth', 'https://agent.example.com']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('agent URL, identifier type, and identifier value are required'));
    });

    test('returns exit code 2 when identifier value is missing', async () => {
      output = captureOutput();

      const code = await handleRegistryCommand(['check-auth', 'https://agent.example.com', 'domain']);

      assert.strictEqual(code, 2);
      assert.ok(output.stderr.includes('agent URL, identifier type, and identifier value are required'));
    });

    test('passes correct query parameters to the API', async () => {
      let capturedUrl;
      restoreFetch = mockFetch(async url => {
        capturedUrl = url;
        return new Response(JSON.stringify(CHECK_AUTH_RESULT), { status: 200 });
      });
      output = captureOutput();

      await handleRegistryCommand(['check-auth', 'https://agent.example.com', 'domain', 'nytimes.com']);

      assert.ok(capturedUrl.includes('/api/registry/validate/property-authorization'));
      assert.ok(capturedUrl.includes('agent_url='));
      assert.ok(capturedUrl.includes('identifier_type=domain'));
      assert.ok(capturedUrl.includes('identifier_value=nytimes.com'));
    });
  });
});
