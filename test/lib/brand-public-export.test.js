const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../../package.json');

describe('brand helpers public exports', () => {
  it('exports brand helpers from the package root and @adcp/sdk/brand', async () => {
    const sdk = require('@adcp/sdk');
    const brand = require('@adcp/sdk/brand');

    assert.strictEqual(typeof sdk.applyBrandAssetMappings, 'function');
    assert.strictEqual(typeof sdk.validateBrandAssetMappings, 'function');
    assert.strictEqual(typeof sdk.selectLogoForSlot, 'function');
    assert.strictEqual(typeof sdk.checkLogoSlotCoverage, 'function');
    assert.strictEqual(typeof sdk.extractBrandWebsiteAliases, 'function');
    assert.strictEqual(typeof sdk.extractBrandWebsiteAliasDomains, 'function');
    assert.strictEqual(typeof sdk.updateBrandJsonFromMappings, 'function');

    assert.strictEqual(typeof brand.applyBrandAssetMappings, 'function');
    assert.strictEqual(typeof brand.validateBrandAssetMappings, 'function');
    assert.strictEqual(typeof brand.selectLogoForSlot, 'function');
    assert.strictEqual(typeof brand.checkLogoSlotCoverage, 'function');
    assert.strictEqual(typeof brand.extractBrandWebsiteAliases, 'function');
    assert.strictEqual(typeof brand.extractBrandWebsiteAliasDomains, 'function');
    assert.strictEqual(typeof brand.updateBrandJsonFromMappings, 'function');

    assert.strictEqual(sdk.applyBrandAssetMappings, brand.applyBrandAssetMappings);
    assert.strictEqual(sdk.selectLogoForSlot, brand.selectLogoForSlot);
    assert.strictEqual(sdk.extractBrandWebsiteAliases, brand.extractBrandWebsiteAliases);
    assert.strictEqual(sdk.extractBrandWebsiteAliasDomains, brand.extractBrandWebsiteAliasDomains);
    assert.deepStrictEqual([...sdk.COMMON_LOGO_SLOTS], [...brand.COMMON_LOGO_SLOTS]);

    const esmSdk = await import('@adcp/sdk');
    const esmBrand = await import('@adcp/sdk/brand');
    assert.strictEqual(typeof esmSdk.extractBrandWebsiteAliases, 'function');
    assert.strictEqual(typeof esmSdk.extractBrandWebsiteAliasDomains, 'function');
    assert.strictEqual(typeof esmBrand.extractBrandWebsiteAliases, 'function');
    assert.strictEqual(typeof esmBrand.extractBrandWebsiteAliasDomains, 'function');
    assert.strictEqual(esmSdk.extractBrandWebsiteAliases, esmBrand.extractBrandWebsiteAliases);
    assert.strictEqual(esmSdk.extractBrandWebsiteAliasDomains, esmBrand.extractBrandWebsiteAliasDomains);
  });

  it('publishes runtime and declaration paths for @adcp/sdk/brand', () => {
    assert.deepStrictEqual(pkg.exports['./brand'], {
      import: './dist/lib/brand/index.js',
      require: './dist/lib/brand/index.js',
      types: './dist/lib/brand/index.d.ts',
    });
    assert.deepStrictEqual(pkg.typesVersions['*'].brand, ['dist/lib/brand/index.d.ts']);

    const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'brand');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.js')), 'dist/lib/brand/index.js must exist');
    assert.ok(fs.existsSync(path.join(distRoot, 'index.d.ts')), 'dist/lib/brand/index.d.ts must exist');

    const rootDeclarations = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'lib', 'index.d.ts'), 'utf8');
    const brandDeclarations = fs.readFileSync(path.join(distRoot, 'index.d.ts'), 'utf8');
    for (const name of [
      'extractBrandWebsiteAliases',
      'extractBrandWebsiteAliasDomains',
      'BrandWebsiteAlias',
      'BrandWebsiteAliasRelationship',
      'BrandWebsiteAliasSource',
      'ExtractBrandWebsiteAliasesOptions',
    ]) {
      assert.ok(rootDeclarations.includes(name), `dist/lib/index.d.ts must declare ${name}`);
      assert.ok(brandDeclarations.includes(name), `dist/lib/brand/index.d.ts must declare ${name}`);
    }
  });
});
