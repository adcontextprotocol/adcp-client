// exclusive_grants makes grants[] exhaustive only for the scopes it names
// (adcontextprotocol/adcp L2 "Grants in trust records": Absence). A scope no
// grant names stays at the seller's discretion, as does every scope of an
// exclusive record that publishes no grants.
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

test('an exclusive record leaves a scope no grant names at the seller discretion', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('other-agency.com', ['adcp:governance'])],
    exclusive_grants: true,
  });
  assert.equal((await run).source, 'seller');
  assert.equal(sellerCalls(), 1);
});

test('an exclusive record refuses an uncovered claim in a scope a grant names', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('other-agency.com', ['adcp:governance', 'adcp:media_buying'])],
    exclusive_grants: true,
  });
  await assert.rejects(run, isGrantAbsent);
  assert.equal(sellerCalls(), 0);
});

test('adcp:all and * name every scope they cover for exclusivity', async () => {
  for (const scopes of [['adcp:all'], ['*']]) {
    const { run, sellerCalls } = authorize({ grants: [grant('other-agency.com', scopes)], exclusive_grants: true });
    await assert.rejects(run, isGrantAbsent, `scopes ${scopes}`);
    assert.equal(sellerCalls(), 0);
  }
});

test('a non-registrable grantee still names its scopes for exclusivity', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('github.io', ['adcp:media_buying'])],
    exclusive_grants: true,
  });
  await assert.rejects(run, isGrantAbsent);
  assert.equal(sellerCalls(), 0);
});

test('an exclusive record with no grants names no scope', async () => {
  const { run, sellerCalls } = authorize({ grants: [], exclusive_grants: true });
  assert.equal((await run).source, 'seller');
  assert.equal(sellerCalls(), 1);
});

test('a matching grant in an exclusive scope still authorizes', async () => {
  const { run, sellerCalls } = authorize({
    grants: [grant('agency.com', ['adcp:media_buying'])],
    exclusive_grants: true,
  });
  assert.equal((await run).source, 'trust');
  assert.equal(sellerCalls(), 0);
});
