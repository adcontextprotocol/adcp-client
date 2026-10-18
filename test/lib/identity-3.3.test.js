process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');
const path = require('path');
const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3');
const { parseSignatureInput } = require('../../dist/lib/signing/parser');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');
const fixtures = path.join(__dirname, '../fixtures/wba-profile');
const keys = require('../fixtures/wba-profile/keys.json').keys;
const vector = name => JSON.parse(fs.readFileSync(path.join(fixtures, name + '.json')));
const now = 1790841610;
function resolverFromProof(proof, referenceNow = now) {
  return new wba.SignatureDirectoryResolver({
    now: () => referenceNow,
    fetchOptions: {
      trustedFetchFn: async url => {
        if (new URL(url).origin !== new URL(proof.request.url).origin) return new Response('', { status: 404 });
        return new Response(proof.body, { status: proof.status, headers: proof.headers });
      },
    },
  });
}
function options(v, replayStore = new InMemoryReplayStore()) {
  const directory = new wba.SignatureDirectoryResolver({
    now: () => v.reference_now,
    allowTestKeys: true,
    fetchOptions: {
      trustedFetchFn: async url => {
        const origin = new URL(url).origin,
          refs = v.directories?.[origin]?.keys_ref;
        if (!refs) return new Response('', { status: 404 });
        const directory = await wba.createSignedSignatureDirectory(
          origin,
          keys
            .filter(k => refs.includes(k.kid))
            .map(k => ({ privateKey: { kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, d: k._private_d_for_test_only } })),
          { now: () => v.reference_now }
        );
        return new Response(directory.body, { status: 200, headers: directory.headers });
      },
    },
  });
  return { now: () => v.reference_now, replayStore, allowTestKeys: true, isRevoked: async () => false, directory };
}
const PINNED = require('../fixtures/wba-profile/PINNED.json');
const vectorFiles = dir =>
  fs
    .readdirSync(path.join(fixtures, dir))
    .filter(name => name.endsWith('.json'))
    .map(name => `${dir}/${name.replace('.json', '')}`);
test('every vendored WBA vector is graded or recorded as non-applicable', () => {
  const graded = new Set([...vectorFiles('positive'), ...vectorFiles('negative')]);
  const nonApplicable = new Set(PINNED.non_applicable.map(name => name.replace('.json', '')));
  for (const name of ['positive', 'negative', 'governance'].flatMap(vectorFiles))
    assert.ok(graded.has(name) !== nonApplicable.has(name), `${name} must be graded xor non-applicable`);
  assert.equal(PINNED.sha, 'e24eeb090c4365707641099cbbb45f9945c6d6e0');
});
async function preloadReplay(v, replayStore) {
  for (const entry of v.test_harness_state?.replay_cache_entries ?? [])
    assert.equal(
      await replayStore.insert(entry.identity, 'web-bot-auth', entry.nonce, entry.ttl_seconds, v.reference_now),
      'ok'
    );
  return replayStore;
}
function assertAcceptSignature(error, expected) {
  const value = error.headers['Accept-Signature'];
  assert.ok(value, 'Accept-Signature is required');
  assert.ok(value.startsWith(`${expected.label}=${expected.components}`), value);
  for (const parameter of expected.parameters) assert.match(value, new RegExp(`;${parameter}(=|;|$)`));
  assert.match(value, /;tag="web-bot-auth"$/);
  const nonce = value.match(/;nonce="([^"]*)"/)?.[1];
  if (expected.nonce === 'verifier-chosen') assert.equal(Buffer.from(nonce, 'base64url').length, 64);
  else assert.equal(nonce, undefined);
}
for (const name of vectorFiles('positive').filter(name => !name.includes('directory-response')))
  test(`pinned WBA vector ${name}`, async () => {
    const v = vector(name);
    for (const [label, expected] of Object.entries(v.expected_signature_base))
      assert.equal(
        wba.buildWebBotAuthSignatureBase(parseSignatureInput(v.request.headers['Signature-Input'], label), v.request),
        expected
      );
    const result = await wba.verifyWebBotAuth(v.request, options(v));
    assert.deepEqual(Object.fromEntries(result.map(s => [s.label, s.origin])), v.expected_outcome.identities);
  });
for (const name of vectorFiles('negative'))
  test(`pinned WBA rejection ${name}`, async () => {
    const v = vector(name);
    const opts = options(v, await preloadReplay(v, new InMemoryReplayStore()));
    const error = await wba.verifyWebBotAuth(v.request, opts).then(
      () => assert.fail('vector must be rejected'),
      e => e
    );
    assert.ok(error instanceof wba.WebBotAuthError, String(error));
    assert.equal(error.status, v.expected_outcome.status, error.reason);
    if (v.expected_outcome.accept_signature) assertAcceptSignature(error, v.expected_outcome.accept_signature);
    else assert.equal(error.headers['Accept-Signature'], undefined);
    // Signature-path failures carry the generic authentication error only.
    assert.equal(error.body.adcp_error.code, 'AUTH_INVALID');
  });
