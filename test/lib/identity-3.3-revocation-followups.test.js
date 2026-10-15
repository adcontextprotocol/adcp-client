// Regression tests for origin revocation follow-ups to #3244 (refs #3233).
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('crypto');
const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3');
const { mergeRevocationDetails } = require('../../dist/lib/signing/revocation');

const T = 1790841610;
const iso = seconds => new Date(seconds * 1000).toISOString();

async function originFixture(origin) {
  const { CompactSign } = await import('jose');
  const pair = generateKeyPairSync('ed25519');
  const priv = pair.privateKey.export({ format: 'jwk' });
  const kid = wba.jwkThumbprint(priv);
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: { ...priv, kid } }], {
    now: () => T - 60,
    lifetimeSeconds: 3 * 86400,
  });
  const sign = snapshot =>
    new CompactSign(Buffer.from(JSON.stringify({ issuer: origin, revoked_kids: [], ...snapshot })))
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'adcp-gov-revocation+jws' })
      .sign(pair.privateKey);
  return { kid, proof, sign };
}

function resolverFor({ proof }, clock, serve, extra = {}) {
  const directory = new wba.SignatureDirectoryResolver({
    now: clock,
    fetchOptions: {
      trustedFetchFn: async () => new Response(proof.body, { status: 200, headers: proof.headers }),
    },
  });
  return new identity.OriginRevocationResolver({
    store: new identity.InMemoryOriginRevocationStore(),
    directory,
    now: clock,
    fetchOptions: { trustedFetchFn: serve },
    ...extra,
  });
}

test('R1: staleness follows the signed next_update, not the polling ceiling', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  // Daily cadence, served unchanged for its whole lifetime.
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 86400), revoked_kids: [] });
  let clock = T,
    fetches = 0;
  const serve = async () => {
    fetches++;
    return new Response(body);
  };
  const resolver = resolverFor(fixture, () => clock, serve);
  for (const hours of [0, 6, 23]) {
    clock = T + hours * 3600;
    assert.equal(await resolver.isRevoked(origin, fixture.kid), false, `valid at T+${hours}h`);
  }
  // The ceiling still drives polling: each check past the interval refetched.
  assert.equal(fetches, 3);
  clock = T + 86400 - 60;
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
  // Inside grace after next_update: the unchanged list no longer refreshes, but grace holds.
  clock = T + 86400 + 60;
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
  // Past next_update + 4 × polling interval: stale, fail closed.
  clock = T + 86400 + 4 * 300 + 1;
  await assert.rejects(resolver.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
});

test('R1: an outage cannot stretch a long-cadence list past the polling ceiling plus grace', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 86400) });
  let clock = T,
    down = false;
  const serve = async () => {
    if (down) throw new Error('offline');
    return new Response(body);
  };
  const resolver = resolverFor(fixture, () => clock, serve);
  clock = T + 3600;
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
  down = true;
  clock = T + 3600 + 1800 + 4 * 300 - 1;
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
  clock = T + 3600 + 1800 + 4 * 300 + 1;
  await assert.rejects(resolver.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
});

test('R1: a list whose updated is slightly ahead of the verifier clock is accepted', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  const body = await fixture.sign({ updated: iso(T + 30), next_update: iso(T + 330) });
  const resolver = resolverFor(
    fixture,
    () => T,
    async () => new Response(body)
  );
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
  const ahead = await fixture.sign({ updated: iso(T + 120), next_update: iso(T + 420) });
  const rejecting = resolverFor(
    fixture,
    () => T,
    async () => new Response(ahead)
  );
  await assert.rejects(rejecting.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
});

