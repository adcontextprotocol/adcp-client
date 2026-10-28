// A trust.json grant's grantee is a registrable domain (adcontextprotocol/adcp#8169).
// A grant whose grantee is not one covers no claim, and its scopes still count
// for exclusive_grants. A public suffix (github.io) has no registrable domain,
// while a name under a PRIVATE-section suffix (alice.github.io) is one.
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
const grant = (grantee, fields = {}) => ({ grantee, scopes: ['adcp:media_buying'], ...fields });
const claim = {
  signerOrigin: 'https://buyer.agency.com',
  brand: { domain: 'brand.com', brand_id: 'brand', countries: ['US'] },
  accountOperator: 'agency.com',
  scope: 'adcp:media_buying',
};
const isGrantAbsent = error =>
  error instanceof identity.IdentityAuthorizationError && error.details?.reason === 'grant_absent';

/** Authorize `claim` against a brand record, counting seller-discretion calls. */
async function authorize(brandRecord, overrides = {}, extraRecords = {}) {
  let sellerCalls = 0;
  const records = { 'agency.com': agent(claim.signerOrigin), 'brand.com': brandRecord, ...extraRecords };
  const run = identity.authorizeDemandGrant(
    { ...claim, ...overrides },
    {
      evaluator: evaluator(records),
      now: () => now,
      sellerAuthorization: async () => {
        sellerCalls++;
        return true;
      },
    }
  );
  return { run, sellerCalls: () => sellerCalls };
}

test('a host grantee is not reduced to its registrable domain: the grant covers no claim', async () => {
  // Before #8169 the SDK reduced media.agency.com to agency.com, broadening a
  // grant for one host to every agent agency.com runs.
  const { run } = await authorize({ grants: [grant('media.agency.com')], exclusive_grants: true });
  await assert.rejects(run, isGrantAbsent);
});

test("a non-registrable grantee's scopes still count for exclusive_grants", async () => {
  // The record's only adcp:media_buying grant names a host. Ignoring it must not
  // stop the record from being exhaustive for that scope: the seller's
  // discretion is never consulted.
  const exclusive = await authorize({ grants: [grant('media.agency.com')], exclusive_grants: true });
  await assert.rejects(exclusive.run, isGrantAbsent);
  assert.equal(exclusive.sellerCalls(), 0);

  const publicSuffix = await authorize({ grants: [grant('github.io')], exclusive_grants: true });
  await assert.rejects(publicSuffix.run, isGrantAbsent);
  assert.equal(publicSuffix.sellerCalls(), 0);
});

test('without exclusive_grants, a claim only a non-registrable grant names stays at the seller discretion', async () => {
  // The grant covers no claim, so it is not published narrowing either.
  const { run, sellerCalls } = await authorize({ grants: [grant('media.agency.com')] });
  assert.equal((await run).source, 'seller');
  assert.equal(sellerCalls(), 1);
});

test('a public-suffix grantee covers no claim and never breaks evaluation of the record', async () => {
  // github.io is a PRIVATE-section public suffix: it has no registrable domain.
  // Evaluating it used to throw EtldComputationError out of authorizeDemandGrant.
  const signer = 'https://buyer.alice.github.io';
  const records = { 'alice.github.io': agent(signer) };
  const suffixOnly = await authorize(
    { grants: [grant('github.io')], exclusive_grants: true },
    { signerOrigin: signer, accountOperator: 'alice.github.io' },
    records
  );
  await assert.rejects(suffixOnly.run, isGrantAbsent);

  // The same record with a valid grant beside the bad one still authorizes.
  const mixed = await authorize(
    { grants: [grant('github.io'), grant('media.agency.com'), grant('alice.github.io')], exclusive_grants: true },
    { signerOrigin: signer, accountOperator: 'alice.github.io' },
    records
  );
  const result = await mixed.run;
  assert.equal(result.source, 'trust');
  assert.deepEqual(result.chain, ['brand.com', 'alice.github.io']);
});

test('a grantee under a PRIVATE-section suffix is registrable and reaches only that tenant', async () => {
  const alice = 'https://buyer.alice.github.io';
  const bob = 'https://buyer.bob.github.io';
  const records = { 'alice.github.io': agent(alice), 'bob.github.io': agent(bob) };
  const brand = { grants: [grant('alice.github.io')], exclusive_grants: true };
  const ok = await authorize(brand, { signerOrigin: alice, accountOperator: 'alice.github.io' }, records);
  assert.equal((await ok.run).source, 'trust');
  const other = await authorize(brand, { signerOrigin: bob, accountOperator: 'bob.github.io' }, records);
  await assert.rejects(other.run, isGrantAbsent);
});

test('the second link of a chain ignores a non-registrable grantee too', async () => {
  // brand.com -> agency.com (valid) -> media.platform.com (host): the second
  // link must name the signer's operator, platform.com, exactly.
  const signer = 'https://buyer.platform.com';
  const { run } = await authorize(
    { grants: [grant('agency.com')], exclusive_grants: true },
    { signerOrigin: signer },
    {
      'platform.com': agent(signer),
      'agency.com': { ...agent(claim.signerOrigin), grants: [grant('media.platform.com')] },
    }
  );
  await assert.rejects(run, isGrantAbsent);

  const valid = await authorize(
    { grants: [grant('agency.com')], exclusive_grants: true },
    { signerOrigin: signer },
    { 'platform.com': agent(signer), 'agency.com': { ...agent(claim.signerOrigin), grants: [grant('platform.com')] } }
  );
  assert.deepEqual((await valid.run).chain, ['brand.com', 'agency.com', 'platform.com']);
});

