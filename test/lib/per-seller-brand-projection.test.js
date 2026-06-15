/**
 * Per-seller brand-override projection.
 *
 * The SDK strips AdCP 3.1-only brand inline-override fields
 * (`industries`, `data_subject_contestation`, `brand_kit_override`) from
 * outbound requests when the negotiated target is pre-3.1 (client pinned
 * <3.1 OR the seller does not advertise 3.1). Identity fields (`domain`,
 * `brand_id`) are always kept so the seller can resolve the brand from
 * brand.json. A 3.1 seller still receives the full overrides.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

const agent = { id: 's', name: 's', protocol: 'mcp', agent_uri: 'https://s.example/mcp' };
const brand = {
  domain: 'goldpeaktea.com',
  brand_id: 'b',
  industries: ['cpg'],
  data_subject_contestation: { email: 'p@goldpeaktea.com' },
  brand_kit_override: { colors: { accent: '#f5ce65' } },
};

test('create_media_buy brand: overrides stripped for legacy 3.0 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const out = c.projectRequestForSellerVersion('create_media_buy', { brand: { ...brand }, idempotency_key: 'k' });
  assert.deepEqual(out.brand, { domain: 'goldpeaktea.com', brand_id: 'b' });
});

test('create_media_buy brand: overrides preserved for 3.1 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], buildVersion: '3.1.0', _synthetic: false };
  const out = c.projectRequestForSellerVersion('create_media_buy', { brand: { ...brand }, idempotency_key: 'k' });
  assert.deepEqual(out.brand.brand_kit_override, { colors: { accent: '#f5ce65' } });
  assert.deepEqual(out.brand.industries, ['cpg']);
});

test('get_products brand: overrides stripped for legacy 3.0 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const out = c.projectRequestForSellerVersion('get_products', { brand: { ...brand }, brief: 'x' });
  assert.deepEqual(out.brand, { domain: 'goldpeaktea.com', brand_id: 'b' });
});

test('sync_accounts brand: overrides stripped at accounts[].brand for 3.0 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const out = c.projectRequestForSellerVersion('sync_accounts', {
    accounts: [{ brand: { ...brand }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  });
  assert.deepEqual(out.accounts[0].brand, { domain: 'goldpeaktea.com', brand_id: 'b' });
  assert.equal(out.accounts[0].operator, 'o');
});

test('sync_accounts brand: overrides preserved for 3.1 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], buildVersion: '3.1.0', _synthetic: false };
  const out = c.projectRequestForSellerVersion('sync_accounts', {
    accounts: [{ brand: { ...brand }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  });
  assert.deepEqual(out.accounts[0].brand.brand_kit_override, { colors: { accent: '#f5ce65' } });
});

test('projectRequestForSellerVersion passes through non-object params', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  assert.equal(c.projectRequestForSellerVersion('get_products', undefined), undefined);
});
