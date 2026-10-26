// Cross-SDK delegation-chain vectors (adcontextprotocol/adcp L2 "Grants in
// trust records"), vendored from adcontextprotocol/adcp#8473. Each vector is
// an acts-for claim, the parent organization the brand resolves to, and the
// trust records each domain publishes; authorizeDemandGrant must reach the
// expected outcome.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../../dist/lib/identity-3.3');
const fixture = require('../fixtures/delegation-chains/delegation-chains.json');

// The vectors use `.example` names, which have no registrable domain under
// the PSL. Map each to a registrable placeholder; domains are opaque labels.
const registrable = value => value.replace(/\.example\b/g, '-dcv.com');
const mapped = value => JSON.parse(registrable(JSON.stringify(value)));

const OUTCOMES = { implicit: 'implicit', authorized: 'trust', seller_discretion: 'seller' };

function evaluator(records, now) {
  return new identity.TrustEvaluator({
    now: () => now,
    fetchOptions: {
      trustedFetchFn: async url => {
        const record = records[new URL(url).hostname];
        return new Response(record === undefined ? '' : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
}

test('the vendored vectors cover every outcome', () => {
  const outcomes = new Set(fixture.vectors.map(v => v.expected.outcome));
  assert.deepEqual([...outcomes].sort(), ['authorized', 'grant_absent', 'implicit', 'seller_discretion']);
});

for (const vector of fixture.vectors) {
  test(`delegation-chain vector ${vector.id}`, async () => {
    const input = mapped(vector.input);
    const now = Date.parse(input.check_time) / 1000;
    const records = { ...input.trust_records };
    // Every operator a chain reaches lists the signer, so binding is never the reason a vector fails.
    records[input.signer.operator] = {
      ...records[input.signer.operator],
      agents: [{ url: input.signer.origin, roles: ['adcp:buying'] }],
    };
    let sellerCalls = 0;
    const run = identity.authorizeDemandGrant(
      {
        signerOrigin: input.signer.origin,
        brand: input.brand,
        accountOperator: input.account_operator,
        scope: input.scope,
      },
      {
        evaluator: evaluator(records, now),
        now: () => now,
        resolveBrandHouse: async () =>
          input.parent_organization ? { domain: input.parent_organization, brand_id: input.brand.brand_id } : undefined,
        sellerAuthorization: async () => {
          sellerCalls++;
          return true;
        },
      }
    );
    if (vector.expected.outcome === 'grant_absent') {
      await assert.rejects(
        run,
        e => e instanceof identity.IdentityAuthorizationError && e.details?.reason === 'grant_absent'
      );
      assert.equal(sellerCalls, 0, 'an exclusive record never defers to the seller');
    } else {
      const result = await run;
      assert.equal(result.source, OUTCOMES[vector.expected.outcome], vector.description);
    }
  });
}
