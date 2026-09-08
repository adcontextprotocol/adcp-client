const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BrandDomainValidationError, isDevelopmentBrandDomain, validateBrandDomain } = require('@adcp/sdk/brand');

describe('BrandRef domain validation', () => {
  it('accepts and canonicalizes public and private-PSL domains', () => {
    assert.strictEqual(validateBrandDomain('Ads.Brand.COM'), 'ads.brand.com');
    assert.strictEqual(validateBrandDomain('brand.co.uk'), 'brand.co.uk');
    assert.strictEqual(validateBrandDomain('tenant.github.io'), 'tenant.github.io');
  });

  it('rejects single-label, public-suffix, unknown-suffix, IP, and URL inputs', () => {
    for (const domain of ['localhost', 'unknown', 'co.uk', 'brand.unknown', '1.2.3.4', 'https://brand.com']) {
      assert.throws(() => validateBrandDomain(domain), BrandDomainValidationError, domain);
    }
  });

  it('requires an explicit development-domain option', () => {
    for (const domain of [
      'brand.localhost',
      'brand.test',
      'brand.example',
      'brand.invalid',
      'example.com',
      'example.net',
      'example.org',
    ]) {
      assert.throws(
        () => validateBrandDomain(domain),
        error => error instanceof BrandDomainValidationError && error.code === 'special_use_not_allowed',
        domain
      );
      assert.strictEqual(validateBrandDomain(domain, { allowDevelopmentDomains: true }), domain);
      assert.strictEqual(isDevelopmentBrandDomain(domain), true);
    }
  });

  it('never treats mDNS .local as a development exception', () => {
    assert.strictEqual(isDevelopmentBrandDomain('brand.local'), false);
    assert.throws(
      () => validateBrandDomain('brand.local', { allowDevelopmentDomains: true }),
      BrandDomainValidationError
    );
  });
});
