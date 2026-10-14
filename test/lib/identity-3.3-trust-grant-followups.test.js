// Regression tests for trust record, grant and authorization-layer follow-ups to #3244 (refs #3233).
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');

const now = 1790841610;
const fixtures = path.join(__dirname, '../fixtures/wba-profile');
const keys = require('../fixtures/wba-profile/keys.json').keys;
const vector = name => JSON.parse(fs.readFileSync(path.join(fixtures, name + '.json')));

/** Serves records by full URL; a record may be an Error (transport failure) or a status number. */
function evaluator(records, clock = () => now) {
  const calls = [];
  const trust = new identity.TrustEvaluator({
    now: clock,
    fetchOptions: {
      trustedFetchFn: async url => {
        calls.push(url);
        const record = records[url] ?? records[new URL(url).hostname];
        if (record instanceof Error) throw record;
        if (typeof record === 'number') return new Response('', { status: record });
        return new Response(record === undefined ? '' : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
  return { trust, calls };
}
const agent = (origin, roles = ['adcp:buying']) => ({ agents: [{ url: origin, roles }] });

test('T1: authoritative_location hops to a victim host cannot exhaust the victim operator', async () => {
  const records = { 'https://victim.com/.well-known/trust.json': agent('https://buyer.victim.com') };
  for (let i = 0; i < 12; i++)
    records[`attacker${i}.com`] = { authoritative_location: 'https://victim.com/.well-known/missing.json' };
  const { trust } = evaluator(records);
  for (let i = 0; i < 12; i++) await assert.rejects(trust.get(`attacker${i}.com`));
  assert.equal((await trust.match('https://buyer.victim.com', 'adcp:buying')).operator, 'victim.com');
});

test('T2: operators sharing an authoritative host do not exhaust each other, and capacity is not cached', async () => {
  let clock = now;
  const records = {};
  for (let i = 0; i < 11; i++) {
    records[`op${i}.com`] = { authoritative_location: `https://host.com/op${i}.json` };
    records[`https://host.com/op${i}.json`] = agent(`https://agent.op${i}.com`);
  }
  const { trust } = evaluator(records, () => clock);
  for (let i = 0; i < 11; i++) assert.equal((await trust.get(`op${i}.com`)).status, 'present');
  // One operator past its own per-host rate gets a retryable outage, not a 60 s cached failure.
  const single = evaluator({ 'solo.com': agent('https://agent.solo.com') }, () => clock).trust;
  for (let i = 0; i < 10; i++) await single.get('solo.com', true);
  clock = now + 30;
  await assert.rejects(single.get('solo.com', true), e => e instanceof identity.TrustRecordUnavailableError);
  clock = now + 61; // the rate window has rolled over; a cached failure would last until now + 90
  assert.equal((await single.get('solo.com', true)).status, 'present');
});

test('T1/S1: transport failures are unavailability, never delisting', async () => {
  const { trust } = evaluator({ 'down.com': new Error('offline'), 'listed.com': agent('https://a.listed.com') });
  await assert.rejects(trust.get('down.com'), e => e instanceof identity.TrustRecordUnavailableError);
  await assert.rejects(
    trust.match('https://a.down.com', 'adcp:buying'),
    e => e instanceof identity.TrustRecordUnavailableError
  );
  await assert.rejects(
    trust.match('https://other.listed.com', 'adcp:buying'),
    e => e instanceof identity.TrustMembershipError
  );
});

test('S2/G5: a self-operated brand may grant the signer operator directly', async () => {
  const records = {
    'platform.com': agent('https://agent.platform.com'),
    'brand.com': { grants: [{ grantee: 'platform.com', scopes: ['adcp:media_buying'] }], exclusive_grants: true },
  };
  const claim = {
    signerOrigin: 'https://agent.platform.com',
    brand: { domain: 'brand.com' },
    accountOperator: 'brand.com',
    scope: 'adcp:media_buying',
  };
  const result = await identity.authorizeDemandGrant(claim, { evaluator: evaluator(records).trust, now: () => now });
  assert.equal(result.source, 'trust');
  assert.deepEqual(result.chain, ['brand.com', 'platform.com']);
  // The grant still narrows: a different scope or a grant to someone else is absent.
  await assert.rejects(
    identity.authorizeDemandGrant(
      { ...claim, scope: 'adcp:signals' },
      { evaluator: evaluator(records).trust, now: () => now }
    ),
    e => e.details?.reason === 'grant_absent'
  );
  records['brand.com'].grants = [{ grantee: 'elsewhere.com', scopes: ['adcp:media_buying'] }];
  await assert.rejects(
    identity.authorizeDemandGrant(claim, { evaluator: evaluator(records).trust, now: () => now }),
    e => e.code === 'PERMISSION_DENIED' && e.details?.scope === 'agent' && e.details?.reason === 'grant_absent'
  );
});

function vectorOptions(v) {
  const directory = new wba.SignatureDirectoryResolver({
    now: () => v.reference_now,
    allowTestKeys: true,
    fetchOptions: {
      trustedFetchFn: async url => {
        const origin = new URL(url).origin,
          refs = v.directories?.[origin]?.keys_ref;
        if (!refs) return new Response('', { status: 404 });
        const response = await wba.createSignedSignatureDirectory(
          origin,
          keys
            .filter(k => refs.includes(k.kid))
            .map(k => ({ privateKey: { kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, d: k._private_d_for_test_only } })),
          { now: () => v.reference_now }
        );
        return new Response(response.body, { status: 200, headers: response.headers });
      },
    },
  });
  return {
    now: () => v.reference_now,
    replayStore: new InMemoryReplayStore(),
    allowTestKeys: true,
    isRevoked: async () => false,
    directory,
  };
}

async function boundFixture() {
  const v = vector('positive/001-single-signer-request');
  const signers = await wba.verifyWebBotAuth(v.request, vectorOptions(v));
  const origin = signers[0].origin;
  const operator = new URL(origin).hostname;
  const records = { [operator]: agent(origin), 'brand.com': { grants: [], exclusive_grants: true } };
  let clock = now;
  const { trust } = evaluator(records, () => clock);
  const lifecycle = new identity.OriginIdentityLifecycle({
    store: new identity.InMemoryOriginIdentityStore(),
    trust,
    now: () => clock,
  });
  await lifecycle.bindPrincipal({ origin, principalId: 'principal-1', approvedBy: 'admin', reason: 'approved' });
  const resolve = identity.createIdentity33PrincipalResolver({ lifecycle });
  const authorize = identity.createIdentity33Authorization({
    lifecycle,
    grants: { evaluator: trust, now: () => clock },
    resolveClaims: async () => [
      { brand: { domain: 'brand.com' }, accountOperator: operator, scope: 'adcp:media_buying', billing: 'operator' },
    ],
  });
  const context = async operation => {
    const principal = await resolve(signers, operation);
    return {
      authInfo: {
        token: '',
        clientId: principal.principal,
        scopes: [],
        credential: principal.credential,
        extra: principal.extra,
      },
    };
  };
  return {
    origin,
    operator,
    records,
    trust,
    lifecycle,
    authorize,
    context,
    tick: seconds => (clock += seconds),
  };
}

test('S1: a delisted bound origin falls back to identity-established, not deny-everything', async () => {
  const f = await boundFixture();
  // Bound and listed: reads run under the bound principal.
  const listed = await f.context('get_products');
  await f.authorize(listed, 'get_products', { buying_mode: 'brief', brief: 'x' });
  assert.equal(listed.authInfo.clientId, 'principal-1');
  // Delist the origin.
  f.records[f.operator] = agent('https://someone-else.' + f.operator);
  f.trust.invalidate(f.operator);
  const read = await f.context('get_products');
  await f.authorize(read, 'get_products', { buying_mode: 'brief', brief: 'x' });
  assert.notEqual(read.authInfo.clientId, 'principal-1');
  assert.match(read.authInfo.clientId, /^anonymous:/);
  assert.equal(read.authInfo.credential, undefined);
  assert.equal(read.authInfo.extra.credential, undefined);
  assert.equal(identity.isIdentity33UnboundContext(read), true);
  await f.authorize(await f.context('get_principal'), 'get_principal', {});
  // Beyond the anonymous scope: the standard PERMISSION_DENIED envelope.
  await assert.rejects(
    f.authorize(await f.context('list_accounts'), 'list_accounts', {}),
    e => e.code === 'PERMISSION_DENIED'
  );
  await assert.rejects(
    f.authorize(await f.context('create_media_buy'), 'create_media_buy', {}),
    e => e.code === 'PERMISSION_DENIED'
  );
  // Open onboarding cannot re-bind it while unlisted, and no RFC 9421 downgrade.
  await assert.rejects(
    f.authorize(await f.context('sync_principal'), 'sync_principal', {}),
    e => e.code === 'PERMISSION_DENIED'
  );
  await assert.rejects(f.lifecycle.assertLegacyAllowed(f.origin));
  // get_principal reports no principal while delisted.
  const handlers = identity.withIdentity33PrincipalHandlers(
    { getPrincipal: async () => ({ result: { kind: 'recognized', principal_id: 'principal-1' } }) },
    f.lifecycle
  );
  const principalCtx = await f.context('get_principal');
  await f.authorize(principalCtx, 'get_principal', {});
  assert.deepEqual(await handlers.getPrincipal({}, principalCtx), { result: { kind: 'unconfigured' } });
});

test('S1/S3: an unreachable trust record fails spend with SERVICE_UNAVAILABLE and keeps reads bound', async () => {
  const f = await boundFixture();
  f.records[f.operator] = 503;
  f.trust.invalidate(f.operator);
  const read = await f.context('get_products');
  await f.authorize(read, 'get_products', { buying_mode: 'brief', brief: 'x' });
  assert.equal(read.authInfo.clientId, 'principal-1');
  await assert.rejects(
    f.authorize(await f.context('create_media_buy'), 'create_media_buy', {}),
    e => e.code === 'SERVICE_UNAVAILABLE' && e.recovery === 'transient'
  );
});

test('S3: a principal-resolution failure after verification is an AdCP error, never 403 with Accept-Signature', async () => {
  const { verifySignatureAsAuthenticator } = require('../../dist/lib/server/auth-signature');
  const v = vector('positive/001-single-signer-request');
  const opts = vectorOptions(v);
  for (const [thrown, code] of [
    [new Error('state store offline'), 'SERVICE_UNAVAILABLE'],
    [new identity.IdentityAuthorizationError(), 'PERMISSION_DENIED'],
  ]) {
    const authenticate = verifySignatureAsAuthenticator({
      capability: { supported: true, covers_content_digest: 'required', required_for: [], profiles: ['web-bot-auth'] },
      jwks: { resolve: async () => null },
      getUrl: () => v.request.url,
      now: opts.now,
      replayStore: new InMemoryReplayStore(),
      assertLegacyOriginAllowed: async () => {},
      resolveOperation: () => 'get_products',
      webBotAuth: {
        directory: opts.directory,
        isRevoked: opts.isRevoked,
        resolvePrincipal: async () => {
          throw thrown;
        },
      },
    });
    const principal = await authenticate({
      method: v.request.method,
      url: new URL(v.request.url).pathname,
      headers: Object.fromEntries(Object.entries(v.request.headers).map(([k, value]) => [k.toLowerCase(), value])),
      rawBody: v.request.body,
    });
    const failure = wba.getWebBotAuthAuthorizationFailure(principal.extra);
    assert.equal(failure.code, code);
    assert.match(principal.principal, /^anonymous:/);
  }
});

test('S3: the server maps a trust-record outage from the authorization hook to SERVICE_UNAVAILABLE', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
  let effects = 0;
  const server = createAdcpServer({
    name: 'Trust outage',
    version: '1.0.0',
    identity33: {
      authorize: async () => {
        throw new identity.TrustRecordUnavailableError();
      },
    },
    mediaBuy: {
      getProducts: async () => {
        effects++;
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  try {
    const response = await server.invoke({
      toolName: 'get_products',
      args: { adcp_version: '3.3', buying_mode: 'brief', brief: 'Fixture request' },
      authInfo: { token: '', clientId: 'p', scopes: [] },
    });
    const body = JSON.parse(response.content[0].text);
    assert.equal(body.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(body.adcp_error.recovery, 'transient');
    assert.equal(effects, 0);
  } finally {
    await server.close();
  }
});