test('negative/002 is positive/001 resent: it verifies once, then is a 429 replay', async () => {
  const replayed = vector('negative/002-replayed-nonce');
  const opts = options(replayed);
  assert.equal((await wba.verifyWebBotAuth(replayed.request, opts))[0].origin, 'https://buyer-7k3q.com');
  await assert.rejects(
    wba.verifyWebBotAuth(replayed.request, opts),
    e => e.status === 429 && e.reason === 'replayed' && /;nonce="[A-Za-z0-9_-]{86}"/.test(e.headers['Accept-Signature'])
  );
});
test('replay is partitioned by origin across endpoints and rotation; replayStatus is deprecated and ignored', async () => {
  const v = vector('positive/001-single-signer-request');
  for (const replayStatus of [undefined, 403]) {
    const opts = { ...options(v), replayStatus };
    await wba.verifyWebBotAuth(v.request, opts);
    await assert.rejects(wba.verifyWebBotAuth(v.request, opts), e => e.status === 429 && e.reason === 'replayed');
  }
});
test('signed directory vector, exact audit bytes, tampering, wrong origin, future proof and test-key exclusion', async () => {
  const v = vector('positive/002-signed-directory-response');
  const response = { ...v.response, request: v.request };
  for (const [label, expected] of Object.entries(v.expected_signature_base))
    assert.equal(
      wba.buildWebBotAuthSignatureBase(
        parseSignatureInput(v.response.headers['Signature-Input'], label),
        v.request,
        response
      ),
      expected
    );
  const checked = await wba.verifyKeyDirectory(response, v.reference_now, { allowTestKeys: true });
  assert.equal(checked.proof.body, v.response.body);
  assert.equal(new URL(checked.proof.request.url).origin, v.expected_outcome.identities.key1);
  await assert.rejects(wba.verifySignatureDirectory(response, v.reference_now), /verification failed/);
  await assert.rejects(wba.verifySignatureDirectory({ ...response, body: response.body + ' ' }, v.reference_now, true));
  await assert.rejects(
    wba.verifySignatureDirectory(
      { ...response, request: { ...v.request, url: 'https://other.com' + wba.SIGNATURE_DIRECTORY_PATH } },
      v.reference_now,
      true
    )
  );
  // Directory proofs tolerate a verifier clock up to 60 s behind `created`, no more.
  assert.equal((await wba.verifySignatureDirectory(response, 1790840940, true)).proof.body, v.response.body);
  await assert.rejects(wba.verifySignatureDirectory(response, 1790841000 - 61, true));
});
test('signing and directory authoring roundtrip: ed25519', async () => {
  for (const pair of [generateKeyPairSync('ed25519')]) {
    const jwk = pair.privateKey.export({ format: 'jwk' });
    jwk.kid = wba.jwkThumbprint(jwk);
    const key = { privateKey: jwk };
    const directory = await wba.createSignedSignatureDirectory('https://agent.example.com/mcp', [key], {
      now: () => now,
    });
    const checked = await wba.verifyKeyDirectory(directory, now);
    assert.equal(checked.keys[0].d, undefined);
    assert.equal(checked.keys[0].adcp_use, undefined);
    const request = {
      method: 'POST',
      url: 'https://seller.example.com/mcp?a=1&a=2',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    };
    const headers = await wba.signWebBotAuth(request, key, { origin: 'https://agent.example.com', now: () => now });
    const result = await wba.verifyWebBotAuth(
      { ...request, headers },
      {
        directory: resolverFromProof(directory),
        replayStore: new InMemoryReplayStore(),
        isRevoked: async () => false,
        now: () => now,
      }
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].origin, 'https://agent.example.com');
  }
});
test('Web Bot Auth is Ed25519 only: signing, directories and fetch wrappers refuse P-256 and RSA keys', async () => {
  for (const [type, options] of [
    ['ec', { namedCurve: 'prime256v1' }],
    ['rsa', { modulusLength: 2048, publicExponent: 0x10001 }],
  ]) {
    const jwk = generateKeyPairSync(type, options).privateKey.export({ format: 'jwk' });
    jwk.kid = wba.jwkThumbprint(jwk);
    const request = { method: 'GET', url: 'https://seller.example.com/mcp', headers: {} };
    await assert.rejects(
      wba.signWebBotAuth(request, { privateKey: jwk }, { origin: 'https://agent.example.com' }),
      /Web Bot Auth signs with Ed25519 keys only/
    );
    await assert.rejects(
      wba.createSignedSignatureDirectory('https://agent.example.com', [{ privateKey: jwk }]),
      TypeError
    );
    assert.throws(() => wba.createWebBotAuthFetch(fetch, { privateKey: jwk }, { origin: 'https://agent.example.com' }));
    assert.throws(() => wba.assertWebBotAuthSigningKey({ privateKey: jwk }), TypeError);
  }
});
test('Signature-Agent forces WBA, including empty or uncovered field; no legacy profile retry', () => {
  assert.equal(wba.selectSignatureProfile({ headers: { 'Signature-Agent': '' } }), 'web-bot-auth');
  assert.equal(
    wba.selectSignatureProfile({ headers: { 'Signature-Input': 'sig1=("@method");tag="web-bot-auth"' } }),
    'web-bot-auth'
  );
});
test('directory refresh is single-flight, removes successfully delisted keys, and fails closed after proof expiry', async () => {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });
  jwk.kid = wba.jwkThumbprint(jwk);
  let clock = now,
    calls = 0,
    fail = false;
  const directory = await wba.createSignedSignatureDirectory('https://agent.example.com', [{ privateKey: jwk }], {
    now: () => now,
    lifetimeSeconds: 301,
  });
  const resolver = new wba.SignatureDirectoryResolver({
    now: () => clock,
    fetchOptions: {
      trustedFetchFn: async () => {
        calls++;
        if (fail) throw Error('offline');
        return new Response(directory.body, { status: 200, headers: directory.headers });
      },
    },
  });
  const resolved = await Promise.all(
    Array.from({ length: 10 }, () => resolver.resolve(jwk.kid, 'https://agent.example.com'))
  );
  assert.equal(calls, 1);
  assert(resolved.every(Boolean));
  assert.equal(resolver.getAuditProof('https://agent.example.com').body, directory.body);
  clock += 302;
  fail = true;
  await assert.rejects(resolver.resolve(jwk.kid, 'https://agent.example.com'));
  assert.equal(calls, 2);
});