test('a self-operated brand cannot reach the signer operator through a host grantee', async () => {
  const signer = 'https://buyer.platform.com';
  const records = { 'platform.com': agent(signer) };
  const host = await authorize(
    { grants: [grant('agents.platform.com')], exclusive_grants: true },
    { signerOrigin: signer, accountOperator: 'brand.com' },
    records
  );
  await assert.rejects(host.run, isGrantAbsent);
  const exact = await authorize(
    { grants: [grant('platform.com')], exclusive_grants: true },
    { signerOrigin: signer, accountOperator: 'brand.com' },
    records
  );
  assert.equal((await exact.run).source, 'trust');
});

test('trust.json authoring refuses a grantee that is not a registrable domain', () => {
  for (const grantee of ['media.agency.com', 'github.io', 'co.uk', 't1.vendor.co.uk'])
    assert.throws(
      () => identity.createTrustRecord({ grants: [grant(grantee)], exclusive_grants: true }),
      error => error instanceof TypeError && error.message.includes(grantee),
      grantee
    );
  // A single label already fails the schema's domain pattern.
  assert.throws(() => identity.createTrustRecord({ grants: [grant('com')] }));
  for (const grantee of ['agency.com', 'alice.github.io', 'vendor.co.uk'])
    assert.equal(identity.createTrustRecord({ grants: [grant(grantee)] }).grants[0].grantee, grantee);
});

test('a fetched record with a non-registrable grantee is still a valid record', async () => {
  // The rule is per grant, so reading the record must not fail: its other
  // grants and agents[] still apply.
  const result = await evaluator({
    'brand.com': { grants: [grant('media.agency.com'), grant('agency.com')] },
  }).get('brand.com');
  assert.equal(result.status, 'present');
  assert.equal(result.record.grants.length, 2);
});

test('adcp identity trust-validate applies the publication rules, not only the schema', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { handleIdentityCommand } = require('../../bin/adcp-identity.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-trust-'));
  const file = path.join(dir, 'trust.json');
  const write = process.stdout.write;
  try {
    fs.writeFileSync(file, JSON.stringify({ grants: [grant('media.agency.com')], exclusive_grants: true }));
    await assert.rejects(handleIdentityCommand(['trust-validate', file]), /not a registrable domain/);
    fs.writeFileSync(file, JSON.stringify({ grants: [grant('agency.com')] }));
    let out = '';
    process.stdout.write = chunk => ((out += chunk), true);
    await handleIdentityCommand(['trust-validate', file]);
    process.stdout.write = write;
    assert.match(out, /Valid/);
  } finally {
    process.stdout.write = write;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a grant whose agents[] URL does not parse lists no agent and never breaks the other grants', async () => {
  const bad = 'https://agency.com:99999/';
  // Authoring refuses it.
  assert.throws(
    () => identity.createTrustRecord({ grants: [grant('agency.com', { agents: [{ url: bad }] })] }),
    error => error instanceof TypeError && error.message.includes(bad)
  );
  // A fetched record carrying it still authorizes through the valid grant, in either order.
  for (const grants of [
    [grant('agency.com', { agents: [{ url: bad }] }), grant('agency.com')],
    [grant('agency.com'), grant('agency.com', { agents: [{ url: bad }] })],
  ]) {
    const { run } = await authorize({ grants, exclusive_grants: true });
    assert.equal((await run).source, 'trust');
  }
  // Alone, it covers the signer with nothing.
  const alone = await authorize({ grants: [grant('agency.com', { agents: [{ url: bad }] })], exclusive_grants: true });
  await assert.rejects(alone.run, isGrantAbsent);
});

test('a grantee must equal its registrable domain exactly, even in a record that skipped schema validation', async () => {
  // A duck-typed evaluator returning unvalidated grants: spellings that only
  // match after URL parsing are not the registrable domain.
  for (const grantee of ['AGENCY.COM', 'agency.com:443', 'evil.com@agency.com', '%61gency.com']) {
    const real = evaluator({ 'agency.com': agent(claim.signerOrigin) });
    const fake = {
      match: (...args) => real.match(...args),
      get: async domain =>
        domain === 'brand.com'
          ? { status: 'present', operator: 'brand.com', record: { grants: [grant(grantee)], exclusive_grants: true } }
          : real.get(domain),
    };
    await assert.rejects(
      identity.authorizeDemandGrant(claim, { evaluator: fake, now: () => now }),
      isGrantAbsent,
      grantee
    );
  }
});

for (const domain of ['brand.example', 'localhost', '127.0.0.1', 'github.io']) {
  for (const field of ['brand', 'accountOperator', 'house']) {
    test(`invalid ${field} domain ${domain} is a coded refusal without fallback`, async () => {
      let fallbackCalls = 0;
      const options = {
        evaluator: evaluator({ 'agency.com': agent(claim.signerOrigin) }),
        now: () => now,
        resolveBrandHouse: async () => (field === 'house' ? { domain, brand_id: 'house' } : undefined),
        legacyAuthorization: async () => {
          fallbackCalls++;
          return true;
        },
        sellerAuthorization: async () => {
          fallbackCalls++;
          return true;
        },
      };
      await assert.rejects(
        identity.authorizeDemandGrant(
          {
            ...claim,
            ...(field === 'brand' && { brand: { ...claim.brand, domain } }),
            ...(field === 'accountOperator' && { accountOperator: domain }),
          },
          options
        ),
        error => error instanceof identity.IdentityAuthorizationError && error.code === 'PERMISSION_DENIED'
      );
      assert.equal(fallbackCalls, 0);
    });
  }
}
