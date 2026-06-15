/**
 * Per-seller brand-override projection.
 *
 * The SDK strips the AdCP 3.1-only `brand_kit_override` field from outbound
 * requests when the negotiated target is pre-3.1 (client pinned <3.1 OR the
 * seller does not advertise 3.1). `industries` and `data_subject_contestation`
 * are declared in AdCP 3.0 and are left on the wire. Identity fields (`domain`,
 * `brand_id`) are always kept. A 3.1 seller receives the full overrides.
 *
 * `projectRequestForSellerVersion` returns `{ params, driftLog? }`. A
 * `pre31_brand_fields_stripped` drift entry is emitted whenever stripping occurs.
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

test('create_media_buy brand: brand_kit_override stripped for legacy 3.0 seller, 3.0 fields preserved', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const { params: out, driftLog } = c.projectRequestForSellerVersion('create_media_buy', { brand: { ...brand }, idempotency_key: 'k' });
  assert.deepEqual(out.brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
  assert.equal(driftLog?.type, 'pre31_brand_fields_stripped');
  assert.deepEqual(driftLog?.strippedFields, ['brand_kit_override']);
});

test('create_media_buy brand: overrides preserved for 3.1 seller, no drift log', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], buildVersion: '3.1.0', _synthetic: false };
  const { params: out, driftLog } = c.projectRequestForSellerVersion('create_media_buy', { brand: { ...brand }, idempotency_key: 'k' });
  assert.deepEqual(out.brand.brand_kit_override, { colors: { accent: '#f5ce65' } });
  assert.deepEqual(out.brand.industries, ['cpg']);
  assert.equal(driftLog, undefined);
});

test('get_products brand: brand_kit_override stripped for legacy 3.0 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const { params: out } = c.projectRequestForSellerVersion('get_products', { brand: { ...brand }, brief: 'x' });
  assert.deepEqual(out.brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
});

test('sync_accounts brand: brand_kit_override stripped at accounts[].brand for 3.0 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const { params: out } = c.projectRequestForSellerVersion('sync_accounts', {
    accounts: [{ brand: { ...brand }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  });
  assert.deepEqual(out.accounts[0].brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
  assert.equal(out.accounts[0].operator, 'o');
});

test('sync_accounts brand: overrides preserved for 3.1 seller', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], buildVersion: '3.1.0', _synthetic: false };
  const { params: out } = c.projectRequestForSellerVersion('sync_accounts', {
    accounts: [{ brand: { ...brand }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  });
  assert.deepEqual(out.accounts[0].brand.brand_kit_override, { colors: { accent: '#f5ce65' } });
});

test('projectRequestForSellerVersion passes through non-object params', () => {
  const c = new SingleAgentClient(agent);
  c.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  const { params } = c.projectRequestForSellerVersion('get_products', undefined);
  assert.equal(params, undefined);
});