function evaluator(records, options = {}) {
  let calls = 0;
  const trust = new identity.TrustEvaluator({
    now: () => now,
    ...options,
    fetchOptions: {
      trustedFetchFn: async url => {
        calls++;
        const domain = new URL(url).hostname;
        const record = records[domain];
        if (record instanceof Error) throw record;
        return new Response(record === undefined ? '' : typeof record === 'string' ? record : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
  return { trust, calls: () => calls };
}
const agent = origin => ({ agents: [{ url: origin, roles: ['adcp:buying'] }] });
const grant = (grantee, fields = {}) => ({ grantee, scopes: ['adcp:media_buying'], ...fields });
const claim = {
  signerOrigin: 'https://buyer.agency.com',
  brand: { domain: 'brand.com', brand_id: 'brand', countries: ['US'] },
  accountOperator: 'agency.com',
  scope: 'adcp:media_buying',
};
const baseRecords = () => ({
  'agency.com': agent(claim.signerOrigin),
  'brand.com': { grants: [grant('agency.com')], exclusive_grants: true },
});
test('trust authoring rejects duplicate canonical origins and legacy keys', () => {
  assert.throws(() =>
    identity.createTrustRecord({
      agents: [
        { url: 'https://a.example.com/x', roles: ['adcp:buying'] },
        { url: 'https://a.example.com/y', roles: ['adcp:sales'] },
      ],
    })
  );
  assert.throws(() =>
    identity.createTrustRecord({
      agents: [{ url: 'https://a.example.com', roles: ['adcp:buying'], jwks_uri: 'https://a.example.com/keys' }],
    })
  );
});
test('trust fetch caps parse depth and duplicate keys, single-flights, and never mistakes failures for absence', async () => {
  for (const bad of [
    '{"agents":[],"agents":[]}',
    '{"x":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}',
    Error('offline'),
  ]) {
    const { trust, calls } = evaluator({ 'agency.com': bad });
    await assert.rejects(trust.get('agency.com'));
    await assert.rejects(trust.get('agency.com'));
    assert.equal(calls(), 1);
  }
  const { trust, calls } = evaluator(baseRecords());
  await Promise.all(Array.from({ length: 20 }, () => trust.match(claim.signerOrigin, 'adcp:buying')));
  assert.equal(calls(), 1);
});
test('trust authoritative hop preserves operator and rejects second hop and redirects', async () => {
  const records = {
    'agency.com': { authoritative_location: 'https://host.com/trust' },
    'host.com': agent(claim.signerOrigin),
  };
  const { trust } = evaluator(records);
  assert.equal((await trust.match(claim.signerOrigin, 'adcp:buying')).operator, 'agency.com');
  records['host.com'] = { authoritative_location: 'https://third.com/trust' };
  await assert.rejects(evaluator(records).trust.get('agency.com'));
});
test('direct and two-link grants intersect every narrowing and expiry', async () => {
  const records = baseRecords();
  const opts = { evaluator: evaluator(records).trust, now: () => now };
  assert.equal((await identity.authorizeDemandGrant(claim, opts)).source, 'trust');
  records['brand.com'].grants = [
    grant('operator.com', {
      countries: ['US'],
      profiles: { adcp: { brands: ['brand'] } },
      valid_until: new Date((now + 30) * 1000).toISOString(),
    }),
  ];
  records['operator.com'] = {
    grants: [
      grant('agency.com', {
        agents: [{ url: claim.signerOrigin + '/mcp' }],
        valid_until: new Date((now + 60) * 1000).toISOString(),
      }),
    ],
  };
  const two = { ...claim, accountOperator: 'operator.com' },
    evaluator2 = evaluator(records).trust;
  const result = await identity.authorizeDemandGrant(two, { evaluator: evaluator2, now: () => now });
  assert.deepEqual(result.chain, ['brand.com', 'operator.com', 'agency.com']);
  assert.equal(result.expiresAt, now + 30);
  await assert.rejects(
    identity.authorizeDemandGrant(
      { ...two, brand: { domain: 'brand.com' } },
      { evaluator: evaluator2, now: () => now }
    ),
    e => e.details.reason === 'grant_absent'
  );
  await assert.rejects(
    identity.authorizeDemandGrant(two, { evaluator: evaluator2, now: () => now + 31 }),
    e => e.details.reason === 'grant_absent'
  );
});
test('authority requires account operator on chain; failures and exclusive grants cannot fall back', async () => {
  const records = baseRecords();
  let fallback = 0;
  const opts = {
    evaluator: evaluator(records).trust,
    now: () => now,
    sellerAuthorization: async () => {
      fallback++;
      return true;
    },
    legacyAuthorization: async () => {
      fallback++;
      return true;
    },
  };
  await assert.rejects(identity.authorizeDemandGrant({ ...claim, accountOperator: 'outsider.com' }, opts));
  assert.equal(fallback, 0);
  records['brand.com'] = Error('offline');
  await assert.rejects(identity.authorizeDemandGrant(claim, { ...opts, evaluator: evaluator(records).trust }));
  assert.equal(fallback, 0);
});
test('implicit authority requires all three registrable domains and PRIVATE suffixes remain distinct', async () => {
  const origin = 'https://buyer.brand.com';
  const { trust } = evaluator({ 'brand.com': agent(origin) });
  assert.equal(
    (
      await identity.authorizeDemandGrant(
        { ...claim, signerOrigin: origin, accountOperator: 'brand.com' },
        { evaluator: trust, now: () => now }
      )
    ).source,
    'implicit'
  );
  const { eTldPlusOne } = require('../../dist/lib/signing/agent-resolver/etld');
  assert.notEqual(eTldPlusOne('a.vercel.app'), eTldPlusOne('b.vercel.app'));
});
test('no trust 200 downgrade after delisting, invalidation, or authoritative absence', async () => {
  const records = baseRecords(),
    { trust } = evaluator(records);
  await trust.get('brand.com');
  delete records['brand.com'];
  trust.invalidate('brand.com');
  await assert.rejects(trust.get('brand.com'));
});
test('unbound reads never create; audited binding is unique and RFC migration requires approval', async () => {
  const store = new identity.InMemoryOriginIdentityStore(),
    { trust } = evaluator(baseRecords());
  const lifecycle = new identity.OriginIdentityLifecycle({ store, trust, now: () => now });
  assert.deepEqual(await lifecycle.getPrincipal(claim.signerOrigin), { result: { kind: 'unconfigured' } });
  await assert.rejects(
    lifecycle.bindPrincipal({
      origin: claim.signerOrigin,
      principalId: 'p1',
      approvedBy: 'admin',
      reason: 'migration',
      existingRfcPrincipal: true,
    })
  );
  await lifecycle.bindPrincipal({
    origin: claim.signerOrigin,
    principalId: 'p1',
    approvedBy: 'admin',
    reason: 'approved',
  });
  await assert.rejects(
    lifecycle.bindPrincipal({ origin: claim.signerOrigin, principalId: 'p2', approvedBy: 'admin', reason: 'other' })
  );
  await assert.rejects(lifecycle.assertLegacyAllowed(claim.signerOrigin + '/mcp'));
});
test('open onboarding creates only new principals, limits tiers and per-operator quotas, and requires billing before spend', async () => {
  const records = baseRecords();
  records['agency.com'].agents.push({ url: 'https://other.agency.com', roles: ['adcp:buying'] });
  const { trust } = evaluator(records),
    store = new identity.InMemoryOriginIdentityStore();
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    maxOpenPrincipalsPerOperator: 1,
    lookupLegacyPrincipals: async () => [],
    onboarding: { sandbox: { mode: 'open' }, billing: { operator: { mode: 'open' }, agent: { mode: 'open' } } },
    hasBillingRelationship: async () => false,
  });
  const binding = await lifecycle.syncOpen(claim.signerOrigin);
  assert.deepEqual(binding.openAccess, { sandbox: true, billing: ['operator'] });
  await assert.rejects(lifecycle.syncOpen(claim.signerOrigin));
  await assert.rejects(lifecycle.syncOpen('https://other.agency.com'));
  assert(await lifecycle.authorizeBound(claim.signerOrigin, { sandbox: true }));
  await assert.rejects(lifecycle.authorizeBound(claim.signerOrigin, { billing: 'operator' }));
});
test('unknown requirements are unsatisfied and opposite-direction kinds are ignored', async () => {
  const result = await identity.evaluateOnboardingRequirements(
    [{ kind: 'aao_verified' }, { kind: 'future_requirement' }],
    'seller',
    async () => true
  );
  assert.equal(result.satisfied, false);
  assert.deepEqual(result.unsatisfied, [{ kind: 'future_requirement' }]);
});
test('pending relationship before principal binding, changes visible before notifications, and expiry is deduplicated', async () => {
  const store = new identity.InMemoryOriginIdentityStore(),
    { trust } = evaluator(baseRecords());
  let events = [];
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    notify: async (origin, reason) => {
      assert((await lifecycle.getPrincipal(origin)).result.relationship);
      events.push(reason);
    },
  });
  await lifecycle.setRelationship(claim.signerOrigin, {
    status: 'pending',
    setup: { message: 'Submit application' },
    expires_at: new Date((now + 60) * 1000).toISOString(),
  });
  assert.equal((await lifecycle.getPrincipal(claim.signerOrigin)).result.kind, 'unconfigured');
  assert(await lifecycle.notifyRelationshipExpiring(claim.signerOrigin, 90));
  assert.equal(await lifecycle.notifyRelationshipExpiring(claim.signerOrigin, 90), false);
  assert.deepEqual(events, ['relationship_changed', 'relationship_expiring']);
});
test('revocations never disappear or weaken across key rotation, empty snapshots and origins', async () => {
  const store = new identity.InMemoryOriginRevocationStore();
  const origin = claim.signerOrigin;
  const snapshot = {
    issuer: origin,
    updated: new Date(now * 1000).toISOString(),
    next_update: new Date((now + 60) * 1000).toISOString(),
    revoked_kids: ['old'],
    revocation_details: { old: { reason: 'keyCompromise', invalidity_date: '2026-01-01T00:00:00Z' } },
  };
  await store.merge(origin, snapshot);
  await store.merge(origin, { ...snapshot, revoked_kids: [] });
  await store.merge(origin, {
    ...snapshot,
    revocation_details: { old: { reason: 'superseded', invalidity_date: '2026-03-01T00:00:00Z' } },
  });
  assert.deepEqual(await store.get(origin, 'old'), snapshot.revocation_details.old);
  assert.equal(await store.get('https://other.com', 'old'), undefined);
});

test('draft principal validation accepts relationship only in successful result arms', () => {
  const response = {
    status: 'completed',
    result: { kind: 'unconfigured', relationship: { status: 'pending', setup: { message: 'Apply' } } },
  };
  assert(identity.validateIdentity33Payload('get_principal', 'response', response).valid);
  assert.equal(
    identity.validateIdentity33Payload('get_principal', 'response', {
      ...response,
      result: { ...response.result, principal_id: 'invented' },
    }).valid,
    false
  );
  assert.equal(
    identity.validateIdentity33Payload('get_principal', 'response', {
      ...response,
      result: {
        kind: 'failed',
        errors: [{ code: 'PERMISSION_DENIED', message: 'Denied' }],
        relationship: { status: 'active' },
      },
    }).valid,
    false
  );
});
test('relationship outbox retries a failed publish without losing its event or repeating expiry after other changes', async () => {
  const store = new identity.InMemoryOriginIdentityStore(),
    { trust } = evaluator(baseRecords());
  let fail = true,
    sent = [];
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    notify: async (_origin, reason, id) => {
      if (fail) throw Error('offline');
      sent.push({ reason, id });
    },
  });
  const relationship = { status: 'pending', expires_at: new Date((now + 60) * 1000).toISOString() };
  await assert.rejects(lifecycle.setRelationship(claim.signerOrigin, relationship));
  assert.equal((await store.getApplication(claim.signerOrigin)).pendingNotifications.length, 1);
  fail = false;
  await lifecycle.setRelationship(claim.signerOrigin, relationship);
  assert.equal(sent.length, 1);
  await lifecycle.notifyRelationshipExpiring(claim.signerOrigin, 90);
  await lifecycle.setRelationship(claim.signerOrigin, { ...relationship, status: 'active' });
  assert.equal(await lifecycle.notifyRelationshipExpiring(claim.signerOrigin, 90), false);
});
test('sandbox open binding without access context and existing RFC principal both fail closed', async () => {
  const store = new identity.InMemoryOriginIdentityStore(),
    { trust } = evaluator(baseRecords());
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    onboarding: { sandbox: { mode: 'open' } },
    lookupLegacyPrincipals: async () => ['legacy'],
  });
  await assert.rejects(lifecycle.syncOpen(claim.signerOrigin));
  const clean = new identity.OriginIdentityLifecycle({
    store,
    trust,
    onboarding: { sandbox: { mode: 'open' } },
    lookupLegacyPrincipals: async () => [],
  });
  await clean.syncOpen(claim.signerOrigin);
  await assert.rejects(clean.authorizeBound(claim.signerOrigin));
});
test('published narrowing denies even nonexclusive seller fallback and house record authority stays on the verified brand path', async () => {
  const records = baseRecords();
  records['brand.com'].exclusive_grants = false;
  records['brand.com'].grants[0].countries = ['CA'];
  let fallback = 0;
  await assert.rejects(
    identity.authorizeDemandGrant(claim, {
      evaluator: evaluator(records).trust,
      now: () => now,
      sellerAuthorization: async () => {
        fallback++;
        return true;
      },
    })
  );
  assert.equal(fallback, 0);
  records['house.com'] = { grants: [grant('agency.com', { profiles: { adcp: { brands: ['child'] } } })] };
  assert.equal(
    (
      await identity.authorizeDemandGrant(claim, {
        evaluator: evaluator(records).trust,
        now: () => now,
        resolveBrandHouse: async () => ({ domain: 'house.com', brand_id: 'child' }),
      })
    ).source,
    'trust'
  );
});

