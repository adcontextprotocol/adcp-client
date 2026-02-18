// Tests for the BrandManifest -> BrandReference backwards compatibility layer
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import from the compiled lib
const { brandManifestToBrandReference } = require('../../dist/lib/types/compat');

describe('brandManifestToBrandReference', () => {
  describe('string input', () => {
    test('extracts domain from a full URL string', () => {
      const result = brandManifestToBrandReference('https://brand.example.com/brand.json');
      assert.deepStrictEqual(result, { domain: 'brand.example.com' });
    });

    test('extracts domain from a URL without path', () => {
      const result = brandManifestToBrandReference('https://example.com');
      assert.deepStrictEqual(result, { domain: 'example.com' });
    });

    test('extracts domain from a URL with port', () => {
      const result = brandManifestToBrandReference('https://example.com:8080/path');
      assert.deepStrictEqual(result, { domain: 'example.com' });
    });

    test('returns undefined for a non-URL string', () => {
      const result = brandManifestToBrandReference('just a brand name');
      assert.strictEqual(result, undefined);
    });

    test('returns undefined for empty string', () => {
      const result = brandManifestToBrandReference('');
      assert.strictEqual(result, undefined);
    });
  });

  describe('object input', () => {
    test('extracts domain from manifest.url', () => {
      const result = brandManifestToBrandReference({
        name: 'Acme Corp',
        url: 'https://acme.com',
      });
      assert.deepStrictEqual(result, { domain: 'acme.com' });
    });

    test('returns undefined when manifest has no url', () => {
      const result = brandManifestToBrandReference({ name: 'Name Only Brand' });
      assert.strictEqual(result, undefined);
    });

    test('returns undefined when manifest.url is empty', () => {
      const result = brandManifestToBrandReference({ name: 'Brand', url: '' });
      assert.strictEqual(result, undefined);
    });

    test('extracts domain ignoring manifest.url path and query', () => {
      const result = brandManifestToBrandReference({
        name: 'Brand',
        url: 'https://brand.example.com/.well-known/brand.json?v=2',
      });
      assert.deepStrictEqual(result, { domain: 'brand.example.com' });
    });
  });
});
