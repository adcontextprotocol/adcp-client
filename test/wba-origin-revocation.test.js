/**
 * Experimental AdCP 3.3 origin revocation lists with RFC 5280
 * revocation_details: retained history, most severe detail, never
 * un-revoke, fail closed, bounded admission.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const {
  OriginRevocationChecker,
  StaticWebBotAuthKeys,
  WebBotAuthError,
  mergeRevocationDetails,
  parseRevocationListPayload,
  publicDirectoryKey,
  revocationExposes,
  RevocationHistory,
} = require('../dist/lib/signing/server.js');

const ORIGIN = 'https://buyer.example.com';
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const iso = seconds => new Date(seconds * 1000).toISOString();
// Web Bot Auth revocation entries are RFC 7638 thumbprints (43 base64url chars).
const kid = name => name.padEnd(43, 'a');

function signer(origin = ORIGIN) {
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const jwk = publicDirectoryKey(privateKey);
  const listJws = (payload, { form = 'compact', header = {} } = {}) => {
    const protectedHeader = b64({ alg: 'EdDSA', kid: jwk.kid, typ: 'adcp-gov-revocation+jws', ...header });
    const body = b64({ version: 1, issuer: origin, revoked_kids: [], revoked_jtis: [], ...payload });
    const signature = sign(null, Buffer.from(`${protectedHeader}.${body}`), privateKey).toString('base64url');
    if (form === 'flattened') return JSON.stringify({ payload: body, protected: protectedHeader, signature });
    if (form === 'general')
      return JSON.stringify({ payload: body, signatures: [{ protected: protectedHeader, signature }] });
    return `${protectedHeader}.${body}.${signature}`;
  };
  return { privateKey, jwk, listJws };
}

function checker(lists, { now, origin = ORIGIN, key = signer(origin), ...options } = {}) {
  const calls = [];
  const clock = now ?? { t: 1000 };
  const instance = new OriginRevocationChecker(new StaticWebBotAuthKeys({ [origin]: [key.jwk] }), {
    now: () => clock.t,
    fetch: async url => {
      calls.push(url);
      const next = typeof lists === 'function' ? lists(clock.t) : lists;
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? { status: 200, body: next } : next;
    },
    ...options,
  });
  return { instance, calls, clock, key };
}

describe('revocation details (RFC 5280)', () => {
  it('keeps keyCompromise and the earliest invalidity_date; never weakens', () => {
    const merged = mergeRevocationDetails(
      { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' },
      { reason: 'superseded', invalidity_date: '2026-10-12T00:00:00Z' }
    );
    assert.deepEqual(merged, { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' });
    assert.deepEqual(mergeRevocationDetails({ reason: 'superseded' }, { reason: 'keyCompromise' }), {
      reason: 'keyCompromise',
    });
    assert.deepEqual(
      mergeRevocationDetails(
        { invalidity_date: '2026-10-12T00:00:00Z' },
        { invalidity_date: '2026-10-10T23:00:00+01:00' }
      ),
      { invalidity_date: '2026-10-10T23:00:00+01:00' }
    );
  });

  it('exposes by seller receipt time, only for keyCompromise', () => {
    const day = ms => Date.parse(ms) / 1000;
    const detail = { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' };
    assert.equal(revocationExposes(detail, day('2026-10-11T00:00:00Z')), true);
    assert.equal(revocationExposes(detail, day('2026-10-10T00:00:00Z')), false);
    assert.equal(revocationExposes({ reason: 'keyCompromise' }, 0), true);
    assert.equal(revocationExposes({ reason: 'superseded' }, day('2027-01-01T00:00:00Z')), false);
    assert.equal(revocationExposes(undefined, 0), false);
  });

  it('validates payloads: issuer, identifiers, details only for revoked kids, reasons, timestamps, cadence', () => {
    const base = { version: 1, issuer: ORIGIN, updated: iso(1000), next_update: iso(1060) };
    assert.ok(
      parseRevocationListPayload(
        { ...base, revoked_kids: [kid('k')], revocation_details: { [kid('k')]: { reason: 'superseded' } } },
        ORIGIN
      )
    );
    assert.throws(
      () => parseRevocationListPayload({ ...base, revoked_kids: ['short'] }, ORIGIN, { thumbprintKids: true }),
      TypeError
    );
    for (const bad of [
      { ...base, issuer: 'https://other.example.com' },
      { ...base, revoked_kids: [1] },
      { ...base, revoked_kids: [], revocation_details: { k: {} } },
      { ...base, revoked_kids: [kid('k')], revocation_details: { [kid('k')]: { reason: 'oops' } } },
      { ...base, revoked_kids: [kid('k')], revocation_details: { [kid('k')]: { invalidity_date: '2026-10-11' } } },
      { ...base, next_update: iso(1030) },
      { ...base, version: 0 },
    ]) {
      assert.throws(() => parseRevocationListPayload(bad, ORIGIN), TypeError, JSON.stringify(bad));
    }
  });

  it('history only ever grows', () => {
    const history = new RevocationHistory();
    history.merge({
      revoked_kids: ['a'],
      revoked_jtis: ['j'],
      revocation_details: { a: { reason: 'keyCompromise' } },
    });
    history.merge({ revoked_kids: [], revoked_jtis: [], revocation_details: {} });
    assert.equal(history.isRevoked('a'), true);
    assert.equal(history.isJtiRevoked('j'), true);
    assert.deepEqual(history.detailsFor('a'), { reason: 'keyCompromise' });
  });
});

describe('OriginRevocationChecker', () => {
  for (const form of ['compact', 'flattened', 'general']) {
    it(`verifies a ${form} JWS list from the origin's directory key`, async () => {
      const key = signer();
      const { instance, calls } = checker(
        key.listJws({ updated: iso(1000), next_update: iso(1300), revoked_kids: [kid('gone')] }, { form }),
        { key }
      );
      assert.equal(await instance.isRevoked(ORIGIN, kid('gone')), true);
      assert.equal(await instance.isRevoked(ORIGIN, key.jwk.kid), false);
      assert.deepEqual(calls, [`${ORIGIN}/.well-known/governance-revocations.json`]);
    });
  }

  it('rejects lists signed by another key, with another typ, or for another issuer', async () => {
    const key = signer();
    const stranger = signer();
    for (const body of [
      stranger.listJws({ updated: iso(1000), next_update: iso(1300) }),
      key.listJws({ updated: iso(1000), next_update: iso(1300) }, { header: { typ: 'JWT' } }),
      key.listJws({ updated: iso(1000), next_update: iso(1300), issuer: 'https://other.example.com' }),
      key.listJws({ updated: iso(1000), next_update: iso(1300) }, { header: { alg: 'none' } }),
    ]) {
      const { instance } = checker(body, { key });
      await assert.rejects(
        instance.isRevoked(ORIGIN, kid('k')),
        error => error instanceof WebBotAuthError && error.status === 403
      );
    }
  });

  it('never un-revokes and keeps the most severe detail across refreshes', async () => {
    const key = signer();
    const lists = [
      key.listJws({
        updated: iso(1000),
        next_update: iso(1060),
        revoked_kids: [kid('old')],
        revocation_details: { [kid('old')]: { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' } },
      }),
      key.listJws({
        updated: iso(1060),
        next_update: iso(1120),
        revoked_kids: [kid('old')],
        revocation_details: { [kid('old')]: { reason: 'superseded', invalidity_date: '2026-10-12T00:00:00Z' } },
      }),
      key.listJws({ updated: iso(1120), next_update: iso(1180), revoked_kids: [] }),
    ];
    let index = 0;
    const { instance, clock, calls } = checker(() => lists[Math.min(index++, lists.length - 1)], { key });
    assert.equal(await instance.isRevoked(ORIGIN, kid('old')), true);
    clock.t = 1061;
    assert.equal(await instance.isRevoked(ORIGIN, kid('old')), true);
    clock.t = 1121;
    assert.equal(await instance.isRevoked(ORIGIN, kid('old')), true, 'an empty list cannot un-revoke');
    assert.equal(calls.length, 3);
    assert.deepEqual(instance.revocationDetails(ORIGIN, kid('old')), {
      reason: 'keyCompromise',
      invalidity_date: '2026-10-11T00:00:00Z',
    });
    assert.equal(instance.exposes(ORIGIN, kid('old'), Date.parse('2026-10-11T12:00:00Z') / 1000), true);
    assert.equal(instance.exposes(ORIGIN, kid('old'), Date.parse('2026-10-10T12:00:00Z') / 1000), false);
  });

  it('refuses to roll back to an older list and fails closed past next_update + grace', async () => {
    const key = signer();
    let body = key.listJws({ updated: iso(1000), next_update: iso(1060), revoked_kids: [kid('x')] });
    const { instance, clock } = checker(() => body, { key });
    await instance.isRevoked(ORIGIN, kid('x'));
    body = key.listJws({ updated: iso(900), next_update: iso(960), revoked_kids: [] });
    clock.t = 1100;
    assert.equal(await instance.isRevoked(ORIGIN, kid('x')), true, 'stale list kept within grace');
    clock.t = 1060 + 4 * 60 + 1;
    await assert.rejects(instance.isRevoked(ORIGIN, kid('x')), /stale/);
  });

  it('caches a failed first discovery for 60 s without admitting the origin', async () => {
    const key = signer();
    let fail = true;
    const { instance, calls, clock } = checker(
      () => (fail ? new Error('offline') : key.listJws({ updated: iso(clock.t), next_update: iso(clock.t + 60) })),
      { key, maxOrigins: 1 }
    );
    for (let i = 0; i < 2; i++) await assert.rejects(instance.isRevoked(ORIGIN, kid('k')), WebBotAuthError);
    assert.equal(calls.length, 1);
    fail = false;
    clock.t = 1061;
    assert.equal(await instance.isRevoked(ORIGIN, kid('k')), false, 'the failed discovery consumed no admission slot');
  });

  it('evicts unpinned origins at capacity but never a pinned (bound) one', async () => {
    const origins = ['https://a.agency.com', 'https://b.agency.com', 'https://c.agency.com', 'https://d.other.com'];
    const keys = Object.fromEntries(origins.map(origin => [origin, signer(origin)]));
    let fetches = 0;
    const instance = new OriginRevocationChecker(
      new StaticWebBotAuthKeys(Object.fromEntries(origins.map(origin => [origin, [keys[origin].jwk]]))),
      {
        now: () => 1000,
        maxOriginsPerOperator: 1,
        fetch: async url => {
          fetches++;
          return {
            status: 200,
            body: keys[new URL(url).origin].listJws({ updated: iso(1000), next_update: iso(1300) }),
          };
        },
      }
    );
    await instance.isRevoked(origins[0], kid('k'));
    // a.agency.com is unpinned and has nothing to forget: evicted for b.
    assert.equal(await instance.isRevoked(origins[1], kid('k')), false);
    instance.pin(origins[1]);
    await assert.rejects(instance.isRevoked(origins[2], kid('k')), error => error.status === 429);
    assert.equal(await instance.isRevoked(origins[3], kid('k')), false, 'another operator still has room');
    const before = fetches;
    await instance.isRevoked(origins[1], kid('k'));
    assert.equal(fetches, before, 'the pinned origin kept its state');
  });

  it('shares one first discovery across concurrent callers', async () => {
    const key = signer();
    const { instance, calls } = checker(key.listJws({ updated: iso(1000), next_update: iso(1300) }), { key });
    await Promise.all([instance.isRevoked(ORIGIN, kid('a')), instance.isRevoked(ORIGIN, kid('b'))]);
    assert.equal(calls.length, 1);
  });
});

describe('OriginRevocationChecker review regressions', () => {
  it('measures staleness against the signed next_update for long cadences', async () => {
    const key = signer();
    const T = 10_000;
    const body = key.listJws({ updated: iso(T), next_update: iso(T + 86_400), revoked_kids: [] });
    const { instance, clock } = checker(() => body, { key, now: { t: T } });
    for (const t of [T, T + 6 * 3600, T + 23 * 3600, T + 86_400 + 4 * 1800]) {
      clock.t = t;
      assert.equal(await instance.isRevoked(ORIGIN, kid('k')), false, `fresh at ${t - T}s`);
    }
    clock.t = T + 86_400 + 4 * 1800 + 1;
    await assert.rejects(instance.isRevoked(ORIGIN, kid('k')), /stale/);
  });

  it('refuses an already-stale list on first discovery without taking a slot', async () => {
    const stale = signer();
    const fresh = signer('https://fresh.example.com');
    const instance = new OriginRevocationChecker(
      new StaticWebBotAuthKeys({ [ORIGIN]: [stale.jwk], 'https://fresh.example.com': [fresh.jwk] }),
      {
        now: () => 100_000,
        maxOrigins: 1,
        fetch: async url =>
          new URL(url).origin === ORIGIN
            ? { status: 200, body: stale.listJws({ updated: iso(1000), next_update: iso(1060) }) }
            : { status: 200, body: fresh.listJws({ updated: iso(100_000), next_update: iso(100_300) }) },
      }
    );
    await assert.rejects(instance.isRevoked(ORIGIN, kid('k')), WebBotAuthError);
    assert.equal(await instance.isRevoked('https://fresh.example.com', kid('k')), false);
  });

  it('lets concurrent callers join a refresh in progress past grace', async () => {
    const key = signer();
    let release;
    let slow = false;
    const { instance, clock } = checker(
      t => {
        const body = key.listJws({ updated: iso(t), next_update: iso(t + 60) });
        if (!slow) return body;
        return new Promise(resolve => (release = () => resolve({ status: 200, body })));
      },
      { key }
    );
    await instance.isRevoked(ORIGIN, kid('k'));
    slow = true;
    clock.t = 1000 + 60 + 4 * 60 + 5; // past next_update + grace
    const both = Promise.all([instance.isRevoked(ORIGIN, kid('k')), instance.isRevoked(ORIGIN, kid('k'))]);
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.deepEqual(await both, [false, false]);
  });

  it('bounds retained history: a list that would exceed it fails closed', async () => {
    const key = signer();
    let n = 0;
    const { instance, clock } = checker(
      t => {
        const kids = Array.from({ length: 1000 }, (_, i) => kid(`r${n}x${i}`));
        n++;
        return key.listJws({ updated: iso(t), next_update: iso(t + 60), revoked_kids: kids });
      },
      { key }
    );
    await instance.isRevoked(ORIGIN, kid('k'));
    for (let i = 0; i < 5; i++) {
      clock.t += 61;
      await instance.isRevoked(ORIGIN, kid('k')).catch(() => undefined);
    }
    clock.t += 4 * 60 + 61;
    await assert.rejects(instance.isRevoked(ORIGIN, kid('k')), /stale/, 'refused lists never refresh the status');
  });
});

describe('revocation details severity', () => {
  it('never lets a later dated compromise or an unrelated date weaken an undated compromise', () => {
    const undated = mergeRevocationDetails(
      { reason: 'keyCompromise' },
      { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' }
    );
    assert.deepEqual(undated, { reason: 'keyCompromise' });
    assert.equal(revocationExposes(undated, Date.parse('2026-09-01T00:00:00Z') / 1000), true);
    assert.deepEqual(
      mergeRevocationDetails(
        { reason: 'superseded', invalidity_date: '2026-01-01T00:00:00Z' },
        { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' }
      ),
      { reason: 'keyCompromise', invalidity_date: '2026-10-11T00:00:00Z' }
    );
  });
});