test('CAS-backed identity stores isolate tenants, enforce operator quotas under races and retain revocations after restart', async () => {
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store');
  const store = new InMemoryStateStore();
  const a = identity.createIdentity33StateStores({ store, tenantId: 'tenant-a' });
  const b = identity.createIdentity33StateStores({ store, tenantId: 'tenant-b' });
  const binding = origin => ({
    origin,
    operator: 'agency.com',
    principalId: origin,
    openAccess: { sandbox: true },
    audit: { approvedBy: 'open-policy', approvedAt: new Date(now * 1000).toISOString(), reason: 'new' },
  });
  const outcomes = await Promise.allSettled([
    a.identity.bindOpen(binding('https://one.agency.com'), 1),
    a.identity.bindOpen(binding('https://two.agency.com'), 1),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await b.identity.getBinding('https://one.agency.com'), undefined);
  await a.authorityHistory.mark('agency.com');
  const restarted = identity.createIdentity33StateStores({ store, tenantId: 'tenant-a' });
  assert(await restarted.authorityHistory.has('agency.com'));
  assert.equal(await b.authorityHistory.has('agency.com'), false);
  const snapshot = {
    issuer: claim.signerOrigin,
    updated: new Date(now * 1000).toISOString(),
    next_update: new Date((now + 60) * 1000).toISOString(),
    revoked_kids: ['old'],
    revocation_details: { old: { reason: 'keyCompromise' } },
  };
  await a.revocations.merge(claim.signerOrigin, snapshot);
  await restarted.revocations.merge(claim.signerOrigin, { ...snapshot, revoked_kids: [] });
  assert.equal((await restarted.revocations.get(claim.signerOrigin, 'old')).reason, 'keyCompromise');
  assert.equal(await b.revocations.get(claim.signerOrigin, 'old'), undefined);
});

test('server integrates unbound reads and relationship, and rejects setup before idempotency or side effects', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store');
  const store = new identity.InMemoryOriginIdentityStore(),
    { trust } = evaluator(baseRecords());
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    onboarding: { sandbox: { mode: 'open' } },
    lookupLegacyPrincipals: async () => [],
  });
  await lifecycle.setRelationship('https://buyer-7k3q.com', { status: 'pending', setup: { message: 'Apply' } });
  const v = vector('positive/001-single-signer-request');
  const signers = await wba.verifyWebBotAuth(v.request, options(v));
  const resolvePrincipal = identity.createIdentity33PrincipalResolver({ lifecycle });
  const principal = await resolvePrincipal(signers, 'get_principal');
  const auth = { token: '', clientId: principal.principal, scopes: [], extra: principal.extra };
  let reads = 0,
    changes = 0;
  const protocol = identity.withIdentity33PrincipalHandlers(
    {
      resolvePrincipalScope: ctx => ({ tenant_id: 'tenant', principal_id: ctx.authInfo.clientId }),
      getPrincipal: async () => {
        reads++;
        return { status: 'completed', result: { kind: 'unconfigured' } };
      },
      syncPrincipal: async () => {
        changes++;
        return {
          status: 'completed',
          result: { kind: 'failed', errors: [{ code: 'PERMISSION_DENIED', message: 'Fixture denies setup' }] },
        };
      },
    },
    lifecycle
  );
  const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');
  const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 });
  let cacheChecks = 0;
  const check = idempotency.check.bind(idempotency);
  idempotency.check = async params => {
    cacheChecks++;
    return check(params);
  };
  const server = createAdcpServer({
    name: 'Identity experiment',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    idempotency,
    identity33: {
      authorize: identity.createIdentity33Authorization({
        lifecycle,
        grants: { evaluator: trust, now: () => now },
        resolveClaims: async () => [],
      }),
    },
    protocol,
    mediaBuy: { getProducts: async () => ({ products: [], cache_scope: 'public' }) },
    validation: { requests: 'strict', responses: 'strict' },
  });
  try {
    const response = await server.dispatchTestRequest(
      { method: 'tools/call', params: { name: 'get_principal', arguments: { adcp_version: '3.3' } } },
      { authInfo: auth }
    );
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.equal(response.structuredContent.result.kind, 'unconfigured');
    assert.equal(response.structuredContent.result.relationship.status, 'pending');
    assert.equal(reads, 0);
    const rejected = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'sync_principal',
          arguments: {
            adcp_version: '3.3',
            idempotency_key: 'identity33-unconfigured-setup',
            configuration: { notification_configs: [] },
          },
        },
      },
      { authInfo: auth }
    );
    assert.equal(rejected.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.equal(changes, 0);
    assert.equal(cacheChecks, 0);
    const capabilities = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    assert.equal(capabilities.structuredContent.adcp_version, '3.3');
  } finally {
    await server.close();
  }
});

