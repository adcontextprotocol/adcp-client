// Tests for buyer_ref emission in adaptCreateMediaBuyRequestForV2 (issue #1115)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  adaptCreateMediaBuyRequestForV2,
  adaptPackageRequestForV2,
} = require('../../dist/lib/utils/creative-adapter.js');

const IK = '11111111-1111-1111-1111-111111111111';

const baseRequest = () => ({
  account: { account_id: 'acct-1' },
  brand: { domain: 'example.com' },
  packages: [
    { product_id: 'prod-1', budget: 1000, pricing_option_id: 'po-1' },
    { product_id: 'prod-2', budget: 500, pricing_option_id: 'po-2' },
  ],
  start_time: 'asap',
  end_time: '2027-12-31T23:59:59Z',
  idempotency_key: IK,
});

describe('adaptCreateMediaBuyRequestForV2 — buyer_ref (issue #1115)', () => {
  test('emits top-level buyer_ref derived from idempotency_key', () => {
    const adapted = adaptCreateMediaBuyRequestForV2(baseRequest());
    assert.equal(adapted.buyer_ref, IK, 'top-level buyer_ref must equal idempotency_key');
  });

  test('emits per-package buyer_ref with stable index suffix when package has no idempotency_key', () => {
    const adapted = adaptCreateMediaBuyRequestForV2(baseRequest());
    assert.equal(adapted.packages[0].buyer_ref, `${IK}-0`);
    assert.equal(adapted.packages[1].buyer_ref, `${IK}-1`);
  });

  test('per-package buyer_ref uses package idempotency_key when present', () => {
    const req = baseRequest();
    req.packages[0].idempotency_key = 'pkg-key-aaa';
    const adapted = adaptCreateMediaBuyRequestForV2(req);
    assert.equal(adapted.packages[0].buyer_ref, 'pkg-key-aaa');
    assert.equal(adapted.packages[1].buyer_ref, `${IK}-1`);
  });

  test('does not overwrite an explicit per-package buyer_ref', () => {
    const req = baseRequest();
    req.packages[0].buyer_ref = 'explicit-buyer-ref';
    const adapted = adaptCreateMediaBuyRequestForV2(req);
    assert.equal(adapted.packages[0].buyer_ref, 'explicit-buyer-ref');
  });

  test('buyer_ref is stable across replays (same idempotency_key → same buyer_ref)', () => {
    const a = adaptCreateMediaBuyRequestForV2(baseRequest());
    const b = adaptCreateMediaBuyRequestForV2(baseRequest());
    assert.equal(a.buyer_ref, b.buyer_ref);
    assert.equal(a.packages[0].buyer_ref, b.packages[0].buyer_ref);
    assert.equal(a.packages[1].buyer_ref, b.packages[1].buyer_ref);
  });

  test('idempotency_key is stripped from v2 output (not passed to v2 server)', () => {
    const adapted = adaptCreateMediaBuyRequestForV2(baseRequest());
    assert.equal(adapted.idempotency_key, undefined, 'idempotency_key must not appear in v2 output');
  });

  test('adaptPackageRequestForV2 preserves pre-existing buyer_ref', () => {
    const pkg = { product_id: 'p1', buyer_ref: 'keep-me' };
    const adapted = adaptPackageRequestForV2(pkg);
    assert.equal(adapted.buyer_ref, 'keep-me');
  });
});
