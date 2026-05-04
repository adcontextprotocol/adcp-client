// Tests for #1529 L1 — credential-policy args-bag scan.
//
// Closes the buyer-args credential-smuggling vector class observed in
// PR scope3data/agentic-adapters#248: top-level `<platform>_access_token`,
// nested `context.<platform>_access_token`, nested `ext.<platform>_access_token`.
// Default mode `'lax'` preserves existing behavior; `'authInfo-only'`
// rejects with PERMISSION_DENIED (`details.scope: 'credentials'`)
// listing offending paths (not values).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const {
  scanArgsForCredentials,
  resolveCredentialPolicyForTool,
  validateCredentialPolicy,
  DEFAULT_CREDENTIAL_PATTERNS,
} = require('../dist/lib/server/credential-policy');

function buildPlatform(getMediaBuyDeliveryImpl) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async () => ({
        id: 'acc_1',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery:
        getMediaBuyDeliveryImpl ??
        (async () => ({
          reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
          media_buy_deliveries: [],
        })),
    },
  };
}

const BASE_OPTS = {
  name: 'credential-policy-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

function callDelivery(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'get_media_buy_delivery',
      arguments: { account: { account_id: 'acc_1' }, ...args },
    },
  });
}

describe('scanArgsForCredentials', () => {
  it('returns empty for clean args', () => {
    assert.deepStrictEqual(scanArgsForCredentials({ media_buy_id: 'mb_1' }), []);
    assert.deepStrictEqual(scanArgsForCredentials({}), []);
    assert.deepStrictEqual(scanArgsForCredentials(null), []);
    assert.deepStrictEqual(scanArgsForCredentials(undefined), []);
  });

  it('flags top-level platform-prefixed access tokens', () => {
    const hits = scanArgsForCredentials({ snap_access_token: 'pat_xxx' });
    assert.deepStrictEqual(hits, ['snap_access_token']);
  });

  it('flags nested context credentials (round-2 vector)', () => {
    const hits = scanArgsForCredentials({
      media_buy_id: 'mb_1',
      context: { snap_access_token: 'pat_xxx' },
    });
    assert.deepStrictEqual(hits, ['context.snap_access_token']);
  });

  it('flags nested ext credentials (round-3 vector)', () => {
    const hits = scanArgsForCredentials({
      media_buy_id: 'mb_1',
      ext: { google_access_token: 'pat_xxx' },
    });
    assert.deepStrictEqual(hits, ['ext.google_access_token']);
  });

  it('reports all three vectors when present together', () => {
    const hits = scanArgsForCredentials({
      snap_access_token: 'a',
      context: { linkedin_access_token: 'b' },
      ext: { tiktok_access_token: 'c' },
    });
    assert.deepStrictEqual(
      hits.sort(),
      ['context.linkedin_access_token', 'ext.tiktok_access_token', 'snap_access_token'].sort()
    );
  });

  it('flags _secret and _password suffixes', () => {
    const hits = scanArgsForCredentials({
      client_secret: 'shhh',
      db_password: 'pw',
    });
    assert.deepStrictEqual(hits.sort(), ['client_secret', 'db_password'].sort());
  });

  it('flags camelCase accessToken / refreshToken', () => {
    const hits = scanArgsForCredentials({
      accessToken: 'a',
      refreshToken: 'b',
      somethingElse: 'ok',
    });
    assert.deepStrictEqual(hits.sort(), ['accessToken', 'refreshToken'].sort());
  });

  it('flags PascalCase variants of camelCase patterns (case-insensitive)', () => {
    const hits = scanArgsForCredentials({
      AccessToken: 'a',
      RefreshToken: 'b',
      ACCESSTOKEN: 'c',
    });
    assert.deepStrictEqual(hits.sort(), ['AccessToken', 'ACCESSTOKEN', 'RefreshToken'].sort());
  });

  it('flags _token$ suffix (bearer_token, id_token, session_token)', () => {
    const hits = scanArgsForCredentials({
      bearer_token: 'a',
      id_token: 'b',
      session_token: 'c',
      auth_token: 'd',
    });
    assert.deepStrictEqual(hits.sort(), ['auth_token', 'bearer_token', 'id_token', 'session_token'].sort());
  });

  it('flags api_key / apiKey / api-key', () => {
    const hits = scanArgsForCredentials({
      api_key: 'a',
      apiKey: 'b',
      'api-key': 'c',
      criteo_api_key: 'd',
    });
    assert.deepStrictEqual(hits.sort(), ['api-key', 'apiKey', 'api_key', 'criteo_api_key'].sort());
  });

  it('flags bare bearer field', () => {
    const hits = scanArgsForCredentials({ bearer: 'a', BEARER: 'b', notBearer: 'c' });
    assert.deepStrictEqual(hits.sort(), ['BEARER', 'bearer'].sort());
  });

  it('flags bare authorization / cookie fields (HTTP-header smuggling)', () => {
    const hits = scanArgsForCredentials({
      authorization: 'Bearer xxx',
      Authorization: 'Bearer yyy',
      cookie: 'session=abc',
      COOKIE: 'session=def',
    });
    assert.deepStrictEqual(hits.sort(), ['Authorization', 'COOKIE', 'authorization', 'cookie'].sort());
  });

  it('flags private_key / privateKey / private-key (JWT/HTTPSig flows)', () => {
    const hits = scanArgsForCredentials({
      private_key: 'a',
      privateKey: 'b',
      'private-key': 'c',
      tenant_private_key: 'd',
    });
    assert.deepStrictEqual(hits.sort(), ['private-key', 'privateKey', 'private_key', 'tenant_private_key'].sort());
  });

  it('does not invoke property getters (defense against throw / side effect)', () => {
    let getterCalls = 0;
    const obj = {};
    Object.defineProperty(obj, 'snap_access_token', {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error('getter side effect');
      },
    });
    // The credential-named getter is flagged by name (fail-closed); the
    // getter itself is never invoked, so the throw never reaches the
    // dispatcher. Without this defense, `Object.entries` would invoke
    // the getter and propagate the throw.
    const hits = scanArgsForCredentials(obj);
    assert.deepStrictEqual(hits, ['snap_access_token']);
    assert.strictEqual(getterCalls, 0, 'getter must not be invoked');
  });

  it('strips /g and /y flags from extend patterns to prevent lastIndex skip-alternation', () => {
    const stateful = /credentials/gi;
    // Without flag stripping, repeated test() calls on the same regex
    // would skip alternating inputs because lastIndex advances.
    const hits1 = scanArgsForCredentials({ credentials_blob: 'a', credentials_other: 'b' }, { extend: [stateful] });
    assert.deepStrictEqual(hits1.sort(), ['credentials_blob', 'credentials_other'].sort());

    // Run a second time to verify state hasn't been retained.
    const hits2 = scanArgsForCredentials({ credentials_one: 'a', credentials_two: 'b' }, { extend: [stateful] });
    assert.deepStrictEqual(hits2.sort(), ['credentials_one', 'credentials_two'].sort());
  });

  it('preserves /i (case-insensitive) flag when stripping /g and /y', () => {
    // Stripping should remove only stateful flags; case-insensitivity
    // is intent-bearing and must survive.
    const hits = scanArgsForCredentials({ CREDENTIALS_X: 'a', credentials_y: 'b' }, { extend: [/credentials/gi] });
    assert.deepStrictEqual(hits.sort(), ['CREDENTIALS_X', 'credentials_y'].sort());
  });

  it('matcher receives parent path for context-aware decisions', () => {
    const hits = scanArgsForCredentials(
      {
        unsafe_in_context_only: 'flag-me',
        context: { unsafe_in_context_only: 'flag-me-too' },
        ext: { unsafe_in_context_only: 'do-not-flag' },
      },
      {
        // Flag only when nested under `context`
        matcher: (key, path) => key === 'unsafe_in_context_only' && path[0] === 'context',
      }
    );
    assert.deepStrictEqual(hits, ['context.unsafe_in_context_only']);
  });

  it('does not flag legitimate non-credential fields adjacent to credential vocabulary', () => {
    // `idempotency_key` does not match `_token$` / `_secret$` / `_password$` /
    // `api[_-]?key` / `^bearer$` / `^accessToken$` / `^refreshToken$`.
    // `package_id`, `media_buy_id` clean.
    const hits = scanArgsForCredentials({
      idempotency_key: 'uuid-x',
      package_id: 'p1',
      media_buy_id: 'mb_1',
      tokenized_assets: [],
    });
    assert.deepStrictEqual(hits, []);
  });

  it('throws when patterns sets both extend and matcher', () => {
    assert.throws(
      () => scanArgsForCredentials({ snap_access_token: 'x' }, { extend: [/foo/], matcher: () => true }),
      /cannot set both/
    );
  });

  it('walks through arrays', () => {
    const hits = scanArgsForCredentials({
      packages: [{ package_id: 'p1', extra: { snap_access_token: 'x' } }, { package_id: 'p2' }],
    });
    assert.deepStrictEqual(hits, ['packages.0.extra.snap_access_token']);
  });

  it('extends with adopter-supplied patterns', () => {
    const hits = scanArgsForCredentials(
      { credentials_blob: 'x', client_secret: 'y' },
      { extend: [/^credentials_blob$/] }
    );
    assert.deepStrictEqual(hits.sort(), ['client_secret', 'credentials_blob'].sort());
  });

  it('matcher fully replaces regex set', () => {
    const hits = scanArgsForCredentials({ client_secret: 'y', anything: 'x' }, { matcher: key => key === 'anything' });
    assert.deepStrictEqual(hits, ['anything']);
  });

  it('does not flag legitimate non-credential keys', () => {
    const hits = scanArgsForCredentials({
      idempotency_key: 'uuid',
      media_buy_id: 'mb_1',
      account: { account_id: 'acc_1' },
      packages: [{ package_id: 'p1', impressions: 1000 }],
    });
    assert.deepStrictEqual(hits, []);
  });

  it('does not infinite-loop on cycles', () => {
    const a = { name: 'a' };
    const b = { name: 'b', back: a };
    a.forward = b;
    const hits = scanArgsForCredentials(a);
    assert.deepStrictEqual(hits, []);
  });

  it('exposes default pattern set', () => {
    assert.ok(Array.isArray(DEFAULT_CREDENTIAL_PATTERNS));
    assert.ok(DEFAULT_CREDENTIAL_PATTERNS.length >= 3);
  });
});