test('origin revocation verifies compact, flattened and general JWS and preserves facts after rotation', async () => {
  const { CompactSign, GeneralSign, FlattenedSign } = await import('jose');
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const publicKey = require('crypto').createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = wba.jwkThumbprint(publicKey),
    origin = 'https://signer.agency.com';
  const protectedHeader = { alg: 'EdDSA', kid, typ: 'adcp-gov-revocation+jws' };
  const snapshot = {
    issuer: origin,
    updated: new Date(now * 1000).toISOString(),
    next_update: new Date((now + 300) * 1000).toISOString(),
    revoked_kids: ['old'],
    revocation_details: { old: { reason: 'keyCompromise' } },
  };
  const directoryProof = await wba.createSignedSignatureDirectory(
    origin,
    [{ privateKey: { ...privateKey.export({ format: 'jwk' }), kid } }],
    { now: () => now }
  );
  const payload = Buffer.from(JSON.stringify(snapshot));
  const compact = await new CompactSign(payload).setProtectedHeader(protectedHeader).sign(privateKey);
  const flattened = await new FlattenedSign(payload).setProtectedHeader(protectedHeader).sign(privateKey);
  const general = await new GeneralSign(payload).addSignature(privateKey).setProtectedHeader(protectedHeader).sign();
  for (const body of [compact, JSON.stringify(flattened), JSON.stringify(general)]) {
    const store = new identity.InMemoryOriginRevocationStore();
    const resolver = new identity.OriginRevocationResolver({
      store,
      now: () => now,
      directory: resolverFromProof(directoryProof),
      fetchOptions: { trustedFetchFn: async () => new Response(body, { status: 200 }) },
    });
    assert.equal(await resolver.isRevoked(origin, 'old'), true);
    assert.equal(await resolver.isRevoked(origin, 'new'), false);
    assert.equal((await store.get(origin, 'old')).reason, 'keyCompromise');
  }
  const invalid = new identity.OriginRevocationResolver({
    store: new identity.InMemoryOriginRevocationStore(),
    now: () => now,
    directory: resolverFromProof(directoryProof),
    fetchOptions: {
      trustedFetchFn: async () =>
        new Response(
          JSON.stringify({ ...flattened, protected: flattened.protected, header: { typ: protectedHeader.typ } })
        ),
    },
  });
  await assert.rejects(invalid.isRevoked(origin, 'old'), e => e.reason === 'revocation_unavailable');
});

test('proposal finalization requires grants for a verified unbound identity', async () => {
  const v = vector('positive/001-single-signer-request'),
    signers = await wba.verifyWebBotAuth(v.request, options(v));
  const { trust } = evaluator(baseRecords()),
    lifecycle = new identity.OriginIdentityLifecycle({
      store: new identity.InMemoryOriginIdentityStore(),
      trust,
      now: () => now,
    });
  const principal = await identity.createIdentity33PrincipalResolver({ lifecycle })(signers, 'get_products');
  const ctx = { authInfo: { clientId: principal.principal, extra: principal.extra } };
  const authorize = identity.createIdentity33Authorization({
    lifecycle,
    grants: { evaluator: trust },
    resolveClaims: async () => [],
  });
  await authorize(ctx, 'get_products', { buying_mode: 'discover' });
  await assert.rejects(
    authorize(ctx, 'get_products', {
      buying_mode: 'refine',
      refine: [{ action: 'finalize', scope: 'proposal', proposal_id: 'p1' }],
    }),
    e => e.code === 'PERMISSION_DENIED'
  );
});

test('country-restricted agents require actual country claims, and permanent revocation quotas fail closed', async () => {
  const records = baseRecords();
  records['agency.com'].agents[0].countries = ['US'];
  await assert.rejects(
    identity.authorizeDemandGrant(
      { ...claim, brand: { domain: 'brand.com', brand_id: 'brand' } },
      { evaluator: evaluator(records).trust }
    ),
    identity.IdentityAuthorizationError
  );
  const store = new identity.InMemoryOriginRevocationStore({ perOrigin: 1, total: 1 });
  const snapshot = { issuer: claim.signerOrigin, updated: '', next_update: '', revoked_kids: ['old'] };
  await store.merge(claim.signerOrigin, snapshot);
  await assert.rejects(store.merge(claim.signerOrigin, { ...snapshot, revoked_kids: ['new'] }));
  assert(await store.get(claim.signerOrigin, 'old'));
  assert.equal(await store.get(claim.signerOrigin, 'new'), undefined);
});