test('R2: an already-stale first list is refused without admitting the origin', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  const stale = await fixture.sign({ updated: iso(T - 7200), next_update: iso(T - 3600) });
  const fresh = await fixture.sign({ updated: iso(T + 60), next_update: iso(T + 360) });
  let clock = T,
    body = stale;
  const resolver = resolverFor(
    fixture,
    () => clock,
    async () => new Response(body)
  );
  await assert.rejects(resolver.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
  // The refusal left no grace behind: inside the negative cache the origin still fails closed.
  body = fresh;
  clock = T + 30;
  await assert.rejects(resolver.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
  clock = T + 61;
  assert.equal(await resolver.isRevoked(origin, fixture.kid), false);
});

function tarpitFetch(victim, body, tarpits) {
  return async url =>
    new URL(url).origin === victim
      ? new Response(body)
      : new Promise((_, reject) => tarpits.push(() => reject(new Error('released'))));
}
async function fillRefreshQueue(resolver, kid) {
  // Sixteen attacker-selected origins (two per registrable domain) tarpit their refreshes.
  for (let i = 0; i < 16; i++)
    resolver.isRevoked(`https://s${i % 2}.slow${Math.floor(i / 2)}.com`, kid).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
}

test('R3: a full refresh queue does not fail an origin still inside its outage grace', async () => {
  const victim = 'https://agent.example.com';
  const fixture = await originFixture(victim);
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 60), revoked_kids: [] });
  let clock = T;
  const tarpits = [];
  const resolver = resolverFor(fixture, () => clock, tarpitFetch(victim, body, tarpits), {
    pollingIntervalSeconds: 60,
  });
  assert.equal(await resolver.isRevoked(victim, fixture.kid), false);
  try {
    await fillRefreshQueue(resolver, fixture.kid);
    clock = T + 90; // past next_update, inside next_update + 4 × 60
    assert.equal(await resolver.isRevoked(victim, fixture.kid), false);
    clock = T + 60 + 240 + 1; // grace elapsed: the queue limit fails closed
    await assert.rejects(resolver.isRevoked(victim, fixture.kid), e => e.reason === 'revocation_unavailable');
  } finally {
    for (const release of tarpits) release();
  }
});

test('R3: a full refresh queue never grants grace after a persistence failure', async () => {
  const victim = 'https://agent.example.com';
  const fixture = await originFixture(victim);
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 120), revoked_kids: [] });
  let clock = T,
    failing = false;
  const tarpits = [];
  const store = new identity.InMemoryOriginRevocationStore();
  const resolver = resolverFor(fixture, () => clock, tarpitFetch(victim, body, tarpits), {
    pollingIntervalSeconds: 60,
    store: {
      merge: async (...args) => {
        if (failing) throw new Error('disk full');
        return store.merge(...args);
      },
      get: (...args) => store.get(...args),
    },
  });
  assert.equal(await resolver.isRevoked(victim, fixture.kid), false);
  try {
    failing = true;
    clock = T + 61;
    await assert.rejects(resolver.isRevoked(victim, fixture.kid), e => e.reason === 'revocation_persistence_failed');
    await fillRefreshQueue(resolver, fixture.kid);
    clock = T + 122; // persistence cool-down over, still inside the old list's grace
    await assert.rejects(resolver.isRevoked(victim, fixture.kid), e => e.reason === 'revocation_unavailable');
  } finally {
    for (const release of tarpits) release();
  }
});

test('R3: concurrent callers join one in-flight refresh', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 300) });
  let fetches = 0;
  const resolver = resolverFor(
    fixture,
    () => T,
    async () => {
      fetches++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(body);
    }
  );
  const results = await Promise.all(Array.from({ length: 8 }, () => resolver.isRevoked(origin, fixture.kid)));
  assert.deepEqual(results, Array(8).fill(false));
  assert.equal(fetches, 1);
});

test('R4/R5: one operator with wildcard subdomains cannot exhaust in-memory history for other operators', async () => {
  const store = new identity.InMemoryOriginRevocationStore({ perOrigin: 4, perOperator: 8, total: 15 });
  const snapshot = kids => ({ issuer: '', updated: '', next_update: '', revoked_kids: kids });
  await store.merge('https://a0.attacker.com', snapshot(['a', 'b', 'c', 'd']));
  await store.merge('https://a1.attacker.com', snapshot(['e', 'f', 'g', 'h']));
  await assert.rejects(
    store.merge('https://a2.attacker.com', snapshot(['i'])),
    e => e.reason === 'revocation_storage_limit'
  );
  // Other operators keep their own budget, and nothing already stored disappears.
  await store.merge('https://agent.victim.com', snapshot(['v']));
  assert.ok(await store.get('https://agent.victim.com', 'v'));
  assert.ok(await store.get('https://a0.attacker.com', 'a'));
  // Re-merging known kids consumes no further budget.
  await store.merge('https://a1.attacker.com', snapshot(['e', 'f', 'g', 'h']));
  // The total still bounds the store across operators.
  await store.merge('https://agent.other.com', snapshot(['o1', 'o2', 'o3']));
  await assert.rejects(
    store.merge('https://agent.third.com', snapshot(['t1', 't2', 't3', 't4'])),
    e => e.reason === 'revocation_storage_limit'
  );
  // Explicit undefined keeps the default; non-positive limits are refused.
  assert.throws(() => new identity.InMemoryOriginRevocationStore({ perOperator: 0 }), TypeError);
  const defaults = new identity.InMemoryOriginRevocationStore({
    perOrigin: 1,
    perOperator: undefined,
    total: undefined,
  });
  await defaults.merge('https://x.example.com', snapshot(['one']));
  await assert.rejects(defaults.merge('https://x.example.com', snapshot(['two'])));
});