describe('resolveCredentialPolicyForTool', () => {
  it('returns lax when policy is undefined', () => {
    assert.strictEqual(resolveCredentialPolicyForTool(undefined, 'get_products'), 'lax');
  });

  it('returns string-shorthand verbatim', () => {
    assert.strictEqual(resolveCredentialPolicyForTool('authInfo-only', 'get_products'), 'authInfo-only');
    assert.strictEqual(resolveCredentialPolicyForTool('lax', 'get_products'), 'lax');
  });

  it('per-tool override wins', () => {
    const cfg = { policy: 'authInfo-only', tools: { activate_signal: 'lax' } };
    assert.strictEqual(resolveCredentialPolicyForTool(cfg, 'get_products'), 'authInfo-only');
    assert.strictEqual(resolveCredentialPolicyForTool(cfg, 'activate_signal'), 'lax');
  });
});

describe('validateCredentialPolicy', () => {
  const KNOWN = new Set(['get_products', 'activate_signal', 'get_media_buy_delivery']);

  it('no-op for undefined / string shorthand', () => {
    assert.doesNotThrow(() => validateCredentialPolicy(undefined, KNOWN));
    assert.doesNotThrow(() => validateCredentialPolicy('lax', KNOWN));
    assert.doesNotThrow(() => validateCredentialPolicy('authInfo-only', KNOWN));
  });

  it('passes when all tools[] keys are registered', () => {
    assert.doesNotThrow(() =>
      validateCredentialPolicy({ policy: 'authInfo-only', tools: { activate_signal: 'lax' } }, KNOWN)
    );
  });

  it('throws on typo in tools[] key', () => {
    assert.throws(
      () => validateCredentialPolicy({ policy: 'authInfo-only', tools: { activte_signal: 'lax' } }, KNOWN),
      /unregistered tool name/
    );
  });

  it('throws when patterns sets both extend and matcher', () => {
    assert.throws(
      () =>
        validateCredentialPolicy(
          { policy: 'authInfo-only', patterns: { extend: [/foo/], matcher: () => true } },
          KNOWN
        ),
      /cannot set both/
    );
  });
});