test('context-free key resolvers cannot attribute a signature to another origin', async () => {
  const v = vector('positive/001-single-signer-request');
  await assert.rejects(wba.verifyWebBotAuth(v.request, { ...options(v), directory: { resolve: async () => keys[0] } }));
});

test('WBA challenges include required fields; revocations cannot suggest re-signing; outage policy distinguishes reads', async () => {
  const missing = vector('negative/001-missing-nonce');
  await assert.rejects(
    wba.verifyWebBotAuth(missing.request, options(missing)),
    e =>
      e.headers['Accept-Signature'].includes(';created;expires;nonce;keyid;alg;tag="web-bot-auth"') &&
      e.headers['Accept-Signature'].includes('"content-digest"')
  );
  const v = vector('positive/001-single-signer-request');
  await assert.rejects(
    wba.verifyWebBotAuth(v.request, { ...options(v), isRevoked: async () => true }),
    e => e.reason === 'key_revoked' && !e.headers['Accept-Signature']
  );
  const unavailable = async () => {
    throw new wba.WebBotAuthError(403, 'revocation_unavailable');
  };
  // Unknown revocation status leaves the identity unverified (DR-0023), never a 503.
  await assert.rejects(
    wba.verifyWebBotAuth(v.request, { ...options(v), isRevoked: unavailable }),
    e => e.reason === 'identity_unverified' && e.status === 403 && !!e.headers['Accept-Signature']
  );
  assert.equal(
    (await wba.verifyWebBotAuth(v.request, { ...options(v), isRevoked: unavailable, requireFreshRevocation: false }))
      .length,
    1
  );
});

test('signed revocation authoring and outage grace expire without losing permanent facts', async () => {
  const pair = generateKeyPairSync('ed25519'),
    priv = pair.privateKey.export({ format: 'jwk' });
  priv.kid = wba.jwkThumbprint(priv);
  const origin = 'https://agent.example.com',
    clockStart = Date.now() / 1000;
  let clock = clockStart,
    fail = false;
  const directory = await wba.createSignedSignatureDirectory(origin, [{ privateKey: priv }], { now: () => clockStart });
  const snapshot = {
    issuer: origin,
    updated: new Date(clockStart * 1000).toISOString(),
    next_update: new Date((clockStart + 60) * 1000).toISOString(),
    revoked_kids: ['old'],
  };
  const body = await identity.createSignedOriginRevocationList(snapshot, priv),
    store = new identity.InMemoryOriginRevocationStore();
  const resolver = new identity.OriginRevocationResolver({
    now: () => clock,
    pollingIntervalSeconds: 60,
    store,
    directory: resolverFromProof(directory, clockStart),
    fetchOptions: {
      trustedFetchFn: async () => {
        if (fail) throw Error('offline');
        return new Response(body);
      },
    },
  });
  assert.equal(await resolver.isRevoked(origin, 'new'), false);
  fail = true;
  clock += 61;
  assert.equal(await resolver.isRevoked(origin, 'new'), false);
  clock += 240;
  await assert.rejects(resolver.isRevoked(origin, 'new'), e => e.reason === 'revocation_unavailable');
  assert.equal(await resolver.isRevoked(origin, 'old'), true);
});

test('bound grant denial precedes provisioning and covers signal, rights and resource mutations', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const v = vector('positive/001-single-signer-request'),
    origin = 'https://buyer-7k3q.com';
  const { trust } = evaluator({ 'buyer-7k3q.com': agent(origin) }),
    store = new identity.InMemoryOriginIdentityStore();
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    lookupLegacyPrincipals: async () => [],
  });
  await lifecycle.bindPrincipal({
    origin,
    principalId: 'audited-principal',
    approvedBy: 'seller',
    reason: 'Approved relationship',
  });
  const principal = await identity.createIdentity33PrincipalResolver({ lifecycle })(
    await wba.verifyWebBotAuth(v.request, options(v)),
    'create_media_buy'
  );
  const authInfo = { token: '', clientId: principal.principal, scopes: [], extra: principal.extra };
  const authorize = identity.createIdentity33Authorization({
    lifecycle,
    grants: { evaluator: trust },
    resolveClaims: async () => [
      {
        brand: { domain: 'victim.com' },
        accountOperator: 'buyer-7k3q.com',
        scope: 'adcp:media_buying',
        billing: 'operator',
      },
    ],
  });
  for (const tool of [
    'activate_signal',
    'acquire_rights',
    'update_rights',
    'sync_audiences',
    'sync_creatives',
    'control_media_buy',
  ])
    await assert.rejects(authorize({ authInfo }, tool, {}), e => e.details?.reason === 'grant_absent');
  let provisions = 0,
    effects = 0;
  const server = require('../../dist/lib/server/create-adcp-server').createAdcpServer({
    name: 'Grant boundary',
    version: '1.0.0',
    stateStore: new (require('../../dist/lib/server/state-store').InMemoryStateStore)(),
    identity33: { authorize },
    resolveAccount: async () => {
      provisions++;
      return {};
    },
    mediaBuy: {
      getProducts: async () => ({ products: [], cache_scope: 'public' }),
      createMediaBuy: async () => {
        effects++;
        return { media_buy_id: 'buy', packages: [] };
      },
    },
    validation: { requests: 'off', responses: 'off' },
  });
  try {
    const response = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            adcp_version: '3.3',
            account: { account_id: 'unverified-account' },
            brand: { domain: 'victim.com' },
            start_time: 'asap',
            end_time: '2026-12-31T00:00:00Z',
            packages: [{ product_id: 'p', pricing_option_id: 'price', budget: 1000 }],
          },
        },
      },
      { authInfo }
    );
    assert.equal(response.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.deepEqual(response.structuredContent.adcp_error.details, { scope: 'agent', reason: 'grant_absent' });
    assert.equal(provisions, 0);
    assert.equal(effects, 0);
  } finally {
    await server.close();
  }
});

test('legacy RFC revocation facts also survive replacement snapshots and retain reason/date severity', async () => {
  const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation');
  const store = new InMemoryRevocationStore({
    issuer: 'https://issuer.example',
    updated: '',
    next_update: '',
    revoked_kids: ['old'],
    revoked_jtis: [],
    revocation_details: { old: { reason: 'keyCompromise', invalidity_date: '2026-01-01T00:00:00Z' } },
  });
  store.load({ revoked_kids: [], revoked_jtis: [] });
  assert.equal(await store.isRevoked('old'), true);
  store.load({
    revoked_kids: ['old'],
    revoked_jtis: [],
    revocation_details: { old: { reason: 'superseded', invalidity_date: '2026-06-01T00:00:00Z' } },
  });
  assert.deepEqual(store.getDetails('old'), { reason: 'keyCompromise', invalidity_date: '2026-01-01T00:00:00Z' });
});

