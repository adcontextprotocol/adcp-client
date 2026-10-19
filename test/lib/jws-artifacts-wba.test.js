// AdCP 3.3 R4 (adcontextprotocol/adcp#8299): JWS artifacts from a Web Bot Auth
// identity are verified with a key from the issuer origin's key directory.
// Selection, 3.2 fallback, fetch-failure-is-not-absence, revocation, alg/kid,
// and historical verification through the governance key archive.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { CompactSign, importJWK } = require('jose');

const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks.js');
const {
  computeGovernedPayloadHash,
  InMemoryGovernanceReplayStore,
  verifyGovernanceAuthorization,
  verifyHistoricalGovernanceContext,
} = require('../../dist/lib/index.js');

const T = 1790841610;
const iso = seconds => new Date(seconds * 1000).toISOString();
const ORIGIN = 'https://gov.operator.com';
const ISSUER = ORIGIN + '/governance';
const SELLER = 'https://seller.publisher.com';
const CALLER = 'https://buyer.agency.com';
const PAYLOAD = { idempotency_key: 'idem-0001', account: { account_id: 'acct-1' }, total_budget: 500 };
const CRIT = ['authorized_commitment', 'authorized_task', 'authorized_payload_hash'];

function ed25519() {
  const pair = generateKeyPairSync('ed25519');
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const kid = wba.jwkThumbprint(privateJwk);
  return { kid, privateJwk: { ...privateJwk, kid }, privateKey: pair.privateKey };
}

let jtiCounter = 0;
function claims(overrides = {}) {
  return {
    iss: ISSUER,
    sub: 'action-1',
    plan_hash: 'plan-hash-1',
    aud: SELLER,
    iat: T,
    exp: T + 600,
    jti: `jti-${++jtiCounter}`,
    phase: 'intent',
    caller: CALLER,
    check_id: 'check-1',
    authorized_commitment: { amount: 1000, currency: 'USD' },
    authorized_task: 'create_media_buy',
    authorized_payload_hash: computeGovernedPayloadHash(PAYLOAD),
    ...overrides,
  };
}

async function sign(privateKey, kid, body = claims(), header = {}) {
  return new CompactSign(Buffer.from(JSON.stringify(body)))
    .setProtectedHeader({
      alg: 'EdDSA',
      kid,
      typ: 'adcp-gov+jws',
      crit: CRIT,
      authorized_commitment: true,
      authorized_task: true,
      authorized_payload_hash: true,
      ...header,
    })
    .sign(privateKey, { crit: { authorized_commitment: true, authorized_task: true, authorized_payload_hash: true } });
}

/**
 * One governance origin with a signed key directory, optional revocation list
 * and archive, and trust records served by registrable domain. `routes` and
 * `records` stay mutable so a test can change what the origin serves.
 */