describe('#1529 L1 — credentialPolicy server-wired enforcement', () => {
  it('default (no policy) lets credential-shaped keys through', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), BASE_OPTS);
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      snap_access_token: 'attacker-pat',
    });
    assert.notStrictEqual(
      result.isError,
      true,
      `default lax mode should not reject; got ${JSON.stringify(result.structuredContent)}`
    );
  });

  it('authInfo-only rejects top-level credential-shaped key', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      snap_access_token: 'attacker-pat',
    });
    assert.strictEqual(result.isError, true, 'expected rejection');
    const err = result.structuredContent.adcp_error;
    // PERMISSION_DENIED — caller authenticated, payload schema-valid,
    // seller policy refuses. INVALID_REQUEST is for malformed/schema
    // violations, which this isn't.
    assert.strictEqual(err.code, 'PERMISSION_DENIED');
    assert.strictEqual(err.recovery, 'correctable');
    assert.strictEqual(err.details.scope, 'credentials');
    // `field` deliberately omitted so the envelope doesn't imply a single
    // path when several vectors may be present together.
    assert.strictEqual(err.field, undefined);
    assert.deepStrictEqual(err.details.credential_paths, ['snap_access_token']);
  });

  it('authInfo-only rejects nested context credential (round-2 vector)', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      context: { linkedin_access_token: 'attacker-pat' },
    });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent.adcp_error.details.credential_paths, [
      'context.linkedin_access_token',
    ]);
  });

  it('authInfo-only rejects nested ext credential (round-3 vector)', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      ext: { tiktok_access_token: 'attacker-pat' },
    });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent.adcp_error.details.credential_paths, ['ext.tiktok_access_token']);
  });

  it('rejection envelope does NOT echo offending value back', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      context: { snap_access_token: 'sk_live_VERY_SECRET_DO_NOT_LEAK' },
    });
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes('sk_live_VERY_SECRET_DO_NOT_LEAK'),
      'rejection envelope must not echo the offending value'
    );
  });

  it('authInfo-only with clean args dispatches normally', async () => {
    let sawIds;
    const platform = buildPlatform(async filter => {
      sawIds = filter.media_buy_ids;
      return {
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: (filter.media_buy_ids ?? []).map(id => ({
          media_buy_id: id,
          impressions: 100,
          spend: 50,
        })),
      };
    });
    const server = createAdcpServerFromPlatform(platform, {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, { media_buy_ids: ['mb_ok'] });
    assert.notStrictEqual(result.isError, true);
    assert.deepStrictEqual(sawIds, ['mb_ok']);
  });

  it('per-tool lax override allows the buyer-creds tool through while server-wide enforcement holds', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: {
        policy: 'authInfo-only',
        tools: { get_media_buy_delivery: 'lax' },
      },
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      snap_access_token: 'legitimate-buyer-presented',
    });
    assert.notStrictEqual(result.isError, true, `per-tool lax should allow credential-shaped key on opted-out tool`);
  });

  it('server construction throws on typo in credentialPolicy.tools key', () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(buildPlatform(), {
          ...BASE_OPTS,
          credentialPolicy: {
            policy: 'authInfo-only',
            tools: { get_meda_buy_delivery: 'lax' }, // typo: 'meda' not 'media'
          },
        }),
      /unregistered tool name/
    );
  });

  it('extend patterns catches adopter-specific vector', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: {
        policy: 'authInfo-only',
        patterns: { extend: [/^credentials_blob$/] },
      },
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      context: { credentials_blob: 'x' },
    });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent.adcp_error.details.credential_paths, ['context.credentials_blob']);
  });

  it('all three round-N vectors caught in a single call', async () => {
    const server = createAdcpServerFromPlatform(buildPlatform(), {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const result = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      snap_access_token: 'a',
      context: { linkedin_access_token: 'b' },
      ext: { tiktok_access_token: 'c' },
    });
    assert.strictEqual(result.isError, true);
    const paths = result.structuredContent.adcp_error.details.credential_paths;
    assert.strictEqual(paths.length, 3, `expected three hits, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes('snap_access_token'));
    assert.ok(paths.includes('context.linkedin_access_token'));
    assert.ok(paths.includes('ext.tiktok_access_token'));
  });

  it('rejects BEFORE idempotency lookup — credential-bearing payload does not poison the replay cache', async () => {
    // Pin the dispatcher ordering: scan runs before idempotency. A
    // buyer who sends a credential-bearing request and then retries
    // with the same idempotency_key but a CLEAN payload must not see
    // an IDEMPOTENCY_CONFLICT (canonical-payload mismatch with cached
    // success), because the credential request never populated the
    // cache in the first place.
    let handlerCalls = 0;
    const platform = buildPlatform(async () => {
      handlerCalls++;
      return {
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      };
    });
    const server = createAdcpServerFromPlatform(platform, {
      ...BASE_OPTS,
      credentialPolicy: 'authInfo-only',
    });
    const sharedKey = '00000000-0000-4000-8000-000000000001';

    // First request: credential-bearing. Must reject before reaching
    // the idempotency cache OR the handler.
    const rejected = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      idempotency_key: sharedKey,
      snap_access_token: 'attacker-pat',
    });
    assert.strictEqual(rejected.isError, true);
    assert.strictEqual(rejected.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.strictEqual(handlerCalls, 0, 'handler must not run on the rejected request');

    // Second request: clean payload, same idempotency_key. Should
    // succeed normally — the cache is empty because the first request
    // never populated it.
    const clean = await callDelivery(server, {
      media_buy_ids: ['mb_1'],
      idempotency_key: sharedKey,
    });
    assert.notStrictEqual(
      clean.isError,
      true,
      `clean retry should succeed; got ${JSON.stringify(clean.structuredContent)}`
    );
    assert.strictEqual(handlerCalls, 1, 'handler must run on the clean retry');
  });
});
