// exclusive_grants on the house's record makes grants[] the complete list,
// whatever the scope (adcontextprotocol/adcp L2 "Grants in trust records":
// Absence). Without it, an uncovered claim is at the seller's discretion, and
// a grant that does not cover the claim never narrows that discretion.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../../dist/lib/identity-3.3');

const now = 1790841610;

function evaluator(records) {
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
const agent = origin => ({ agents: [{ url: origin, roles: ['adcp:buying'] }] });
const grant = (grantee, scopes) => ({ grantee, scopes });
const claim = {
  signerOrigin: 'https://buyer.agency.com',
  brand: { domain: 'brand.com', brand_id: 'brand', countries: ['US'] },
  accountOperator: 'agency.com',
  scope: 'adcp:media_buying',
};
const isGrantAbsent = error =>
  error instanceof identity.IdentityAuthorizationError && error.details?.reason === 'grant_absent';

/** Authorize `claim` against a brand record, counting seller-discretion calls. */
function authorize(brandRecord) {
  let sellerCalls = 0;
  const run = identity.authorizeDemandGrant(claim, {
    evaluator: evaluator({ 'agency.com': agent(claim.signerOrigin), 'brand.com': brandRecord }),
    now: () => now,
    sellerAuthorization: async () => {
      sellerCalls++;
      return true;
    },
  });
  return { run, sellerCalls: () => sellerCalls };
}

test('an exclusive record refuses an uncovered claim in a scope no grant names', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('other-agency.com', ['adcp:governance'])],
    exclusive_grants: true,
  });
  await assert.rejects(run, isGrantAbsent);
  assert.equal(sellerCalls(), 0);
});

test('an exclusive record refuses an uncovered claim in a scope a grant names', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('other-agency.com', ['adcp:media_buying'])],
    exclusive_grants: true,
  });
  await assert.rejects(run, isGrantAbsent);
  assert.equal(sellerCalls(), 0);
});

test('an exclusive record with no grants authorizes no one', async () => {
  const { run, sellerCalls } = authorize({ grants: [], exclusive_grants: true });
  await assert.rejects(run, isGrantAbsent);
  assert.equal(sellerCalls(), 0);
});

test('a nonexclusive record leaves an uncovered claim to the seller, even beside a near-miss grant', async () => {
  for (const grants of [
    [],
    [grant('other-agency.com', ['adcp:media_buying'])],
    [grant('agency.com', ['adcp:governance'])],
  ]) {
    const { run, sellerCalls } = authorize({ grants });
    assert.equal((await run).source, 'seller');
    assert.equal(sellerCalls(), 1);
  }
});

test('a matching grant authorizes under an exclusive record', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('agency.com', ['adcp:media_buying'])],
    exclusive_grants: true,
  });
  assert.equal((await run).source, 'trust');
  assert.equal(sellerCalls(), 0);
});