async function world({ records, directoryKeys, revoked, archive, revocationStatus } = {}) {
  const key = ed25519();
  const keys = directoryKeys ?? [key];
  const proof = await wba.createSignedSignatureDirectory(
    ORIGIN,
    keys.map(k => ({ privateKey: k.privateJwk })),
    { now: () => T - 60, lifetimeSeconds: 3 * 86400 }
  );
  const fetched = [];
  const routes = {
    [ORIGIN + wba.SIGNATURE_DIRECTORY_PATH]: () => new Response(proof.body, { status: 200, headers: proof.headers }),
  };
  if (revoked !== undefined) {
    const list = await new CompactSign(
      Buffer.from(
        JSON.stringify({ issuer: ORIGIN, updated: iso(T - 10), next_update: iso(T + 900), revoked_kids: revoked })
      )
    )
      .setProtectedHeader({ alg: 'EdDSA', kid: keys[0].kid, typ: 'adcp-gov-revocation+jws' })
      .sign(keys[0].privateKey);
    routes[ORIGIN + '/.well-known/governance-revocations.json'] = () => new Response(list);
  } else if (revocationStatus !== undefined) {
    routes[ORIGIN + '/.well-known/governance-revocations.json'] = () => new Response('', { status: revocationStatus });
  }
  if (archive !== undefined)
    routes[ORIGIN + '/.well-known/jwks-archive.json'] = () =>
      typeof archive === 'number' ? new Response('', { status: archive }) : new Response(JSON.stringify(archive));
  const serve = async url => {
    fetched.push(url);
    const route = routes[url];
    if (!route) return new Response('', { status: 404 });
    const response = route();
    if (response instanceof Error) throw response;
    return response;
  };
  const trustRecords = records ?? { 'operator.com': { agents: [{ url: ORIGIN, roles: ['adcp:governance'] }] } };
  let clock = T;
  const now = () => clock;
  const trust = new identity.TrustEvaluator({
    now,
    fetchOptions: {
      trustedFetchFn: async url => {
        fetched.push(url);
        const record = trustRecords[new URL(url).hostname];
        if (record instanceof Error) throw record;
        if (typeof record === 'number') return new Response('', { status: record });
        return new Response(record === undefined ? '' : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
  const directory = new wba.SignatureDirectoryResolver({ now, fetchOptions: { trustedFetchFn: serve } });
  const revocation =
    revoked !== undefined || revocationStatus !== undefined
      ? new identity.OriginRevocationResolver({
          store: new identity.InMemoryOriginRevocationStore(),
          directory,
          now,
          fetchOptions: { trustedFetchFn: serve },
        })
      : undefined;
  const archiveResolver = new identity.GovernanceKeyArchiveResolver({ now, fetchOptions: { trustedFetchFn: serve } });
  const webBotAuth = { trust, directory, ...(revocation ? { revocation } : {}) };
  return {
    key,
    keys,
    trust,
    directory,
    revocation,
    archiveResolver,
    webBotAuth,
    routes,
    trustRecords,
    fetched,
    setClock: value => (clock = value),
    options: (token, extra = {}) => ({
      token,
      expectedIssuer: ISSUER,
      expectedAudience: SELLER,
      authenticatedCaller: CALLER,
      expectedTask: 'create_media_buy',
      payload: PAYLOAD,
      actualCommitment: { amount: 500, currency: 'USD' },
      replayStore: new InMemoryGovernanceReplayStore(),
      now,
      webBotAuth,
      ...extra,
    }),
  };
}

/** A 3.2-profile governance key with its key-purpose members, behind a counting resolver. */
function legacyKey() {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'gov-3-2',
    alg: 'EdDSA',
    use: 'sig',
    key_ops: ['verify'],
    adcp_use: 'governance-signing',
  };
  const inner = new StaticJwksResolver([publicJwk]);
  let calls = 0;
  return {
    privateKey: pair.privateKey,
    kid: 'gov-3-2',
    jwks: {
      resolve: kid => {
        calls++;
        return inner.resolve(kid);
      },
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------- selection

test('selection: an issuer listed by the trust record derived from its origin verifies on its WBA key directory', async () => {
  const w = await world();
  const token = await sign(w.key.privateKey, w.key.kid);
  // No jwks or buyerIdentity: the 3.2 path could not verify this token at all.
  const result = await verifyGovernanceAuthorization(w.options(token));
  assert.equal(result.ok, true, result.message);
  // The directory key carries neither adcp_use nor key_ops, both of which the
  // 3.2 profile requires: no key-purpose checks apply.
  const directoryKey = w.directory.getVerifiedDirectory(ORIGIN).keys[0];
  assert.equal(directoryKey.adcp_use, undefined);
  assert.equal(directoryKey.key_ops, undefined);
  assert.ok(w.fetched.includes('https://operator.com/.well-known/trust.json'));
});

test('selection reads the expected issuer, never the token, and reports the operator', async () => {
  const w = await world();
  assert.deepEqual(await identity.selectJwsArtifactProfile(ISSUER, w.trust), {
    profile: 'web-bot-auth',
    origin: ORIGIN,
    operator: 'operator.com',
  });
  // A token whose iss names another origin is refused before any key lookup.
  const token = await sign(w.key.privateKey, w.key.kid, claims({ iss: 'https://gov.elsewhere.com' }));
  const result = await verifyGovernanceAuthorization(w.options(token));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_token_invalid');
});

// ----------------------------------------------------------------- fallback

test('fallback: an issuer whose operator publishes no trust record stays on the 3.2 profile', async () => {
  const w = await world({ records: {} });
  const legacy = legacyKey();
  const token = await sign(legacy.privateKey, legacy.kid);
  const result = await verifyGovernanceAuthorization(w.options(token, { jwks: legacy.jwks }));
  assert.equal(result.ok, true, result.message);
  assert.equal(legacy.calls(), 1);
  assert.deepEqual(await identity.selectJwsArtifactProfile(ISSUER, w.trust), {
    profile: '3.2',
    origin: ORIGIN,
    reason: 'no_trust_record',
  });
});

test('fallback: an issuer the trust record does not list stays on the 3.2 profile', async () => {
  const w = await world({
    records: { 'operator.com': { agents: [{ url: 'https://other.operator.com', roles: ['adcp:governance'] }] } },
  });
  const legacy = legacyKey();
  const result = await verifyGovernanceAuthorization(
    w.options(await sign(legacy.privateKey, legacy.kid), { jwks: legacy.jwks })
  );
  assert.equal(result.ok, true, result.message);
  assert.equal((await identity.selectJwsArtifactProfile(ISSUER, w.trust)).reason, 'unlisted');
});

test('fallback: an origin with no registrable domain has no trust record', async () => {
  const w = await world();
  for (const url of ['https://203.0.113.7/gov', 'https://github.io'])
    assert.deepEqual(await identity.selectJwsArtifactProfile(url, w.trust), {
      profile: '3.2',
      origin: new URL(url).origin,
      reason: 'no_trust_record',
    });
});

test('fallback: a listed issuer is never verified under the 3.2 profile, even with a valid 3.2 key', async () => {
  const w = await world();
  const legacy = legacyKey();
  const result = await verifyGovernanceAuthorization(
    w.options(await sign(legacy.privateKey, legacy.kid), { jwks: legacy.jwks })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_key_unknown');
  assert.equal(legacy.calls(), 0);
});

test('without webBotAuth the verifier is unchanged: 3.2 only', async () => {
  const w = await world();
  const legacy = legacyKey();
  const options = w.options(await sign(legacy.privateKey, legacy.kid), { jwks: legacy.jwks });
  delete options.webBotAuth;
  assert.equal((await verifyGovernanceAuthorization(options)).ok, true);
});

// -------------------------------------------------- fetch failure ≠ absence

test('a trust-record fetch failure is not absence: it never selects the 3.2 profile', async () => {
  for (const failure of [new Error('offline'), 500, 503]) {
    const w = await world({ records: { 'operator.com': failure } });
    const legacy = legacyKey();
    const result = await verifyGovernanceAuthorization(
      w.options(await sign(legacy.privateKey, legacy.kid), { jwks: legacy.jwks })
    );
    assert.equal(result.ok, false, String(failure));
    assert.equal(result.error, 'governance_key_unknown');
    assert.match(result.message, /trust record is unavailable/);
    assert.equal(legacy.calls(), 0, 'the 3.2 key resolver is never consulted');
    await assert.rejects(
      identity.selectJwsArtifactProfile(ISSUER, w.trust),
      error => error instanceof identity.JwsArtifactError && error.code === 'jws_key_unavailable' && error.transient
    );
  }
});

test('a 404 after the operator served a record is an outage, not a return to 3.2', async () => {
  const w = await world();
  assert.equal((await verifyGovernanceAuthorization(w.options(await sign(w.key.privateKey, w.key.kid)))).ok, true);
  delete w.trustRecords['operator.com'];
  w.setClock(T + 301); // past the trust record's freshness
  const legacy = legacyKey();
  const token = await sign(legacy.privateKey, legacy.kid, claims({ iat: T + 301, exp: T + 900 }));
  const result = await verifyGovernanceAuthorization(w.options(token, { jwks: legacy.jwks }));
  assert.equal(result.ok, false);
  assert.equal(legacy.calls(), 0);
});

test('a key-directory fetch failure rejects the token and never falls back to 3.2', async () => {
  const w = await world();
  w.routes[ORIGIN + '/.well-known/http-message-signatures-directory'] = () => new Response('', { status: 503 });
  const legacy = legacyKey();
  const result = await verifyGovernanceAuthorization(
    w.options(await sign(w.key.privateKey, w.key.kid), { jwks: legacy.jwks })
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_key_unknown');
  assert.equal(legacy.calls(), 0);
});

// --------------------------------------------------------------- revocation

test("revocation is the origin's list: its signed list revokes the signing kid", async () => {
  const listSigner = ed25519();
  const signer = ed25519();
  const w = await world({ directoryKeys: [listSigner, signer], revoked: [signer.kid] });
  const result = await verifyGovernanceAuthorization(w.options(await sign(signer.privateKey, signer.kid)));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_token_revoked');
  // The other key, not revoked, still verifies.
  const ok = await verifyGovernanceAuthorization(w.options(await sign(listSigner.privateKey, listSigner.kid)));
  assert.equal(ok.ok, true, ok.message);
});

test('revocation: an origin that serves no list, or whose status is unknown, fails closed for a governance context', async () => {
  for (const status of [404, 500]) {
    const w = await world({ revocationStatus: status });
    const result = await verifyGovernanceAuthorization(w.options(await sign(w.key.privateKey, w.key.kid)));
    assert.equal(result.ok, false, String(status));
    assert.equal(result.error, 'governance_token_revoked');
    assert.match(result.message, /could not be established/);
  }
});

// ------------------------------------------------------------------ alg/kid

test('alg must be EdDSA on the WBA path', async () => {
  const w = await world();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = wba.jwkThumbprint(pair.publicKey.export({ format: 'jwk' }));
  const token = await sign(pair.privateKey, kid, claims(), { alg: 'ES256' });
  const result = await verifyGovernanceAuthorization(w.options(token));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_token_invalid');
});

test('kid must be the key JWK thumbprint', async () => {
  const w = await world();
  // A kid naming the key any other way finds no directory key.
  const named = await verifyGovernanceAuthorization(w.options(await sign(w.key.privateKey, 'gov-2026-10')));
  assert.equal(named.ok, false);
  assert.equal(named.error, 'governance_key_unknown');

  // A resolver that hands back a key under a kid that is not its thumbprint is refused.
  const other = ed25519();
  const lying = { resolve: async () => ({ kty: 'OKP', crv: 'Ed25519', x: other.privateJwk.x, kid: w.key.kid }) };
  const token = await sign(other.privateKey, w.key.kid);
  await assert.rejects(
    identity.verifyWebBotAuthJwsArtifact(token, ORIGIN, { directory: lying }),
    error => error.code === 'jws_invalid' && /thumbprint/.test(error.message)
  );
});

test('a token signed by another key under the directory kid fails signature verification', async () => {
  const w = await world();
  const forger = ed25519();
  const result = await verifyGovernanceAuthorization(w.options(await sign(forger.privateKey, w.key.kid)));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_token_invalid');
});

test('every other governance check still applies on the WBA path, including the buyer brand.json cross-check', async () => {
  const w = await world();
  const brandJson = (type, url = ISSUER) => ({ agents: [{ type, url, id: 'gov' }] });
  const token = () => sign(w.key.privateKey, w.key.kid);
  const listed = await verifyGovernanceAuthorization(
    w.options(await token(), { buyerIdentity: { brandJson: brandJson('governance'), brandDomain: 'brand.com' } })
  );
  assert.equal(listed.ok, true, listed.message);
  // The brand.json entry is only a cross-check: no JWKS is fetched from it.
  assert.ok(!w.fetched.some(url => url.endsWith('/.well-known/jwks.json')));

  const notGovernance = await verifyGovernanceAuthorization(
    w.options(await token(), { buyerIdentity: { brandJson: brandJson('buying'), brandDomain: 'brand.com' } })
  );
  assert.equal(notGovernance.ok, false);
  assert.equal(notGovernance.error, 'governance_key_unknown');

  const wrongAudience = await verifyGovernanceAuthorization(
    w.options(await token(), { expectedAudience: SELLER + 'x' })
  );
  assert.equal(wrongAudience.error, 'governance_token_not_applicable');

  const expired = await sign(w.key.privateKey, w.key.kid, claims({ iat: T - 1000, exp: T - 700 }));
  assert.equal((await verifyGovernanceAuthorization(w.options(expired))).error, 'governance_token_expired');

  const replayStore = new InMemoryGovernanceReplayStore();
  const once = await token();
  assert.equal((await verifyGovernanceAuthorization(w.options(once, { replayStore }))).ok, true);
  assert.equal(
    (await verifyGovernanceAuthorization(w.options(once, { replayStore }))).error,
    'governance_token_replayed'
  );
});

// ------------------------------------------------------------------ history

test('history: a governance context signed by a key rotated out of the directory verifies from the archive', async () => {
  const retired = ed25519();
  const current = ed25519();
  const publicOf = k => ({ kty: 'OKP', crv: 'Ed25519', x: k.privateJwk.x, kid: k.kid });
  const w = await world({ directoryKeys: [current], archive: { keys: [publicOf(retired)] } });
  // Retained and long expired: online verification fails, historical verification passes.
  const token = await sign(
    retired.privateKey,
    retired.kid,
    claims({ iat: T - 86400 * 400, exp: T - 86400 * 400 + 600 })
  );
  assert.equal((await verifyGovernanceAuthorization(w.options(token))).ok, false);
  const historical = await verifyHistoricalGovernanceContext({
    token,
    expectedIssuer: ISSUER,
    webBotAuth: { ...w.webBotAuth, archive: w.archiveResolver },
  });
  assert.equal(historical.ok, true, historical.message);
  assert.equal(historical.keySource, 'archive');
  assert.equal(historical.claims.jti, JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).jti);

  // A current key verifies historically from the directory.
  const fromDirectory = await verifyHistoricalGovernanceContext({
    token: await sign(current.privateKey, current.kid),
    expectedIssuer: ISSUER,
    webBotAuth: { ...w.webBotAuth, archive: w.archiveResolver },
  });
  assert.equal(fromDirectory.keySource, 'directory');
  assert.ok(w.fetched.includes(ORIGIN + '/.well-known/jwks-archive.json'));
});

test('history: the archive is read on the WBA rules and an absent archive holds no keys', async () => {
  const retired = ed25519();
  const publicOf = (k, extra = {}) => ({ kty: 'OKP', crv: 'Ed25519', x: k.privateJwk.x, kid: k.kid, ...extra });
  const token = await sign(retired.privateKey, retired.kid);
  const run = async archive => {
    const w = await world({ archive });
    return verifyHistoricalGovernanceContext({
      token,
      expectedIssuer: ISSUER,
      webBotAuth: { ...w.webBotAuth, archive: w.archiveResolver },
    });
  };
  // No archive: the kid is unknown.
  assert.equal((await run(404)).error, 'governance_key_unknown');
  // A kid that is not the thumbprint is ignored.
  assert.equal((await run({ keys: [publicOf(retired, { kid: 'gov-2025' })] })).error, 'governance_key_unknown');
  // An archive that publishes private key material is refused outright.
  const leaked = await run({ keys: [publicOf(retired, { d: retired.privateJwk.d })] });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.error, 'governance_key_unknown');
  // An archive outage is unavailability, not absence.
  await assert.rejects(
    (async () => {
      const w = await world({ archive: 503 });
      return w.archiveResolver.resolve(ORIGIN, retired.kid);
    })(),
    error => error instanceof identity.JwsArtifactError && error.code === 'jws_key_unavailable'
  );
  // Purpose members on an archived key are irrelevant on the WBA path.
  assert.equal(
    (await run({ keys: [publicOf(retired, { use: 'enc', key_ops: ['encrypt'], adcp_use: 'request-signing' })] })).ok,
    true
  );
});

test("history: a kid the origin's list revokes is invalid for every token it signed", async () => {
  const listSigner = ed25519();
  const retired = ed25519();
  const w = await world({
    directoryKeys: [listSigner],
    revoked: [retired.kid],
    archive: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: retired.privateJwk.x }] },
  });
  const result = await verifyHistoricalGovernanceContext({
    token: await sign(retired.privateKey, retired.kid),
    expectedIssuer: ISSUER,
    webBotAuth: { ...w.webBotAuth, archive: w.archiveResolver },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'governance_token_revoked');
});

test('history: an issuer on the 3.2 profile is reported, not verified', async () => {
  const w = await world({ records: {} });
  const result = await verifyHistoricalGovernanceContext({
    token: await sign(w.key.privateKey, w.key.kid),
    expectedIssuer: ISSUER,
    webBotAuth: { ...w.webBotAuth, archive: w.archiveResolver },
  });
  assert.equal(result.ok, false);
  assert.equal(result.profile, '3.2');
});

// ------------------------------------------- other artifacts use the primitive

test('designated-task responses and rights attestations select and verify on the same rule', async () => {
  // O is agent_url for a designated-task response and rights_agent.url for a
  // rights attestation; the caller passes it from its own context.
  const w = await world();
  for (const typ of ['adcp-response-payload+jws', 'adcp-rights-attestation+jws']) {
    const token = await new CompactSign(Buffer.from(JSON.stringify({ agent_url: ORIGIN + '/mcp' })))
      .setProtectedHeader({ alg: 'EdDSA', kid: w.key.kid, typ })
      .sign(w.key.privateKey);
    const profile = await identity.selectJwsArtifactProfile(ORIGIN + '/mcp', w.trust);
    assert.equal(profile.profile, 'web-bot-auth');
    const verified = await identity.verifyWebBotAuthJwsArtifact(token, profile.origin, { directory: w.directory });
    assert.equal(verified.protectedHeader.typ, typ);
    assert.equal(verified.kid, w.key.kid);
    assert.equal(verified.keySource, 'directory');
  }
});
