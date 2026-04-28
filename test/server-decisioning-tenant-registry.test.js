// TenantRegistry tests — multi-tenant deployment, per-tenant health states,
// JWKS validation, recheck after fix.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTenantRegistry } = require('../dist/lib/server/decisioning/tenant-registry');

function basePlatform(specialism = 'sales-non-guaranteed') {
  return {
    capabilities: {
      specialisms: [specialism],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async () => ({ id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}

const SAMPLE_KEY = {
  keyId: 'tenant-key-1',
  publicJwk: { kty: 'RSA', n: 'pub_modulus_xxx', e: 'AQAB' },
  privateJwk: { kty: 'RSA', n: 'pub_modulus_xxx', e: 'AQAB', d: 'priv_exp_yyy' },
};

const DEFAULT_SERVER_OPTIONS = {
  name: 'tenant-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

function fakeValidator(impl) {
  return { validate: impl };
}

describe('TenantRegistry — register, resolve, health', () => {
  it('register without auto-validate lands in pending; manual recheck transitions to healthy', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('tenant_a', {
      agentUrl: 'https://a.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    let status = registry.getStatus('tenant_a');
    assert.strictEqual(status.health, 'pending');
    assert.strictEqual(status.tenantId, 'tenant_a');

    // Pending tenant refuses traffic — closes register-then-serve race window.
    assert.strictEqual(registry.resolveByHost('a.example.com'), null, 'pending tenant does not resolve');

    status = await registry.recheck('tenant_a');
    assert.strictEqual(status.health, 'healthy');
    assert.ok(registry.resolveByHost('a.example.com'), 'healthy tenant resolves');
  });

  it('disabled tenant does not resolveByHost; healthy tenant does', async () => {
    const validator = fakeValidator(async ({ agentUrl }) => {
      if (agentUrl === 'https://bad.example.com') {
        return { ok: false, recovery: 'permanent', reason: 'key not in JWKS' };
      }
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('good', {
      agentUrl: 'https://good.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('bad', {
      agentUrl: 'https://bad.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    await registry.recheck('good');
    await registry.recheck('bad');

    const goodResolved = registry.resolveByHost('good.example.com');
    assert.ok(goodResolved, 'healthy tenant resolves');
    assert.strictEqual(goodResolved.tenantId, 'good');

    const badResolved = registry.resolveByHost('bad.example.com');
    assert.strictEqual(badResolved, null, 'disabled tenant does not resolve');
  });

  it('pending tenant (first validation in flight) does NOT resolve — closes race window', async () => {
    let resolveValidator;
    const validator = fakeValidator(
      () =>
        new Promise(resolve => {
          resolveValidator = resolve;
        })
    );
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: true,
    });

    registry.register('newt', {
      agentUrl: 'https://newt.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    const status = registry.getStatus('newt');
    assert.strictEqual(status.health, 'pending');
    assert.strictEqual(registry.resolveByHost('newt.example.com'), null, 'pending tenant refuses traffic');

    // Settle to healthy → now resolves.
    resolveValidator({ ok: true });
    // Wait one microtask flush for the validation promise to settle.
    await new Promise(r => setImmediate(r));
    assert.strictEqual(registry.getStatus('newt').health, 'healthy');
    assert.ok(registry.resolveByHost('newt.example.com'), 'healthy tenant accepts traffic');
  });

  it('unverified tenant (post-healthy transient failure) still resolves — graceful degradation', async () => {
    // Different from pending: tenant was healthy, then a recheck failed
    // transiently. Operators choose to keep serving.
    let validateImpl = async () => ({ ok: true });
    const validator = { validate: (...args) => validateImpl(...args) };
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('seasoned', {
      agentUrl: 'https://seasoned.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    // First validation succeeds → healthy
    let status = await registry.recheck('seasoned');
    assert.strictEqual(status.health, 'healthy');

    // Recheck fails transiently → unverified
    validateImpl = async () => ({ ok: false, recovery: 'transient', reason: 'brand.json 503' });
    status = await registry.recheck('seasoned');
    assert.strictEqual(status.health, 'unverified');
    assert.ok(registry.resolveByHost('seasoned.example.com'), 'unverified (post-healthy) still resolves');
  });

  it('register({ awaitFirstValidation: true }) returns the resolved status', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: true,
    });

    const status = await registry.register(
      'sync_register',
      { agentUrl: 'https://sync.example.com', signingKey: SAMPLE_KEY, platform: basePlatform() },
      { awaitFirstValidation: true }
    );
    assert.strictEqual(status.health, 'healthy');
    // Caller can use the returned status to make a deploy-time go/no-go decision.
  });

  it('runValidation catches validator throws — tenant transitions to unverified, not stuck pending', async () => {
    // Validator throws (e.g., uncaught network error in adopter validator).
    // Without the catch the validation promise rejects, entry.status
    // never updates, tenant stuck in pending forever.
    const validator = fakeValidator(async () => {
      throw new Error('connection reset');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('flaky', {
      agentUrl: 'https://flaky.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    const status = await registry.recheck('flaky');
    // Throw is treated as transient; first validation → still pending.
    assert.strictEqual(status.health, 'pending');
    assert.match(status.reason, /validator threw.*connection reset/);
  });

  it('transient validation failure on FIRST validation → stays pending (not disabled)', async () => {
    // Under the race-window-closing semantics, a first-validation
    // transient failure keeps the tenant in `pending` — refuse traffic
    // until at least one validation has succeeded. Previously this
    // test asserted `unverified`; that posture only applies AFTER a
    // tenant has been healthy at least once.
    const validator = fakeValidator(async () => ({
      ok: false,
      recovery: 'transient',
      reason: 'connection refused',
    }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('transient', {
      agentUrl: 'https://transient.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    const status = await registry.recheck('transient');
    assert.strictEqual(status.health, 'pending');
    assert.match(status.reason, /connection refused/);
    assert.strictEqual(registry.resolveByHost('transient.example.com'), null);
  });

  it('recheck after fix transitions disabled → healthy', async () => {
    let firstAttempt = true;
    const validator = fakeValidator(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        return { ok: false, recovery: 'permanent', reason: 'key mismatch' };
      }
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('recheck', {
      agentUrl: 'https://recheck.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    const first = await registry.recheck('recheck');
    assert.strictEqual(first.health, 'disabled');

    const second = await registry.recheck('recheck');
    assert.strictEqual(second.health, 'healthy');
  });

  it('one disabled tenant does not affect others (per-tenant isolation)', async () => {
    const validator = fakeValidator(async ({ agentUrl }) => {
      if (agentUrl === 'https://broken.example.com') {
        return { ok: false, recovery: 'permanent', reason: 'invalid' };
      }
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('alpha', {
      agentUrl: 'https://alpha.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('broken', {
      agentUrl: 'https://broken.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('beta', {
      agentUrl: 'https://beta.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    await Promise.all([registry.recheck('alpha'), registry.recheck('broken'), registry.recheck('beta')]);

    const all = registry.list();
    const byId = Object.fromEntries(all.map(s => [s.tenantId, s.health]));
    assert.strictEqual(byId.alpha, 'healthy');
    assert.strictEqual(byId.broken, 'disabled');
    assert.strictEqual(byId.beta, 'healthy');
  });

  it('unregister removes tenant; resolveByHost returns null after', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('temp', {
      agentUrl: 'https://temp.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('temp');
    assert.ok(registry.resolveByHost('temp.example.com'));

    registry.unregister('temp');
    assert.strictEqual(registry.resolveByHost('temp.example.com'), null);
    assert.strictEqual(registry.getStatus('temp'), null);
  });

  it('mixed-shape tenants (sync seller + HITL seller) coexist on different hosts', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    const syncPlatform = basePlatform();
    const hitlPlatform = basePlatform();
    // Replace sync createMediaBuy with the HITL *Task variant
    delete hitlPlatform.sales.createMediaBuy;
    hitlPlatform.sales.createMediaBuy = (req, ctx) => ctx.handoffToTask(async () => ({ media_buy_id: 'mb_hitl' }));

    registry.register('sync', {
      agentUrl: 'https://sync.example.com',
      signingKey: SAMPLE_KEY,
      platform: syncPlatform,
      label: 'programmatic',
    });
    registry.register('hitl', {
      agentUrl: 'https://hitl.example.com',
      signingKey: SAMPLE_KEY,
      platform: hitlPlatform,
      label: 'broadcast',
    });

    await Promise.all([registry.recheck('sync'), registry.recheck('hitl')]);

    const syncRes = registry.resolveByHost('sync.example.com');
    const hitlRes = registry.resolveByHost('hitl.example.com');
    assert.ok(syncRes && hitlRes);
    assert.strictEqual(syncRes.config.label, 'programmatic');
    assert.strictEqual(hitlRes.config.label, 'broadcast');

    // The two servers are independent instances
    assert.notStrictEqual(syncRes.server, hitlRes.server);
  });

  it('register with duplicate tenantId throws', () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('dup', {
      agentUrl: 'https://dup.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    assert.throws(
      () =>
        registry.register('dup', {
          agentUrl: 'https://dup.example.com',
          signingKey: SAMPLE_KEY,
          platform: basePlatform(),
        }),
      /already registered/
    );
  });
});

describe('TenantRegistry — path-based routing', () => {
  it('resolveByRequest matches host + path prefix', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('sales', {
      agentUrl: 'https://training.example.com/sales',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('creative', {
      agentUrl: 'https://training.example.com/creative',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await Promise.all([registry.recheck('sales'), registry.recheck('creative')]);

    const sales = registry.resolveByRequest('training.example.com', '/sales/mcp');
    assert.strictEqual(sales.tenantId, 'sales');

    const creative = registry.resolveByRequest('training.example.com', '/creative/a2a');
    assert.strictEqual(creative.tenantId, 'creative');

    // Path miss → no resolution (even though host matches both tenants).
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/nobody'), null);
  });

  it('longest-prefix wins for overlapping paths', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('sales', {
      agentUrl: 'https://training.example.com/sales',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('sales-broadcast', {
      agentUrl: 'https://training.example.com/sales-broadcast',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await Promise.all([registry.recheck('sales'), registry.recheck('sales-broadcast')]);

    // /sales-broadcast/* → sales-broadcast (longest prefix).
    const broadcastHit = registry.resolveByRequest('training.example.com', '/sales-broadcast/mcp');
    assert.strictEqual(broadcastHit.tenantId, 'sales-broadcast');

    // /sales/* → sales (sales-broadcast doesn't match because boundary check).
    const salesHit = registry.resolveByRequest('training.example.com', '/sales/mcp');
    assert.strictEqual(salesHit.tenantId, 'sales');
  });

  it('subdomain-routed tenants have prefix `/` and match any pathname', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('subdomain', {
      agentUrl: 'https://sales.training.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('subdomain');

    // resolveByHost still works (legacy/convenience).
    assert.strictEqual(registry.resolveByHost('sales.training.example.com').tenantId, 'subdomain');
    // resolveByRequest with any path also works (root prefix matches everything).
    assert.strictEqual(
      registry.resolveByRequest('sales.training.example.com', '/mcp').tenantId,
      'subdomain'
    );
    assert.strictEqual(
      registry.resolveByRequest('sales.training.example.com', '/anything/deep').tenantId,
      'subdomain'
    );
  });

  it('mixed subdomain + path tenants on the same registry', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    // Some tenants use subdomain, some use path. Real-world: not every
    // adopter can stand up subdomain DNS; the SDK supports both shapes.
    registry.register('sub', {
      agentUrl: 'https://sales.training.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('path', {
      agentUrl: 'https://training.example.com/creative',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await Promise.all([registry.recheck('sub'), registry.recheck('path')]);

    assert.strictEqual(
      registry.resolveByRequest('sales.training.example.com', '/mcp').tenantId,
      'sub'
    );
    assert.strictEqual(
      registry.resolveByRequest('training.example.com', '/creative/mcp').tenantId,
      'path'
    );
  });

  it('trailing-slash and exact-prefix paths normalize the same way', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('with_trailing', {
      agentUrl: 'https://training.example.com/sales/',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('with_trailing');

    // Either request-path style hits the tenant — trailing slash on
    // agentUrl normalizes to /sales prefix; both /sales/mcp and /sales
    // match.
    assert.strictEqual(
      registry.resolveByRequest('training.example.com', '/sales/mcp').tenantId,
      'with_trailing'
    );
    assert.strictEqual(
      registry.resolveByRequest('training.example.com', '/sales').tenantId,
      'with_trailing'
    );
  });
});

describe('TenantRegistry — default JWKS validator (fetch-based)', () => {
  const { createDefaultJwksValidator } = require('../dist/lib/server/decisioning/tenant-registry');

  it('matches by kid AND key material — kid alone is not sufficient', async () => {
    // Security regression: previous version returned ok on kid match
    // alone, allowing an attacker who controls a tenant's published
    // JWKS to bypass verification by publishing a colliding kid with
    // their own key material. Now: both kid and modulus must match.
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { jwks: { keys: [{ kty: 'RSA', kid: 'tenant-key-1', n: 'aaa', e: 'AQAB' }] } };
      },
    });
    const validator = createDefaultJwksValidator({ fetchImpl: fakeFetch });

    // Same kid, MISMATCHED modulus → reject.
    const mismatched = await validator.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'tenant-key-1', publicJwk: { kty: 'RSA', n: 'bbb', e: 'AQAB' }, privateJwk: {} },
    });
    assert.strictEqual(mismatched.ok, false, 'kid match with wrong modulus must reject');

    // Same kid AND matching modulus → accept.
    const matching = await validator.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'tenant-key-1', publicJwk: { kty: 'RSA', n: 'aaa', e: 'AQAB' }, privateJwk: {} },
    });
    assert.strictEqual(matching.ok, true, 'kid + modulus match accepts');
  });

  it('matches by structural equality when kid is not present', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB' }] } };
      },
    });
    const validator = createDefaultJwksValidator({ fetchImpl: fakeFetch });
    const result = await validator.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'whatever', publicJwk: { kty: 'RSA', n: 'modulus', e: 'AQAB' }, privateJwk: {} },
    });
    assert.strictEqual(result.ok, true);
  });

  it('returns permanent rejection when key is not in JWKS', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { jwks: { keys: [{ kty: 'RSA', kid: 'other-key', n: 'aaa', e: 'AQAB' }] } };
      },
    });
    const validator = createDefaultJwksValidator({ fetchImpl: fakeFetch });
    const result = await validator.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'missing-key', publicJwk: { kty: 'RSA', n: 'bbb', e: 'AQAB' }, privateJwk: {} },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.recovery, 'permanent');
  });

  it('classifies network errors as transient', async () => {
    const fakeFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const validator = createDefaultJwksValidator({ fetchImpl: fakeFetch });
    const result = await validator.validate({
      agentUrl: 'https://down.example.com',
      signingKey: { keyId: 'k', publicJwk: { kty: 'RSA' }, privateJwk: {} },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.recovery, 'transient');
  });

  it('classifies 5xx as transient and 4xx as permanent', async () => {
    const validator5xx = createDefaultJwksValidator({
      fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
    });
    const r5 = await validator5xx.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    assert.strictEqual(r5.recovery, 'transient');

    const validator4xx = createDefaultJwksValidator({
      fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found' }),
    });
    const r4 = await validator4xx.validate({
      agentUrl: 'https://example.com',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    assert.strictEqual(r4.recovery, 'permanent');
  });
});