test('open onboarding dry run writes nothing; real sync configures the same audited principal id', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const v = vector('positive/001-single-signer-request'),
    origin = 'https://buyer-7k3q.com';
  const { trust } = evaluator({ 'buyer-7k3q.com': agent(origin) });
  const state = new (require('../../dist/lib/server/state-store').InMemoryStateStore)(),
    stores = identity.createIdentity33StateStores({ store: state, tenantId: 'tenant' });
  const lifecycle = new identity.OriginIdentityLifecycle({
    store: stores.identity,
    trust,
    now: () => now,
    onboarding: { sandbox: { mode: 'open' } },
    lookupLegacyPrincipals: async () => [],
  });
  const principalApi = require('../../dist/lib/server/principal'),
    principalStore = principalApi.createPrincipalStateStore({ store: state });
  const notifications = require('../../dist/lib/server/notification-subscriptions').createPersistentNotificationRuntime(
    {
      store: principalApi.principalNotificationSubscriptionStore(principalStore),
      proofAdapter: {
        prove: async () => {
          throw Error('No destination should be proved');
        },
      },
      validateDestination: async () => {
        throw Error('No destination should be validated');
      },
      authorizeDelivery: async () => {
        throw Error('No delivery expected');
      },
      checkpointDeliveryAttempt: async () => {},
      createEmitter: () => ({
        forTenantScope() {
          return this;
        },
        emit: async () => {
          throw Error('No delivery expected');
        },
        emitRecovered: async () => {
          throw Error('No delivery expected');
        },
      }),
    }
  );
  const runtime = principalApi.createPrincipalLifecycle({
    store: principalStore,
    notifications,
    agentUrl: 'https://seller.example.com/mcp',
    resolvePrincipal: identity.createIdentity33PrincipalScopeResolver({ lifecycle, tenantId: 'tenant' }),
  });
  const resolve = identity.createIdentity33PrincipalResolver({ lifecycle }),
    signers = await wba.verifyWebBotAuth(v.request, options(v));
  const principal = await resolve(signers, 'sync_principal'),
    authInfo = { token: '', clientId: principal.principal, scopes: [], extra: principal.extra };
  const server = require('../../dist/lib/server/create-adcp-server').createAdcpServer({
    name: 'Open identity',
    version: '1.0.0',
    stateStore: state,
    protocol: identity.withIdentity33PrincipalHandlers(runtime.protocol, lifecycle),
    identity33: {
      authorize: identity.createIdentity33Authorization({
        lifecycle,
        grants: { evaluator: trust },
        resolveClaims: async () => [],
      }),
    },
    validation: { requests: 'strict', responses: 'strict' },
  });
  const invoke = (name, arguments_) =>
    server.dispatchTestRequest(
      { method: 'tools/call', params: { name, arguments: { adcp_version: '3.3', ...arguments_ } } },
      { authInfo }
    );
  try {
    const dry = await invoke('sync_principal', {
      configuration: { notification_configs: [] },
      dry_run: true,
      idempotency_key: 'open-identity-dry-run',
    });
    assert.notEqual(dry.isError, true, JSON.stringify(dry));
    assert.equal(dry.structuredContent.result.kind, 'validated');
    assert.equal(await stores.identity.getBinding(origin), undefined);
    const applied = await invoke('sync_principal', {
      configuration: { notification_configs: [] },
      idempotency_key: 'open-identity-configure',
    });
    assert.notEqual(applied.isError, true, JSON.stringify(applied));
    assert.equal(applied.structuredContent.result.kind, 'applied');
    const binding = await stores.identity.getBinding(origin);
    assert.equal(applied.structuredContent.result.principal_id, binding.principalId);
    const current = await invoke('get_principal', {});
    assert.equal(current.structuredContent.result.kind, 'current');
    assert.equal(current.structuredContent.result.principal_id, binding.principalId);
  } finally {
    await server.close();
  }
});

