/**
 * Per-seller brand-override projection.
 *
 * The 3.0 version adapters strip `brand_kit_override` (a 3.1-only field)
 * from outbound brand references when the negotiated target is pre-3.1.
 * `industries` and `data_subject_contestation` are declared in AdCP 3.0
 * and are left on the wire. A 3.1 seller receives the full overrides.
 *
 * `resolveAdapterKey` returns '3.0' whenever `shouldOmit31Fields` is true
 * (client pinned <3.1 OR seller does not advertise 3.1). The adapter emits
 * a `pre31_brand_fields_stripped` drift entry when stripping occurs.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { getVersionAdapter, resolveAdapterKey } = require('../../dist/lib/adapters/version/index.js');

const brand = {
  domain: 'goldpeaktea.com',
  brand_id: 'b',
  industries: ['cpg'],
  data_subject_contestation: { email: 'p@goldpeaktea.com' },
  brand_kit_override: { colors: { accent: '#f5ce65' } },
};

const caps30 = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
const caps31 = { version: 'v3', majorVersions: [3], buildVersion: '3.1.0', _synthetic: false };

test('resolveAdapterKey: returns 3.0 for pre-3.1 client', () => {
  assert.equal(resolveAdapterKey('3.0', caps31), '3.0');
});
test('resolveAdapterKey: returns 3.0 for 3.1 client with 3.0 seller', () => {
  assert.equal(resolveAdapterKey('3.1.0', caps30), '3.0');
});
test('resolveAdapterKey: returns undefined for 3.1 client with 3.1 seller', () => {
  assert.equal(resolveAdapterKey('3.1.0', caps31), undefined);
});

test('create_media_buy: brand_kit_override stripped, 3.0 fields preserved', () => {
  const adapter = getVersionAdapter('3.0', 'create_media_buy');
  const { params, drift } = adapter.adaptRequest({ brand: { ...brand }, idempotency_key: 'k' });
  assert.deepEqual(params.brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
  assert.equal(drift?.type, 'pre31_brand_fields_stripped');
  assert.deepEqual(drift?.strippedFields, ['brand_kit_override']);
});

test('create_media_buy: no strip when brand_kit_override absent', () => {
  const adapter = getVersionAdapter('3.0', 'create_media_buy');
  const input = { brand: { domain: 'goldpeaktea.com', brand_id: 'b' }, idempotency_key: 'k' };
  const { params, drift } = adapter.adaptRequest(input);
  assert.equal(params, input);
  assert.equal(drift, undefined);
});

test('get_products: brand_kit_override stripped for 3.0 target', () => {
  const adapter = getVersionAdapter('3.0', 'get_products');
  const { params, drift } = adapter.adaptRequest({ brand: { ...brand }, brief: 'x' });
  assert.deepEqual(params.brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
  assert.ok(drift);
});

test('sync_accounts: brand_kit_override stripped at accounts[].brand', () => {
  const adapter = getVersionAdapter('3.0', 'sync_accounts');
  const { params, drift } = adapter.adaptRequest({
    accounts: [{ brand: { ...brand }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  });
  assert.deepEqual(params.accounts[0].brand, {
    domain: 'goldpeaktea.com',
    brand_id: 'b',
    industries: ['cpg'],
    data_subject_contestation: { email: 'p@goldpeaktea.com' },
  });
  assert.equal(params.accounts[0].operator, 'o');
  assert.ok(drift);
});

test('sync_accounts: no strip when no account has brand_kit_override', () => {
  const adapter = getVersionAdapter('3.0', 'sync_accounts');
  const input = {
    accounts: [{ brand: { domain: 'goldpeaktea.com', brand_id: 'b' }, operator: 'o', billing: 'operator' }],
    idempotency_key: 'k',
  };
  const { params, drift } = adapter.adaptRequest(input);
  assert.equal(params, input);
  assert.equal(drift, undefined);
});

test('adapters return undefined for unregistered tools at 3.0', () => {
  assert.equal(getVersionAdapter('3.0', 'list_creative_formats'), undefined);
  assert.equal(getVersionAdapter('3.0', 'get_signals'), undefined);
});
