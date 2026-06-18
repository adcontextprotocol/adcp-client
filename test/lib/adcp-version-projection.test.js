const { test } = require('node:test');
const assert = require('node:assert');
const {
  sellerAdvertises31,
  shouldOmit31Fields,
  omit31BrandFields,
} = require('../../dist/lib/utils/adcp-version-config.js');

test('sellerAdvertises31: true when buildVersion >= 3.1', () => {
  assert.equal(sellerAdvertises31({ buildVersion: '3.1.0' }), true);
  assert.equal(sellerAdvertises31({ buildVersion: '3.2.1' }), true);
});
test('sellerAdvertises31: true when supportedVersions contains a >=3.1 release', () => {
  assert.equal(sellerAdvertises31({ supportedVersions: ['3.0', '3.1'] }), true);
});
test('sellerAdvertises31: false for legacy 3.0-only sellers / missing fields', () => {
  assert.equal(sellerAdvertises31(undefined), false);
  assert.equal(sellerAdvertises31({}), false);
  assert.equal(sellerAdvertises31({ supportedVersions: ['3.0'] }), false);
});
test('shouldOmit31Fields: client pinned <3.1 always omits', () => {
  assert.equal(shouldOmit31Fields('3.0', { supportedVersions: ['3.1'] }), true);
});
test('shouldOmit31Fields: 3.1 client omits for legacy sellers, sends to 3.1 sellers', () => {
  assert.equal(shouldOmit31Fields('3.1', { supportedVersions: ['3.0'] }), true);
  assert.equal(shouldOmit31Fields('3.1', { buildVersion: '3.1.0' }), false);
  assert.equal(shouldOmit31Fields('3.1', undefined), true);
});
test('omit31BrandFields strips brand_kit_override only, preserves AdCP 3.0 fields', () => {
  assert.deepEqual(
    omit31BrandFields({
      domain: 'goldpeaktea.com',
      brand_id: 'brand_4045',
      industries: ['cpg'],
      data_subject_contestation: { email: 'p@goldpeaktea.com' },
      brand_kit_override: { colors: { accent: '#f5ce65' } },
    }),
    {
      domain: 'goldpeaktea.com',
      brand_id: 'brand_4045',
      industries: ['cpg'],
      data_subject_contestation: { email: 'p@goldpeaktea.com' },
    }
  );
});
test('omit31BrandFields passes through non-object values untouched', () => {
  assert.equal(omit31BrandFields(undefined), undefined);
  assert.equal(omit31BrandFields('https://example.com'), 'https://example.com');
});
