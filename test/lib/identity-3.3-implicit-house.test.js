// Implicit grant authority extends to the brand's house (adcp L2 §Grants in
// trust records, adcp#8169): when account.operator and the signer's operator
// share a registrable domain with the brand's domain or its house's, no grant
// is needed.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../../dist/lib/identity-3.3');

const now = 1790841610;

/** Serves records by host or full URL; an Error is a transport failure, undefined a 404. */
function evaluator(records) {
  const calls = [];
  const trust = new identity.TrustEvaluator({
    now: () => now,
    fetchOptions: {
      trustedFetchFn: async url => {
        calls.push(url);
        const record = records[url] ?? records[new URL(url).hostname];
        if (record instanceof Error) throw record;
        return new Response(record === undefined ? '' : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
  return { trust, calls };
}
const agent = (origin, grants = []) => ({ agents: [{ url: origin, roles: ['adcp:buying'] }], grants });

// brand.json documents for a seller's resolver: a leaf names its house with
// house_domain; the resolver returns the house only when the house's
// brand_refs[] lists the leaf back. The SDK relies on the resolver for this:
// these tests pin what the SDK does with the house it returns, or with none.
const brandJson = {
  'novamotors.com': { house_domain: 'house.com' },
  'orphan.com': { house_domain: 'house.com' },
  'house.com': { brand_refs: [{ domain: 'novamotors.com', brand_id: 'nova_motors' }] },
};
async function mutualAssertionHouse(brand) {
  const house = brandJson[brand.domain]?.house_domain;
  if (!house) return undefined;
  const ref = (brandJson[house]?.brand_refs ?? []).find(r => r.domain === brand.domain);
  // Leaf-only: the house does not list the brand back, so the brand is its own house.
  return ref ? { domain: house, brand_id: ref.brand_id } : undefined;
}

const HOUSE_AGENT = 'https://buyer.house.com';
const AGENCY_AGENT = 'https://buyer.agency.com';
const records = (houseGrants = []) => ({
  'house.com': agent(HOUSE_AGENT, houseGrants),
  'agency.com': agent(AGENCY_AGENT),
  'novamotors.com': { grants: [] },
  'orphan.com': { grants: [] },
});
const claim = (signerOrigin, domain, accountOperator) => ({
  signerOrigin,
  brand: { domain },
  accountOperator,
  scope: 'adcp:media_buying',
});
const isGrantAbsent = e => e instanceof identity.IdentityAuthorizationError && e.details?.reason === 'grant_absent';

test('a house operating its own child brand needs no grant', async () => {
  const { trust, calls } = evaluator(records());
  const result = await identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'house.com'), {
    evaluator: trust,
    now: () => now,
    resolveBrandHouse: mutualAssertionHouse,
  });
  assert.equal(result.source, 'implicit');
  assert.deepEqual(result.chain, ['novamotors.com', 'house.com']);
  // Only the house's record (also the signer's) is read.
  assert.ok(calls.every(url => new URL(url).hostname === 'house.com'));
});

test('with no house resolved (the house does not list the brand back), the brand is its own house', async () => {
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'orphan.com', 'house.com'), {
      evaluator: evaluator(records()).trust,
      now: () => now,
      resolveBrandHouse: mutualAssertionHouse,
    }),
    isGrantAbsent
  );
  // The brand is its own house, so its own record can grant the claimed house.
  const granted = { ...records(), 'orphan.com': { grants: [{ grantee: 'house.com', scopes: ['adcp:media_buying'] }] } };
  const result = await identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'orphan.com', 'house.com'), {
    evaluator: evaluator(granted).trust,
    now: () => now,
    resolveBrandHouse: mutualAssertionHouse,
  });
  assert.equal(result.source, 'trust');
});

test('an operator outside the brand and its house still needs a grant', async () => {
  const opts = { evaluator: evaluator(records()).trust, now: () => now, resolveBrandHouse: mutualAssertionHouse };
  await assert.rejects(
    identity.authorizeDemandGrant(claim(AGENCY_AGENT, 'novamotors.com', 'agency.com'), opts),
    isGrantAbsent
  );
  // The house's own agent under another organization's account is not implicit.
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'agency.com'), opts),
    isGrantAbsent
  );
  const result = await identity.authorizeDemandGrant(claim(AGENCY_AGENT, 'novamotors.com', 'agency.com'), {
    ...opts,
    evaluator: evaluator(records([{ grantee: 'agency.com', scopes: ['adcp:media_buying'] }])).trust,
  });
  assert.equal(result.source, 'trust');
});

test('the house agent under a self-operated child brand account is not implicit', async () => {
  // account.operator is the brand, not the signer's operator: a grant is needed.
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'novamotors.com'), {
      evaluator: evaluator(records()).trust,
      now: () => now,
      resolveBrandHouse: mutualAssertionHouse,
    }),
    isGrantAbsent
  );
});

test('a house resolution failure is an outage, never grant_absent', async () => {
  let seller = 0;
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'house.com'), {
      evaluator: evaluator(records()).trust,
      now: () => now,
      resolveBrandHouse: async () => {
        throw new Error('brand.json unreachable');
      },
      sellerAuthorization: async () => {
        seller++;
        return true;
      },
    }),
    e => e instanceof identity.TrustRecordUnavailableError && e.details === undefined
  );
  assert.equal(seller, 0);
  // A coded error from the resolver keeps its code.
  const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome');
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'house.com'), {
      evaluator: evaluator(records()).trust,
      now: () => now,
      resolveBrandHouse: async () => {
        throw new AdcpError('RATE_LIMITED', { message: 'slow down' });
      },
    }),
    e => e instanceof AdcpError && e.code === 'RATE_LIMITED'
  );
  await assert.rejects(
    identity.authorizeDemandGrant(claim(HOUSE_AGENT, 'novamotors.com', 'house.com'), {
      evaluator: evaluator(records()).trust,
      now: () => now,
      resolveBrandHouse: async () => {
        throw new identity.IdentityAuthorizationError('grant_absent');
      },
    }),
    e => isGrantAbsent(e) && !(e instanceof identity.TrustRecordUnavailableError)
  );
});

// Records are keyed by the registrable domain they are fetched at; when the
// signer's operator is the house, its record is the house's record.
for (const [name, signer, account, house, recs, implicit] of [
  // Hosts reduce to their registrable domain on every side.
  [
    'subdomains',
    'https://buyer.house.com',
    'ads.house.com',
    'www.house.com',
    { 'house.com': agent('https://buyer.house.com') },
    true,
  ],
  [
    'multi-label suffix',
    'https://agent.buy.house.co.uk',
    'house.co.uk',
    'brands.house.co.uk',
    { 'house.co.uk': agent('https://agent.buy.house.co.uk') },
    true,
  ],
  // PSL PRIVATE section: two github.io tenants are different operators.
  [
    'private suffix',
    'https://alice.github.io',
    'alice.github.io',
    'bob.github.io',
    { 'alice.github.io': agent('https://alice.github.io'), 'bob.github.io': { grants: [] } },
    false,
  ],
]) {
  test(`implicit house authority compares registrable domains (${name})`, async () => {
    const run = identity.authorizeDemandGrant(claim(signer, 'novamotors.com', account), {
      evaluator: evaluator(recs).trust,
      now: () => now,
      resolveBrandHouse: async () => ({ domain: house, brand_id: 'nova_motors' }),
    });
    if (implicit) assert.equal((await run).source, 'implicit');
    else await assert.rejects(run, isGrantAbsent);
  });
}