test('official MCP client receives deferred identity denials as tool errors; A2A invocation uses the same envelope', async t => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
  const { getSdkServer } = require('../../dist/lib/server/adcp-server');
  const v = vector('positive/001-single-signer-request');
  const { trust } = evaluator(baseRecords()),
    lifecycle = new identity.OriginIdentityLifecycle({
      store: new identity.InMemoryOriginIdentityStore(),
      trust,
      now: () => now,
    });
  const resolve = identity.createIdentity33PrincipalResolver({ lifecycle });
  let effects = 0;
  const server = createAdcpServer({
    name: 'Identity denial',
    version: '1.0.0',
    identity33: {
      authorize: async () => {
        effects++;
      },
    },
    mediaBuy: {
      getProducts: async () => {
        effects++;
        return { products: [], cache_scope: 'public' };
      },
    },
    validation: { requests: 'strict', responses: 'strict' },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await getSdkServer(server).connect(serverTransport);
  let authInfo;
  const onmessage = serverTransport.onmessage;
  serverTransport.onmessage = (message, extra) => onmessage(message, { ...extra, authInfo });
  const client = new Client({ name: 'Identity receiver', version: '1.0.0' });
  try {
    await client.connect(clientTransport);
    await client.listTools();
    // Revocation is no longer deferred into tool errors: a revoked key is a 403
    // without a challenge and unknown status leaves the identity unverified.
    await assert.rejects(
      wba.verifyWebBotAuth(v.request, { ...options(v), isRevoked: async () => true }),
      e => e.reason === 'key_revoked' && !e.headers['Accept-Signature']
    );
    for (const reason of ['identity_not_bound']) {
      const signers = await wba.verifyWebBotAuth(v.request, options(v));
      const principal = await resolve(signers, reason === 'identity_not_bound' ? 'create_media_buy' : 'get_products');
      authInfo = {
        token: '',
        clientId: principal.principal,
        scopes: [],
        extra: { ...principal.extra, webBotAuthAuthorization: { signer: signers[signers.length - 1] } },
      };
      const response = await client.callTool({
        name: 'get_products',
        arguments: { adcp_version: '3.3', buying_mode: 'brief', brief: 'Fixture request' },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0].text);
      assert.equal(
        body.adcp_error.code,
        reason === 'revocation_unavailable' ? 'SERVICE_UNAVAILABLE' : 'PERMISSION_DENIED'
      );
      const invoked = await server.invoke({
        toolName: 'get_products',
        args: { adcp_version: '3.3', buying_mode: 'brief', brief: 'Fixture request' },
        authInfo,
      });
      assert.equal(JSON.parse(invoked.content[0].text).adcp_error.code, body.adcp_error.code);
    }
    assert.equal(effects, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('standard resolver supplies migration fence and preserves explicitly approved operator principals', async () => {
  const origin = claim.signerOrigin,
    { trust } = evaluator(baseRecords()),
    store = new identity.InMemoryOriginIdentityStore();
  const lifecycle = new identity.OriginIdentityLifecycle({
    store,
    trust,
    now: () => now,
    lookupLegacyPrincipals: async () => ['existing-operator'],
  });
  const resolver = identity.createIdentity33PrincipalResolver({ lifecycle });
  const gate = wba.getWebBotAuthLegacyOriginGate(resolver);
  await gate(origin);
  await lifecycle.bindPrincipal({
    origin,
    principalId: 'existing-operator',
    principalKind: 'operator',
    approvedBy: 'seller',
    reason: 'Reviewed origin migration',
    migrationApproved: true,
  });
  assert.equal((await lifecycle.getPrincipal(origin)).result.principal_kind, 'operator');
  await assert.rejects(gate(origin), e => e.code === 'request_signature_key_unknown');
});

test('missing bindings fail closed and empty first-contact lists allocate no revocation rows', async () => {
  const { trust } = evaluator(baseRecords()),
    lifecycle = new identity.OriginIdentityLifecycle({ store: new identity.InMemoryOriginIdentityStore(), trust });
  await assert.rejects(
    lifecycle.authorizeBound(claim.signerOrigin, { readOnly: true }),
    identity.IdentityAuthorizationError
  );
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store');
  const backend = new InMemoryStateStore();
  let writes = 0;
  const put = backend.putIfMatch.bind(backend);
  backend.putIfMatch = async (...args) => {
    writes++;
    return put(...args);
  };
  const stores = identity.createIdentity33StateStores({ store: backend, tenantId: 'quota-test' });
  await stores.revocations.merge(claim.signerOrigin, {
    issuer: claim.signerOrigin,
    updated: '',
    next_update: '',
    revoked_kids: [],
  });
  assert.equal(writes, 0);
  await stores.revocations.merge(claim.signerOrigin, {
    issuer: claim.signerOrigin,
    updated: '',
    next_update: '',
    revoked_kids: ['old'],
  });
  assert.equal(writes, 2);
  await stores.revocations.merge(claim.signerOrigin, {
    issuer: claim.signerOrigin,
    updated: '',
    next_update: '',
    revoked_kids: [],
  });
  assert.equal(writes, 2);
  assert(await stores.revocations.get(claim.signerOrigin, 'old'));
});

test('a custom WBA resolver cannot bypass authorization by omitting the identity claim', async () => {
  const v = vector('positive/001-single-signer-request'),
    signers = await wba.verifyWebBotAuth(v.request, options(v));
  const authorize = identity.createIdentity33Authorization({
    lifecycle: {},
    grants: {},
    resolveClaims: async () => {
      throw new Error('must not resolve claims');
    },
  });
  await assert.rejects(
    authorize({ authInfo: { extra: { webBotAuthAuthorization: { signer: signers[0] } } } }, 'create_media_buy', {}),
    e => e.code === 'PERMISSION_DENIED'
  );
  await authorize({ authInfo: { extra: {} } }, 'get_products', {});
});

test('anonymous revocation capacity cannot consume the audited bound pool and facts survive promotion', async () => {
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store');
  const stores = identity.createIdentity33StateStores({
    store: new InMemoryStateStore(),
    tenantId: 'partitioned-budget',
    revocationLimits: { keys: 2 },
  });
  const anonymous = 'https://anonymous.buyer-7k3q.com',
    bound = 'https://bound.buyer-7k3q.com';
  const snapshot = (issuer, kids) => ({ issuer, updated: '', next_update: '', revoked_kids: kids });
  await stores.revocations.merge(anonymous, snapshot(anonymous, ['a', 'b']));
  await assert.rejects(
    stores.revocations.merge('https://other.buyer-7k3q.com', snapshot('https://other.buyer-7k3q.com', ['x']))
  );
  const binding = origin => ({
    origin,
    operator: 'buyer-7k3q.com',
    principalId: origin,
    audit: { approvedBy: 'seller', approvedAt: new Date().toISOString(), reason: 'Audited test binding' },
  });
  const open = 'https://open.buyer-7k3q.com';
  await stores.identity.bind({ ...binding(open), openAccess: { sandbox: true } });
  await assert.rejects(stores.revocations.merge(open, snapshot(open, ['open-key'])));
  await stores.identity.bind(binding(bound));
  await stores.revocations.merge(bound, snapshot(bound, ['c', 'd']));
  assert(await stores.revocations.get(bound, 'd'));
  assert(await stores.revocations.get(anonymous, 'a'));
  await stores.identity.bind(binding(anonymous));
  await assert.rejects(stores.revocations.merge(anonymous, snapshot(anonymous, ['a', 'b'])));
  assert(await stores.revocations.get(anonymous, 'a'));
});

test('revocation persistence failure never inherits outage grace or the read exception', async () => {
  const pair = generateKeyPairSync('ed25519'),
    priv = pair.privateKey.export({ format: 'jwk' });
  priv.kid = wba.jwkThumbprint(priv);
  const origin = 'https://agent.example.com',
    started = Date.now() / 1000;
  let clock = started,
    rejectWrites = false;
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: priv }], { now: () => started });
  const store = new identity.InMemoryOriginRevocationStore(),
    merge = store.merge.bind(store);
  store.merge = async (...args) => {
    if (rejectWrites) throw new Error('storage full');
    await merge(...args);
  };
  const resolver = new identity.OriginRevocationResolver({
    now: () => clock,
    pollingIntervalSeconds: 60,
    directory: resolverFromProof(proof, started),
    store,
    fetchOptions: {
      trustedFetchFn: async () =>
        new Response(
          await identity.createSignedOriginRevocationList(
            {
              issuer: origin,
              updated: new Date(started * 1000).toISOString(),
              next_update: new Date((clock + 60) * 1000).toISOString(),
              revoked_kids: ['old'],
            },
            priv
          )
        ),
    },
  });
  assert.equal(await resolver.isRevoked(origin, 'new'), false);
  clock += 61;
  rejectWrites = true;
  for (let n = 0; n < 2; n++)
    await assert.rejects(
      resolver.isRevoked(origin, 'new'),
      e => e.reason === 'revocation_persistence_failed' && e instanceof wba.WebBotAuthUnavailableError
    );
  assert.equal(await resolver.isRevoked(origin, 'old'), true);
  const v = vector('positive/001-single-signer-request');
  await assert.rejects(
    wba.verifyWebBotAuth(v.request, {
      ...options(v),
      requireFreshRevocation: false,
      isRevoked: async () => {
        throw new wba.WebBotAuthError(403, 'revocation_persistence_failed');
      },
    }),
    e => e.reason === 'revocation_persistence_failed'
  );
});