test('R7: an undated keyCompromise is never narrowed by a dated entry', () => {
  const undated = { reason: 'keyCompromise' };
  const dated = { reason: 'keyCompromise', invalidity_date: '2026-06-01T00:00:00Z' };
  assert.deepEqual(mergeRevocationDetails(undated, dated), undated);
  assert.deepEqual(mergeRevocationDetails(dated, undated), undated);
  assert.deepEqual(
    mergeRevocationDetails(undated, { reason: 'superseded', invalidity_date: dated.invalidity_date }),
    undated
  );
  // Dated compromises keep the earliest date; nothing weakens the reason.
  assert.deepEqual(
    mergeRevocationDetails(dated, { reason: 'keyCompromise', invalidity_date: '2026-07-01T00:00:00Z' }),
    dated
  );
  assert.deepEqual(mergeRevocationDetails(dated, { reason: 'superseded' }), dated);
  // A prior non-compromise entry does not make a later compromise undated.
  assert.deepEqual(mergeRevocationDetails({ reason: 'superseded' }, dated), dated);
});

test('R7: the origin resolver stores an undated compromise through a later dated list', async () => {
  const store = new identity.InMemoryOriginRevocationStore();
  const origin = 'https://agent.example.com';
  const base = { issuer: origin, updated: '', next_update: '', revoked_kids: ['k'] };
  await store.merge(origin, { ...base, revocation_details: { k: { reason: 'keyCompromise' } } });
  await store.merge(origin, {
    ...base,
    revocation_details: { k: { reason: 'keyCompromise', invalidity_date: '2026-06-01T00:00:00Z' } },
  });
  assert.deepEqual(await store.get(origin, 'k'), { reason: 'keyCompromise' });
});

test('status(): revoked, current, absent (404/410), unknown, and persistence outages are distinct', async () => {
  const origin = 'https://agent.example.com';
  const fixture = await originFixture(origin);
  const revokedKid = 'r'.repeat(43);
  const body = await fixture.sign({ updated: iso(T), next_update: iso(T + 300), revoked_kids: [revokedKid] });
  let clock = T,
    serve = async () => new Response(body);
  const resolver = resolverFor(
    fixture,
    () => clock,
    async (...args) => serve(...args)
  );
  assert.equal(await resolver.status(origin, fixture.kid), 'current');
  assert.equal(await resolver.status(origin, revokedKid), 'revoked');
  // The origin stops serving a list: established, but no spend binding.
  serve = async () => new Response('', { status: 404 });
  clock = T + 301;
  assert.equal(await resolver.status(origin, fixture.kid), 'absent');
  assert.equal(await resolver.status(origin, revokedKid), 'revoked');
  await assert.rejects(resolver.isRevoked(origin, fixture.kid), e => e.reason === 'revocation_unavailable');
  // A list that cannot be verified past grace: identity not established.
  const other = 'https://other.example.com';
  const otherFixture = await originFixture(other);
  const down = resolverFor(
    otherFixture,
    () => T,
    async () => {
      throw new Error('offline');
    }
  );
  assert.equal(await down.status(other, otherFixture.kid), 'unknown');
  // History-store failure is an infrastructure outage, not a revocation outcome.
  const broken = resolverFor(
    otherFixture,
    () => T,
    async () => new Response(body),
    {
      store: {
        merge: async () => {},
        get: async () => {
          throw new Error('disk offline');
        },
      },
    }
  );
  await assert.rejects(broken.status(other, otherFixture.kid), e => e.reason === 'revocation_persistence_failed');
});
