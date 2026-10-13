/**
 * Experimental AdCP 3.3 trust-record evaluation (R3a) and demand-side grants
 * (R6, DR-0025). Ports adcp-client-python#1502's regression set.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  OriginBindings,
  TrustGrantEvaluator,
  TrustRecordAbsentError,
  TrustRecordError,
  TrustRecordEvaluator,
  grantAbsentError,
  requireGrant,
  trustRecordUrl,
  validateTrustRecord,
  identityPreviewSchemaErrors,
} = require('../dist/lib/signing/server.js');

const ORIGIN = 'https://buyer.platform.com';
const SIGNER_RECORD = { agents: [{ url: `${ORIGIN}/mcp`, roles: ['adcp:buying'] }] };

function records(documents, clock = () => 1000, options = {}) {
  const calls = [];
  const evaluator = new TrustRecordEvaluator({
    now: clock,
    fetch: async url => {
      calls.push(url);
      const document = typeof documents === 'function' ? documents(url) : documents[url];
      if (document instanceof Error) throw document;
      if (document && typeof document.status === 'number') return document;
      return document === undefined || document === null
        ? { status: 404, body: '' }
        : { status: 200, body: JSON.stringify(document) };
    },
    ...options,
  });
  return { evaluator, calls };
}

const grant = (grantee, changes = {}) => ({ grantee, scopes: ['adcp:media_buying'], ...changes });

async function check(documents, { operator = 'agency.com', ...changes } = {}) {
  const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD, ...documents });
  return new TrustGrantEvaluator(evaluator, { now: () => 1000 }).check({
    agentOrigin: ORIGIN,
    brandDomain: 'brand.com',
    accountOperator: operator,
    ...changes,
  });
}

describe('trust record derivation', () => {
  it('derives the record from the pinned ICANN+PRIVATE PSL', () => {
    assert.equal(trustRecordUrl('https://buyer.agency.co.uk/mcp'), 'https://agency.co.uk/.well-known/trust.json');
    assert.equal(trustRecordUrl('https://buyer.team.github.io/mcp'), 'https://team.github.io/.well-known/trust.json');
    assert.equal(trustRecordUrl('https://xn--bcher-kva.de/mcp'), 'https://xn--bcher-kva.de/.well-known/trust.json');
  });

  it('flags PSL PRIVATE-section operators (sandbox-only under open onboarding)', () => {
    const { isPrivateSuffixOperator } = require('../dist/lib/signing/server.js');
    assert.equal(isPrivateSuffixOperator('https://buyer.team.github.io'), true);
    assert.equal(isPrivateSuffixOperator('https://buyer.agency.co.uk'), false);
  });

  for (const origin of ['https://localhost/mcp', 'https://127.0.0.1', 'https://co.uk', 'https://[2001:db8::1]']) {
    it(`gives ${origin} no operator record`, () => {
      assert.throws(() => trustRecordUrl(origin), TrustRecordError);
    });
  }
});

describe('validateTrustRecord (authoring)', () => {
  for (const [name, document] of [
    ['keys in an agent entry', { agents: [{ url: ORIGIN, roles: ['adcp:buying'], jwks_uri: `${ORIGIN}/keys` }] }],
    [
      'two agents at one origin',
      {
        agents: [
          { url: ORIGIN, roles: ['adcp:buying'] },
          { url: `${ORIGIN}/mcp`, roles: ['adcp:sales'] },
        ],
      },
    ],
    ['an agent of another operator', { agents: [{ url: 'https://attacker.com', roles: ['adcp:buying'] }] }],
    ['userinfo', { agents: [{ url: 'https://user@platform.com', roles: ['adcp:buying'] }] }],
    ['a grantee that is not a registrable domain', { grants: [grant('seat.agency.com')] }],
    ['an unknown adcp role', { agents: [{ url: ORIGIN, roles: ['adcp:wizard'] }] }],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateTrustRecord(document, { operatorDomain: 'platform.com' }), TrustRecordError);
    });
  }

  it('accepts a valid record with buyer onboarding posture and does not mutate input', () => {
    const document = {
      agents: [{ url: ORIGIN, roles: ['adcp:buying'], profiles: { adcp: { onboarding: { mode: 'application' } } } }],
      grants: [grant('agency.com', { agents: [{ url: ORIGIN }] })],
    };
    const copy = validateTrustRecord(document, { operatorDomain: 'platform.com' });
    copy.agents.pop();
    assert.equal(document.agents.length, 1);
    assert.deepEqual(
      identityPreviewSchemaErrors({ mode: 'considers_unsolicited' }, 'core/buyer-onboarding-posture.json'),
      []
    );
  });
});

describe('TrustRecordEvaluator', () => {
  it('follows one authoritative_location hop and keeps the original owner', async () => {
    const { evaluator, calls } = records({
      [trustRecordUrl(ORIGIN)]: { authoritative_location: 'https://hosting.com/trust.json' },
      'https://hosting.com/trust.json': SIGNER_RECORD,
    });
    const record = await evaluator.evaluate(ORIGIN, { role: 'adcp:buying' });
    assert.equal(record.operatorDomain, 'platform.com');
    assert.equal(record.sourceUrl, 'https://hosting.com/trust.json');
    assert.equal(calls.length, 2);
    record.document.agents.length = 0;
    await evaluator.evaluate(ORIGIN, { role: 'adcp:buying' });
    await assert.rejects(evaluator.evaluate(ORIGIN, { role: 'adcp:governance' }), /required role/);
  });

  it('never follows a second hop or an HTTP redirect', async () => {
    const { evaluator } = records({
      [trustRecordUrl(ORIGIN)]: { authoritative_location: 'https://hosting.com/trust.json' },
      'https://hosting.com/trust.json': { authoritative_location: 'https://third.com/trust.json' },
    });
    await assert.rejects(evaluator.evaluate(ORIGIN), /second authoritative-location hop/);
    const redirect = records({ [trustRecordUrl(ORIGIN)]: { status: 302, body: '' } }).evaluator;
    await assert.rejects(redirect.evaluate(ORIGIN), TrustRecordError);
  });

  for (const target of [
    'https://hosting.com:99999/trust.json',
    'https://user@hosting.com/trust.json',
    'http://hosting.com/trust.json',
  ]) {
    it(`treats an invalid hop target (${target}) as a closed failure without fetching it`, async () => {
      const { evaluator, calls } = records({ [trustRecordUrl(ORIGIN)]: { authoritative_location: target } });
      await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordError);
      assert.equal(calls.length, 1);
    });
  }

  for (const [name, body] of [
    ['duplicate keys', '{"agents":[],"agents":[]}'],
    ['NaN', '{"agents":NaN}'],
    ['oversized', ' '.repeat(2 * 1024 * 1024 + 1)],
    ['deep nesting', `{"ext":${'{"a":'.repeat(40)}1${'}'.repeat(40)}}`],
  ]) {
    it(`fails closed on ${name}`, async () => {
      const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: { status: 200, body } });
      await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordError);
    });
  }

  it('caches for the polling interval, then fails closed; a later 404 is not absence', async () => {
    let now = 1000;
    const documents = { [trustRecordUrl(ORIGIN)]: SIGNER_RECORD };
    const { evaluator, calls } = records(documents, () => now);
    await evaluator.evaluate(ORIGIN);
    await evaluator.evaluate(ORIGIN);
    assert.equal(calls.length, 1);
    now = 1061;
    documents[trustRecordUrl(ORIGIN)] = new Error('offline');
    await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordError);
    now = 1200;
    documents[trustRecordUrl(ORIGIN)] = null;
    await assert.rejects(evaluator.evaluate(ORIGIN), error => {
      assert.ok(error instanceof TrustRecordError);
      assert.ok(!(error instanceof TrustRecordAbsentError), 'a host that served 200 never becomes absent');
      return true;
    });
    assert.equal(evaluator.hasPublished(ORIGIN), true);
  });

  it('expires negative entries within 60 s', async () => {
    let now = 1000;
    const { evaluator, calls } = records({}, () => now);
    await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordAbsentError);
    await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordAbsentError);
    assert.equal(calls.length, 1);
    now = 1061;
    await assert.rejects(evaluator.evaluate(ORIGIN), TrustRecordAbsentError);
    assert.equal(calls.length, 2);
  });

  it('rejects a record that expired while it was being fetched', async () => {
    let now = 1000;
    const evaluator = new TrustRecordEvaluator({
      now: () => now,
      fetch: async () => {
        now += 61;
        return { status: 200, body: JSON.stringify(SIGNER_RECORD) };
      },
    });
    await assert.rejects(evaluator.evaluate(ORIGIN, { role: 'adcp:buying' }), /expired/);
    const result = await new TrustGrantEvaluator(evaluator).check({
      agentOrigin: ORIGIN,
      brandDomain: 'platform.com',
      accountOperator: 'platform.com',
    });
    assert.equal(result.authorized, false);
  });

  it('coalesces concurrent fetches and does not block another operator', async () => {
    let release;
    const gate = new Promise(resolve => (release = resolve));
    const calls = [];
    const evaluator = new TrustRecordEvaluator({
      now: () => 1000,
      fetch: async url => {
        calls.push(url);
        if (url.includes('slow.com')) await gate;
        return { status: 200, body: JSON.stringify({ agents: [] }) };
      },
    });
    const a = evaluator.evaluate('https://x.slow.com');
    const b = evaluator.evaluate('https://y.slow.com');
    await evaluator.evaluate('https://fast.com');
    release();
    await Promise.all([a, b]);
    assert.equal(calls.filter(url => url.includes('slow.com')).length, 1);
  });

  it('keeps unknown onboarding requirement kinds for readers but rejects them on authoring', async () => {
    const posture = {
      mode: 'application',
      requirements: [{ kind: 'future_identity_badge', future_property: 'opaque' }],
      message: 'Ask a human to review this application',
    };
    const document = { agents: [{ url: ORIGIN, roles: ['adcp:buying'], profiles: { adcp: { onboarding: posture } } }] };
    const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: document });
    const record = await evaluator.evaluate(ORIGIN, { role: 'adcp:buying' });
    assert.deepEqual(record.document.agents[0].profiles.adcp.onboarding, posture);
    assert.throws(() => validateTrustRecord(document, { operatorDomain: 'platform.com' }), TrustRecordError);
    document.agents[0].roles = ['unknown:authority'];
    const bad = records({ [trustRecordUrl(ORIGIN)]: document }).evaluator;
    await assert.rejects(bad.evaluate(ORIGIN, { role: 'adcp:buying' }), TrustRecordError);
  });

  it('binds only after the operator lists the origin, once per origin', async () => {
    const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD });
    const bindings = new OriginBindings();
    const signer = { profile: 'web-bot-auth', origin: ORIGIN };
    await evaluator.bind(signer, { principalId: 'principal-1', bindings });
    assert.equal(await bindings.principalFor('https://BUYER.platform.com:443'), 'principal-1');
    await assert.rejects(evaluator.bind(signer, { principalId: 'principal-2', bindings }), /rebound/);
    await assert.rejects(
      evaluator.bind({ profile: 'web-bot-auth', origin: 'https://other.platform.com' }, { principalId: 'p', bindings }),
      TrustRecordError
    );
    await assert.rejects(evaluator.bind({ origin: ORIGIN }, { principalId: 'p', bindings }), /verified Web Bot Auth/);
  });

  it('requires explicit approval to bind onto an existing RFC 9421 principal', () => {
    const bindings = new OriginBindings();
    assert.throws(() => bindings.bindSync(ORIGIN, 'legacy-principal', { existingRfc9421Principal: true }), /approval/);
    bindings.bindSync(ORIGIN, 'legacy-principal', { existingRfc9421Principal: true, migrationApproved: true });
    assert.throws(() => bindings.bindSync(ORIGIN, 'other'), /rebound/);
  });
});

describe('TrustGrantEvaluator (DR-0025)', () => {
  it('grants implicit authority only on a shared registrable domain and requires the operator on the chain', async () => {
    const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD });
    assert.equal(
      (
        await new TrustGrantEvaluator(evaluator).check({
          agentOrigin: ORIGIN,
          brandDomain: 'platform.com',
          accountOperator: 'platform.com',
        })
      ).authorized,
      true
    );
    const docs = { [trustRecordUrl('brand.com')]: { grants: [grant('platform.com')] } };
    assert.equal((await check(docs, { operator: 'platform.com' })).authorized, true);
    assert.equal((await check(docs)).authorized, false, 'a grant to the signer never covers an operator off the chain');
  });

  it('requires the signer operator record to list the origin with adcp:buying', async () => {
    const { evaluator } = records({ [trustRecordUrl(ORIGIN)]: { agents: [{ url: ORIGIN, roles: ['adcp:sales'] }] } });
    const result = await new TrustGrantEvaluator(evaluator).check({
      agentOrigin: ORIGIN,
      brandDomain: 'platform.com',
      accountOperator: 'platform.com',
    });
    assert.deepEqual([result.authorized, result.reason], [false, 'signer_trust_record_unavailable']);
  });

  it('intersects brands, countries, agents and validity along a two-link chain', async () => {
    const docs = {
      [trustRecordUrl('brand.com')]: {
        grants: [
          grant('agency.com', {
            countries: ['US', 'CA'],
            profiles: { adcp: { brands: ['brand_1'] } },
            valid_until: '1970-01-01T00:30:00Z',
          }),
        ],
      },
      [trustRecordUrl('agency.com')]: {
        grants: [
          grant('platform.com', { countries: ['US'], agents: [{ url: ORIGIN }], valid_until: '1970-01-01T00:20:00Z' }),
        ],
      },
    };
    const accepted = await check(docs, { brandId: 'brand_1', countries: ['US'] });
    assert.equal(accepted.authorized, true);
    assert.ok(accepted.expiresAt <= 1200);
    assert.equal((await check(docs, { brandId: 'other', countries: ['US'] })).authorized, false);
    assert.equal((await check(docs, { brandId: 'brand_1', countries: ['CA'] })).authorized, false);
    assert.equal((await check(docs, { brandId: 'brand_1', countries: [] })).authorized, false);
    docs[trustRecordUrl('agency.com')].grants[0].valid_until = '1970-01-01T00:16:40Z';
    assert.equal((await check(docs, { brandId: 'brand_1', countries: ['US'] })).authorized, false);
    docs[trustRecordUrl('agency.com')].grants[0].valid_until = '1970-01-01T00:20:00Z';
    docs[trustRecordUrl('agency.com')].grants[0].agents = [{ url: 'https://other.platform.com' }];
    assert.equal((await check(docs, { brandId: 'brand_1', countries: ['US'] })).authorized, false);
  });

  it('honors valid_from and scope coverage, including adcp:all and *', async () => {
    const future = {
      [trustRecordUrl('brand.com')]: { grants: [grant('platform.com', { valid_from: '1970-01-01T01:00:00Z' })] },
    };
    assert.equal((await check(future, { operator: 'platform.com' })).authorized, false);
    for (const scopes of [['adcp:all'], ['*']]) {
      const docs = { [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes }] } };
      assert.equal((await check(docs, { operator: 'platform.com' })).authorized, true, scopes[0]);
    }
    const creativeOnly = {
      [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes: ['adcp:creative_generation'] }] },
    };
    assert.equal((await check(creativeOnly, { operator: 'platform.com' })).authorized, false);
  });

  it('never follows a third link or treats the operator record as brand authority', async () => {
    const docs = {
      [trustRecordUrl('brand.com')]: { grants: [grant('agency.com')] },
      [trustRecordUrl('agency.com')]: { grants: [grant('middle.com')] },
      [trustRecordUrl('middle.com')]: { grants: [grant('platform.com')] },
    };
    assert.equal((await check(docs)).authorized, false);
    docs[trustRecordUrl('brand.com')] = { agents: [] };
    docs[trustRecordUrl('agency.com')] = { grants: [grant('platform.com')] };
    const denied = await check(docs);
    assert.equal(denied.authorized, false);
    assert.equal(denied.legacyFallbackAllowed, false);
    assert.throws(
      () => requireGrant(denied),
      error => {
        assert.equal(error.code, 'PERMISSION_DENIED');
        assert.deepEqual(error.details, { scope: 'agent', reason: 'grant_absent' });
        return true;
      }
    );
  });

  it('makes exclusive_grants exhaustive and never consults brand.json after a 200', async () => {
    const docs = {
      [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
      [trustRecordUrl('brand.com')]: { grants: [grant('other.com')], exclusive_grants: true },
    };
    const called = [];
    const authorize = async request => {
      called.push(request);
      return true;
    };
    const build = () =>
      new TrustGrantEvaluator(records(docs).evaluator, {
        now: () => 1000,
        sellerAuthorization: authorize,
        legacyAuthorization: authorize,
      });
    const args = { agentOrigin: ORIGIN, brandDomain: 'brand.com', accountOperator: 'agency.com' };
    assert.equal((await build().check(args)).authorized, false);
    assert.equal(called.length, 0);
    docs[trustRecordUrl('brand.com')].exclusive_grants = false;
    assert.equal((await build().check(args)).authorized, true);
    assert.equal(called.length, 1, 'seller discretion, never brand.json');
  });

  it('reaches brand.json only while the brand has never published trust.json (404), never on fetch failure', async () => {
    const legacy = [];
    const legacyAuthorization = async request => {
      legacy.push(request);
      return true;
    };
    const absent = records({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD }).evaluator;
    const rfc9421 = await new TrustGrantEvaluator(absent, { legacyAuthorization }).check({
      agentOrigin: ORIGIN,
      brandDomain: 'brand.com',
      accountOperator: 'agency.com',
      signingProfile: 'adcp/request-signing/v1',
    });
    assert.deepEqual([rfc9421.authorized, rfc9421.legacyFallbackAllowed], [true, true]);
    const offline = records({
      [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
      [trustRecordUrl('brand.com')]: new Error('down'),
    }).evaluator;
    const failed = await new TrustGrantEvaluator(offline, { legacyAuthorization }).check({
      agentOrigin: ORIGIN,
      brandDomain: 'brand.com',
      accountOperator: 'agency.com',
      signingProfile: 'adcp/request-signing/v1',
    });
    assert.deepEqual([failed.authorized, failed.reason], [false, 'trust_record_unavailable']);
    assert.equal(legacy.length, 1);
  });

  it('lets an RFC 9421 buyer keep its legacy path without an operator record until the brand publishes', async () => {
    const { evaluator } = records({});
    const result = await new TrustGrantEvaluator(evaluator, { legacyAuthorization: async () => true }).check({
      agentOrigin: 'https://legacy.agency.com/mcp',
      brandDomain: 'brand.com',
      accountOperator: 'agency.com',
      signingProfile: 'adcp/request-signing/v1',
    });
    assert.equal(result.authorized, true);
    const wba = await new TrustGrantEvaluator(evaluator, { legacyAuthorization: async () => true }).check({
      agentOrigin: 'https://legacy.agency.com',
      brandDomain: 'brand.com',
      accountOperator: 'agency.com',
    });
    assert.equal(wba.authorized, false, 'WBA authority always needs the operator record');
  });

  it('re-evaluates the first link when the intermediary fetch outlives it', async () => {
    let now = 1000;
    const docs = {
      [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
      [trustRecordUrl('brand.com')]: { grants: [grant('agency.com', { valid_until: '1970-01-01T00:16:50Z' })] },
      [trustRecordUrl('agency.com')]: { grants: [grant('platform.com')] },
    };
    const evaluator = new TrustRecordEvaluator({
      now: () => now,
      fetch: async url => {
        if (url === trustRecordUrl('agency.com')) now = 1011;
        return { status: 200, body: JSON.stringify(docs[url]) };
      },
    });
    const result = await new TrustGrantEvaluator(evaluator).check({
      agentOrigin: ORIGIN,
      brandDomain: 'brand.com',
      accountOperator: 'agency.com',
    });
    assert.equal(result.authorized, false);
  });

  it('builds grant_absent errors with the registered details', () => {
    const error = grantAbsentError();
    assert.equal(error.code, 'PERMISSION_DENIED');
    assert.equal(error.recovery, 'correctable');
    assert.deepEqual(error.details, { scope: 'agent', reason: 'grant_absent' });
  });
});

describe('TrustRecordEvaluator shared hops', () => {
  it('shares one hop fetch between operators without sharing authority', async () => {
    const hosted = { agents: [{ url: 'https://buyer.alpha.com', roles: ['adcp:buying'] }] };
    const { evaluator, calls } = records({
      'https://alpha.com/.well-known/trust.json': { authoritative_location: 'https://hosting.com/shared.json' },
      'https://beta.com/.well-known/trust.json': { authoritative_location: 'https://hosting.com/shared.json' },
      'https://hosting.com/shared.json': hosted,
    });
    await evaluator.evaluate('https://buyer.alpha.com', { role: 'adcp:buying' });
    await assert.rejects(evaluator.evaluate('https://buyer.beta.com'), /does not belong to the record owner/);
    assert.equal(calls.filter(url => url === 'https://hosting.com/shared.json').length, 1);
  });

  it('never mistakes a hop-host outage for the owner having no record', async () => {
    let now = 1000;
    const { evaluator } = records(
      {
        [trustRecordUrl(ORIGIN)]: { authoritative_location: 'https://hosting.com/trust.json' },
        'https://hosting.com/trust.json': { status: 503, body: '' },
      },
      () => now
    );
    await assert.rejects(evaluator.evaluate(ORIGIN), error => {
      assert.ok(error instanceof TrustRecordError);
      assert.ok(!(error instanceof TrustRecordAbsentError));
      return true;
    });
    now = 1061;
    await assert.rejects(evaluator.evaluate(ORIGIN), error => !(error instanceof TrustRecordAbsentError));
  });
});
