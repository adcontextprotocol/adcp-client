const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { RegistryClient } = require('../../dist/lib/registry/index.js');

const BASE_URL = process.env.ADCP_E2E_REGISTRY_BASE_URL || 'https://agenticadvertising.org';
const READ_DOMAIN = process.env.ADCP_E2E_BRAND_LOGO_DOMAIN || 'nike.com';
const UPLOAD_DOMAIN = process.env.ADCP_E2E_UPLOAD_BRAND_LOGO_DOMAIN;
const UPLOAD_ENABLED = !!(process.env.ADCP_REGISTRY_API_KEY && UPLOAD_DOMAIN);
const ALLOW_EMPTY_READ_DOMAIN =
  UPLOAD_ENABLED && READ_DOMAIN === UPLOAD_DOMAIN && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE_URL);

describe('RegistryClient live AAO brand logo endpoints', () => {
  test('lists live brand logo assets', async () => {
    const client = new RegistryClient({ baseUrl: BASE_URL });
    const result = await client.listBrandLogos(READ_DOMAIN);

    assert.equal(result.domain, READ_DOMAIN);
    assert.ok(Array.isArray(result.assets), 'assets must be an array');
    if (ALLOW_EMPTY_READ_DOMAIN && result.assets.length === 0) return;
    assert.ok(result.assets.length > 0, `expected live logos for ${READ_DOMAIN}`);

    for (const logo of result.assets) {
      assert.equal(typeof logo.id, 'string');
      assert.ok(logo.id.length > 0, 'logo.id must be non-empty');
      assert.equal(typeof logo.content_type, 'string');
      assert.ok(logo.content_type.startsWith('image/'), `unexpected content_type: ${logo.content_type}`);
      assert.equal(typeof logo.source, 'string');
      assert.ok(Array.isArray(logo.tags), 'logo.tags must be an array');
      assert.ok(['approved', 'pending'].includes(logo.review_status), `unexpected status: ${logo.review_status}`);
      if (logo.review_status === 'approved') {
        assert.equal(typeof logo.url, 'string');
        assert.ok(logo.url.startsWith(`${BASE_URL}/assets/brands/${READ_DOMAIN}/`), `unexpected logo URL: ${logo.url}`);
      }
    }
  });

  test('filters live logo assets by tags query parameter', async () => {
    const client = new RegistryClient({ baseUrl: BASE_URL });
    const result = await client.listBrandLogos(READ_DOMAIN, { tags: ['primary'] });

    assert.equal(result.domain, READ_DOMAIN);
    if (ALLOW_EMPTY_READ_DOMAIN && result.assets.length === 0) return;
    assert.ok(result.assets.length > 0, `expected primary logos for ${READ_DOMAIN}`);
    assert.ok(
      result.assets.every(logo => logo.tags.includes('primary')),
      `expected every returned logo to include primary tag: ${JSON.stringify(result.assets)}`
    );
  });

  test(
    'uploads a live brand logo asset when explicitly enabled',
    {
      skip: UPLOAD_ENABLED
        ? false
        : 'Set ADCP_REGISTRY_API_KEY and ADCP_E2E_UPLOAD_BRAND_LOGO_DOMAIN to run the mutating live upload test',
    },
    async () => {
      const client = new RegistryClient({ baseUrl: BASE_URL, apiKey: process.env.ADCP_REGISTRY_API_KEY });
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

      const result = await client.saveBrandLogo({
        domain: UPLOAD_DOMAIN,
        data: Buffer.from(svg, 'utf8'),
        filename: `adcp-sdk-e2e-${Date.now()}.svg`,
        mimeType: 'image/svg+xml',
        tags: ['primary'],
        note: 'Automated @adcp/sdk live e2e upload test',
      });

      assert.equal(typeof result.logo_id, 'string');
      assert.ok(['approved', 'pending'].includes(result.review_status), `unexpected status: ${result.review_status}`);
      if (result.review_status === 'approved') {
        assert.equal(typeof result.url, 'string');
      }

      const listed = await client.listBrandLogos(UPLOAD_DOMAIN, { tags: ['primary'] });
      assert.ok(
        listed.assets.some(logo => logo.id === result.logo_id),
        `expected uploaded logo ${result.logo_id} in list response: ${JSON.stringify(listed)}`
      );
    }
  );
});
