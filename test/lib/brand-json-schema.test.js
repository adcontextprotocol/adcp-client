const { describe, test } = require('node:test');
const assert = require('node:assert');

const { BrandJsonSchema, getSandboxBrands, clearSandboxCache } = require('../../dist/lib/testing/index.js');

describe('BrandJsonSchema', () => {
  test('accepts minimal house portfolio', () => {
    const data = {
      $schema: 'https://adcontextprotocol.org/schemas/brand.json',
      house: 'example.com',
      brands: [{ id: 'acme', names: [{ en: 'Acme' }] }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('accepts full brand entry with creative fields', () => {
    const data = {
      $schema: 'https://adcontextprotocol.org/schemas/brand.json',
      house: 'acmeoutdoor.example',
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

  test('accepts house as structured object', () => {
    const data = {
      house: { domain: 'example.com', name: 'Example Corp' },
      brands: [{ id: 'ex', names: [{ en: 'Example' }] }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('rejects missing brands', () => {
    const data = { house: 'example.com' };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, false);
  });

  test('rejects empty brands array', () => {
    const data = { house: 'example.com', brands: [] };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, false);
  });

  test('rejects brand entry missing id', () => {
    const data = {
      house: 'example.com',
      brands: [{ names: [{ en: 'Test' }] }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, false);
  });

  test('rejects brand entry missing names', () => {
    const data = {
      house: 'example.com',
      brands: [{ id: 'test' }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, false);
  });

  test('rejects invalid hex color', () => {
    const data = {
      house: 'example.com',
      brands: [{ id: 'x', names: [{ en: 'X' }], colors: { primary: 'red' } }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, false);
  });

  test('accepts color arrays', () => {
    const data = {
      house: 'example.com',
      brands: [{ id: 'x', names: [{ en: 'X' }], colors: { primary: ['#FF0000', '#00FF00'] } }],
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  test('preserves passthrough properties', () => {
    const data = {
      house: 'example.com',
      brands: [{ id: 'x', names: [{ en: 'X' }], custom_field: 'hello' }],
      custom_root: true,
    };
    const result = BrandJsonSchema.safeParse(data);
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
    assert.strictEqual(result.data.brands[0].custom_field, 'hello');
    assert.strictEqual(result.data.custom_root, true);
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
