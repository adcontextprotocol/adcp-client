const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  BrandJsonSchema,
  AdagentsJsonSchema,
  getSandboxBrands,
  clearSandboxCache,
} = require('../../dist/lib/testing/index.js');

describe('BrandJsonSchema', () => {
  test('accepts minimal house portfolio', () => {
    const data = {
      $schema: 'https://adcontextprotocol.org/schemas/brand.json',
      house: { domain: 'example.com', name: 'Example' },
      brands: [{ id: 'acme', names: [{ en: 'Acme' }] }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts full brand entry with creative fields', () => {
    const data = {
      $schema: 'https://adcontextprotocol.org/schemas/brand.json',
      house: { domain: 'acmeoutdoor.example', name: 'Acme Outdoor' },
      brands: [
        {
          id: 'acme_outdoor',
          names: [{ en: 'Acme Outdoor' }],
          keller_type: 'master',
          description: 'Premium outdoor gear',
          logos: [
            {
              url: 'https://cdn.example.com/logo.png',
              orientation: 'horizontal',
              background: 'light-bg',
              variant: 'primary',
            },
          ],
          colors: { primary: '#1B5E20', secondary: '#FF6F00' },
          fonts: { primary: 'Montserrat' },
          tone: {
            voice: 'Confident and adventurous',
            attributes: ['active', 'direct', 'warm'],
          },
        },
      ],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts house redirect variant', () => {
    const data = {
      $schema: 'https://adcontextprotocol.org/schemas/brand.json',
      house: 'nikeinc.com',
      note: 'Redirect to house domain',
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts authoritative location redirect variant', () => {
    const data = {
      authoritative_location: 'https://cdn.example.com/brand.json',
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts brand agent variant', () => {
    const data = {
      agents: [{ type: 'brand', url: 'https://agent.example.com', id: 'brand_agent' }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });
});

describe('BrandJsonSchema rejections', () => {
  test('rejects non-object input', () => {
    assert.strictEqual(BrandJsonSchema.safeParse(42).success, false);
    assert.strictEqual(BrandJsonSchema.safeParse('string').success, false);
    assert.strictEqual(BrandJsonSchema.safeParse(null).success, false);
  });

  test('rejects array input', () => {
    assert.strictEqual(BrandJsonSchema.safeParse([]).success, false);
  });
});

describe('AdagentsJsonSchema rejections', () => {
  test('rejects non-object input', () => {
    assert.strictEqual(AdagentsJsonSchema.safeParse(42).success, false);
    assert.strictEqual(AdagentsJsonSchema.safeParse('string').success, false);
    assert.strictEqual(AdagentsJsonSchema.safeParse(null).success, false);
  });

  test('rejects agent with invalid authorization_type', () => {
    const data = {
      contact: { name: 'Test' },
      authorized_agents: [{ url: 'https://a.example.com', authorization_type: 'invalid_type' }],
    };
    assert.strictEqual(AdagentsJsonSchema.safeParse(data).success, false);
  });
});

describe('AdagentsJsonSchema', () => {
  test('accepts authoritative location redirect', () => {
    const data = {
      authoritative_location: 'https://cdn.example.com/adagents.json',
    };
    const result = AdagentsJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts inline structure with authorized agents', () => {
    const data = {
      contact: { name: 'Publisher Ops' },
      properties: [
        {
          property_type: 'website',
          name: 'Example Site',
          identifiers: [{ type: 'domain', value: 'example.com' }],
        },
      ],
      authorized_agents: [
        {
          url: 'https://seller.example.com',
          authorization_type: 'property_ids',
          property_ids: ['main_site'],
          authorized_for: 'All inventory',
        },
      ],
    };
    const result = AdagentsJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts minimal inline structure', () => {
    const data = {
      contact: { name: 'Test' },
      authorized_agents: [],
    };
    const result = AdagentsJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });
});

describe('Sandbox brand_json validation', () => {
  test('all sandbox brands produce valid brand_json', () => {
    clearSandboxCache();
    const brands = getSandboxBrands();
    assert.ok(brands.length > 0, 'Expected at least one sandbox brand');

    for (const brand of brands) {
      const result = BrandJsonSchema.safeParse(brand.brand_json);
      assert.strictEqual(
        result.success,
        true,
        `brand_json for ${brand.domain} failed validation: ${JSON.stringify(result.error?.issues)}`
      );
    }
  });

  test('sandbox brand_json uses spec-compliant field names', () => {
    clearSandboxCache();
    const brands = getSandboxBrands();

    for (const brand of brands) {
      const bj = brand.brand_json;
      assert.ok(Array.isArray(bj.brands), `${brand.domain}: brands must be an array`);
      for (const entry of bj.brands) {
        assert.ok('id' in entry, `${brand.domain}: brand entry must use "id" not "brand_id"`);
        assert.ok('names' in entry, `${brand.domain}: brand entry must use "names" not "name"`);
        assert.ok(Array.isArray(entry.names), `${brand.domain}: names must be an array`);
      }
    }
  });
});
