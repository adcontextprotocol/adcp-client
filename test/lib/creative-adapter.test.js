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

  test('emits per-package buyer_ref anchored on product_id + pricing_option_id (order-independent)', () => {
    const adapted = adaptCreateMediaBuyRequestForV2(baseRequest());
    assert.equal(adapted.packages[0].buyer_ref, `${IK}-prod-1-po-1`);
    assert.equal(adapted.packages[1].buyer_ref, `${IK}-prod-2-po-2`);
  });

  test('per-package buyer_ref is stable when package order is reversed on replay', () => {
    const req1 = baseRequest();
    const req2 = { ...baseRequest(), packages: [...baseRequest().packages].reverse() };
    const a = adaptCreateMediaBuyRequestForV2(req1);
    const b = adaptCreateMediaBuyRequestForV2(req2);
    // Each package must get the same buyer_ref regardless of position
    const refsByProduct = (pkgs) => Object.fromEntries(
      pkgs.map(p => [p.product_id, p.buyer_ref])
    );
    assert.deepEqual(refsByProduct(a.packages), refsByProduct(b.packages));
  });

  test('does not overwrite an explicit per-package buyer_ref', () => {
    const req = baseRequest();
    req.packages[0].buyer_ref = 'explicit-buyer-ref';
    const adapted = adaptCreateMediaBuyRequestForV2(req);
    assert.equal(adapted.packages[0].buyer_ref, 'explicit-buyer-ref');
  });

  test('does not overwrite a top-level buyer_ref supplied by the caller', () => {
    const req = { ...baseRequest(), buyer_ref: 'caller-supplied-ref' };
    const adapted = adaptCreateMediaBuyRequestForV2(req);
    assert.equal(adapted.buyer_ref, 'caller-supplied-ref');
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
