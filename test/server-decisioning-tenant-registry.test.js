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
    assert.strictEqual(registry.resolveByRequest('sales.training.example.com', '/mcp').tenantId, 'subdomain');
    assert.strictEqual(registry.resolveByRequest('sales.training.example.com', '/anything/deep').tenantId, 'subdomain');
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

    assert.strictEqual(registry.resolveByRequest('sales.training.example.com', '/mcp').tenantId, 'sub');
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/creative/mcp').tenantId, 'path');
  });

  it('strips query strings and fragments before path matching (defensive for raw req.url callers)', async () => {
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
    await registry.recheck('sales');

    // Adopter passes Node's raw req.url instead of Express's req.path.
    // Without query stripping, /sales/mcp?token=abc fails the boundary
    // check at the `?` char.
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/sales/mcp?token=abc').tenantId, 'sales');
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/sales/mcp#frag').tenantId, 'sales');
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/sales?x=1#y').tenantId, 'sales');
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
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/sales/mcp').tenantId, 'with_trailing');
    assert.strictEqual(registry.resolveByRequest('training.example.com', '/sales').tenantId, 'with_trailing');
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

  it('default validator hits host-root /.well-known/brand.json when no jwksUrl override', async () => {
    let fetchedUrl = '';
    const validator = createDefaultJwksValidator({
      fetchImpl: async url => {
        fetchedUrl = url;
        return { ok: false, status: 404, statusText: 'Not Found' };
      },
    });
    await validator.validate({
      agentUrl: 'https://shared.example.com/api/training-agent/signals/mcp',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    // Spec convention: brand.json is host-level, NOT path-relative. The
    // URL constructor with a leading-slash path replaces the path
    // component of agentUrl, so we end up at host root regardless of
    // the agent's path prefix. Sub-routed deployments override via
    // TenantConfig.jwksUrl (see next test).
    assert.strictEqual(fetchedUrl, 'https://shared.example.com/.well-known/brand.json');
  });

  it('F8: jwksUrl override forces the validator to fetch from a sub-path', async () => {
    let fetchedUrl = '';
    const validator = createDefaultJwksValidator({
      fetchImpl: async url => {
        fetchedUrl = url;
        return { ok: false, status: 404, statusText: 'Not Found' };
      },
    });
    await validator.validate({
      agentUrl: 'https://shared.example.com/api/training-agent/signals/mcp',
      jwksUrl: 'https://shared.example.com/api/training-agent/signals/.well-known/brand.json',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    assert.strictEqual(fetchedUrl, 'https://shared.example.com/api/training-agent/signals/.well-known/brand.json');
  });

  it('F8: TenantConfig.jwksUrl threads through runValidation into the validator', async () => {
    let received = null;
    const validator = fakeValidator(async args => {
      received = args;
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('subrouted', {
      agentUrl: 'https://shared.example.com/api/training-agent/signals',
      jwksUrl: 'https://shared.example.com/api/training-agent/signals/.well-known/brand.json',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('subrouted');
    assert.ok(received, 'validator invoked');
    assert.strictEqual(
      received.jwksUrl,
      'https://shared.example.com/api/training-agent/signals/.well-known/brand.json'
    );
    assert.strictEqual(received.agentUrl, 'https://shared.example.com/api/training-agent/signals');
  });

  it('F8: empty-string jwksUrl falls back to spec-canonical host-root (defense-in-depth)', async () => {
    let fetchedUrl = '';
    const validator = createDefaultJwksValidator({
      fetchImpl: async url => {
        fetchedUrl = url;
        return { ok: false, status: 404, statusText: 'Not Found' };
      },
    });
    await validator.validate({
      agentUrl: 'https://example.com',
      jwksUrl: '',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    // Empty-string defense: reach the host-root default rather than
    // attempting fetch('') and surfacing an opaque error.
    assert.strictEqual(fetchedUrl, 'https://example.com/.well-known/brand.json');
  });

  it('F8: agentUrl with port + query + fragment resolves correctly to host-root JWKS', async () => {
    let fetchedUrl = '';
    const validator = createDefaultJwksValidator({
      fetchImpl: async url => {
        fetchedUrl = url;
        return { ok: false, status: 404, statusText: 'Not Found' };
      },
    });
    await validator.validate({
      agentUrl: 'https://x.example.com:8080/foo/bar?session=abc#frag',
      signingKey: { keyId: 'k', publicJwk: {}, privateJwk: {} },
    });
    // Leading-slash path replaces path AND query AND fragment in the
    // base URL per WHATWG URL semantics. Port survives.
    assert.strictEqual(fetchedUrl, 'https://x.example.com:8080/.well-known/brand.json');
  });

  it('F8: register() emits an info log when jwksUrl diverges from agentUrl-relative canonical URL', () => {
    const infos = [];
    const originalInfo = console.info;
    console.info = (...args) => infos.push(args.join(' '));
    try {
      const registry = createTenantRegistry({
        jwksValidator: fakeValidator(async () => ({ ok: true })),
        defaultServerOptions: DEFAULT_SERVER_OPTIONS,
        autoValidate: false,
      });
      registry.register('subrouted', {
        agentUrl: 'https://shared.example.com/api/agent-a',
        jwksUrl: 'https://shared.example.com/api/agent-a/.well-known/brand.json',
        signingKey: SAMPLE_KEY,
        platform: basePlatform(),
      });
    } finally {
      console.info = originalInfo;
    }
    const hit = infos.find(i => i.includes('jwksUrl override'));
    assert.ok(hit, `expected divergence info log, got: ${JSON.stringify(infos)}`);
    assert.match(hit, /agent-a\/\.well-known\/brand\.json/);
    assert.match(hit, /spec-canonical/);
  });

  it('F8: register() does NOT log when jwksUrl matches the spec-canonical resolution', () => {
    const infos = [];
    const originalInfo = console.info;
    console.info = (...args) => infos.push(args.join(' '));
    try {
      const registry = createTenantRegistry({
        jwksValidator: fakeValidator(async () => ({ ok: true })),
        defaultServerOptions: DEFAULT_SERVER_OPTIONS,
        autoValidate: false,
      });
      registry.register('canonical', {
        agentUrl: 'https://x.example.com',
        // Matches what `new URL('/.well-known/brand.json', agentUrl)` produces.
        jwksUrl: 'https://x.example.com/.well-known/brand.json',
        signingKey: SAMPLE_KEY,
        platform: basePlatform(),
      });
    } finally {
      console.info = originalInfo;
    }
    const hit = infos.find(i => i.includes('jwksUrl override'));
    assert.strictEqual(hit, undefined, 'no divergence log when override matches canonical');
  });
});

describe('TenantRegistry — direct lookup by tenantId (training-agent feedback)', () => {
  it('get(tenantId) returns the entry without URL parsing', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('alpha', {
      agentUrl: 'https://shared.example.com/api/training-agent/sales',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('alpha');

    const entry = registry.get('alpha');
    assert.ok(entry, 'get() returns entry for healthy tenant');
    assert.strictEqual(entry.tenantId, 'alpha');
    assert.ok(entry.config);
    assert.ok(entry.server, 'entry carries the AdcpServer instance');
    // Same shape as resolveByRequest:
    const viaResolve = registry.resolveByRequest('shared.example.com', '/api/training-agent/sales');
    assert.ok(viaResolve);
    assert.strictEqual(viaResolve.tenantId, entry.tenantId);
  });

  it('get(tenantId) returns null for unknown tenant', () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    assert.strictEqual(registry.get('does-not-exist'), null);
  });

  it('get(tenantId) returns null for pending tenant (refuses traffic until first validation)', () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });
    registry.register('not-yet-validated', {
      agentUrl: 'https://x.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    // Haven't called recheck — tenant is in 'pending'.
    assert.strictEqual(registry.get('not-yet-validated'), null, 'pending tenant refused');
  });

  it('get(tenantId) returns the entry for unverified (post-healthy transient failure)', async () => {
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
    await registry.recheck('seasoned'); // healthy
    validateImpl = async () => ({ ok: false, recovery: 'transient', reason: 'flaky' });
    await registry.recheck('seasoned'); // unverified
    const entry = registry.get('seasoned');
    assert.ok(entry, 'unverified tenant still resolves (graceful degradation)');
  });
});

describe('TenantRegistry — autoValidate footgun guard (F7)', () => {
  it('emits a one-shot console.warn at construction when autoValidate: false', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      createTenantRegistry({
        jwksValidator: fakeValidator(async () => ({ ok: true })),
        defaultServerOptions: DEFAULT_SERVER_OPTIONS,
        autoValidate: false,
      });
    } finally {
      console.warn = originalWarn;
    }
    const hit = warnings.find(w => w.includes('autoValidate: false'));
    assert.ok(hit, `expected warning about autoValidate: false, got: ${JSON.stringify(warnings)}`);
    assert.match(hit, /resolveByRequest will refuse all traffic/);
    assert.match(hit, /recheck/);
    // DX feedback: tell the adopter who probably picked the wrong flag
    // what they actually wanted, not just how to live with the choice.
    assert.match(hit, /REMOVE the flag/);
  });

  it('does NOT warn when autoValidate is left at the default', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      createTenantRegistry({
        jwksValidator: fakeValidator(async () => ({ ok: true })),
        defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      });
    } finally {
      console.warn = originalWarn;
    }
    const hit = warnings.find(w => w.includes('autoValidate'));
    assert.strictEqual(hit, undefined, 'no autoValidate warning when default');
  });

  it('does NOT warn when autoValidate: true is explicitly set', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      createTenantRegistry({
        jwksValidator: fakeValidator(async () => ({ ok: true })),
        defaultServerOptions: DEFAULT_SERVER_OPTIONS,
        autoValidate: true,
      });
    } finally {
      console.warn = originalWarn;
    }
    const hit = warnings.find(w => w.includes('autoValidate'));
    assert.strictEqual(hit, undefined, 'no autoValidate warning when explicitly true');
  });
});

describe('TenantRegistry — multi-URL (agentUrls) cutover support', () => {
  it('routes traffic from any URL in agentUrls to the same tenant', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('cutover_tenant', {
      agentUrls: ['https://new.example.com', 'https://old.example.com'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('cutover_tenant');

    const fromNew = registry.resolveByHost('new.example.com');
    const fromOld = registry.resolveByHost('old.example.com');
    assert.ok(fromNew, 'resolves on canonical URL');
    assert.ok(fromOld, 'resolves on alias URL');
    assert.strictEqual(fromNew.tenantId, 'cutover_tenant');
    assert.strictEqual(fromOld.tenantId, 'cutover_tenant');
    assert.strictEqual(fromNew.server, fromOld.server, 'same server instance for both URLs');
  });

  it('JWKS validation hits every URL in agentUrls — aliases are validated independently', async () => {
    const seenHosts = [];
    const validator = fakeValidator(async ({ agentUrl }) => {
      seenHosts.push(agentUrl);
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('cutover', {
      agentUrls: ['https://canonical.example.com', 'https://alias-a.example.com', 'https://alias-b.example.com'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('cutover');

    assert.deepStrictEqual(
      seenHosts,
      ['https://canonical.example.com', 'https://alias-a.example.com', 'https://alias-b.example.com'],
      'every alias is independently validated — round-1 expert security finding'
    );
  });

  it('aliases with stale brand.json mark the whole tenant disabled', async () => {
    const validator = fakeValidator(async ({ agentUrl }) => {
      if (agentUrl === 'https://stale-alias.example.com') {
        return { ok: false, recovery: 'permanent', reason: 'signingKey not in published JWKS' };
      }
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('partial', {
      agentUrls: ['https://canonical.example.com', 'https://stale-alias.example.com'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    const status = await registry.recheck('partial');
    assert.strictEqual(status.health, 'disabled', 'any permanent alias failure disables the tenant');
    assert.match(status.reason, /stale-alias/);
  });

  it('rejects register-time route collision against an existing tenant', () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('first', {
      agentUrls: ['https://shared.example.com/api'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });

    // Same host + same path prefix → collision.
    assert.throws(
      () =>
        registry.register('second', {
          agentUrls: ['https://shared.example.com/api'],
          signingKey: SAMPLE_KEY,
          platform: basePlatform(),
        }),
      /route .* collides with tenant 'first'/
    );

    // Different path prefix on same host → allowed.
    registry.register('third', {
      agentUrls: ['https://shared.example.com/other'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
  });

  it('TenantStatus.agentUrls surfaces the full URL list for multi-URL tenants', async () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('multi-status', {
      agentUrls: ['https://primary.example.com', 'https://secondary.example.com'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('multi-status');

    const status = registry.getStatus('multi-status');
    assert.deepStrictEqual(status.agentUrls, ['https://primary.example.com', 'https://secondary.example.com']);
    assert.strictEqual(status.agentUrl, 'https://primary.example.com', 'canonical still surfaced');
  });

  it('TenantStatus.agentUrls is a one-element array for single-URL tenants (compat)', async () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('single', {
      agentUrl: 'https://only.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('single');

    const status = registry.getStatus('single');
    assert.deepStrictEqual(status.agentUrls, ['https://only.example.com']);
    assert.strictEqual(status.agentUrl, 'https://only.example.com');
  });

  it('TenantStatus.agentUrl reports the canonical URL for multi-URL tenants', async () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('multi', {
      agentUrls: ['https://primary.example.com', 'https://secondary.example.com'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('multi');

    const status = registry.getStatus('multi');
    assert.strictEqual(status.agentUrl, 'https://primary.example.com');
    assert.strictEqual(status.health, 'healthy');
  });

  it('rejects setting both agentUrl and agentUrls', () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    assert.throws(
      () =>
        registry.register('ambiguous', {
          agentUrl: 'https://one.example.com',
          agentUrls: ['https://two.example.com'],
          signingKey: SAMPLE_KEY,
          platform: basePlatform(),
        }),
      /set exactly one of/
    );
  });

  it('rejects empty agentUrls array', () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    assert.throws(
      () =>
        registry.register('empty', {
          agentUrls: [],
          signingKey: SAMPLE_KEY,
          platform: basePlatform(),
        }),
      /must contain at least one URL/
    );
  });

  it('rejects neither agentUrl nor agentUrls', () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    assert.throws(
      () =>
        registry.register('missing', {
          signingKey: SAMPLE_KEY,
          platform: basePlatform(),
        }),
      /must provide either/
    );
  });

  it('multi-URL tenant with mixed path prefixes — longest-prefix-wins still applies across hosts', async () => {
    const registry = createTenantRegistry({
      jwksValidator: fakeValidator(async () => ({ ok: true })),
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    // Tenant A on canonical-host with /sales prefix; Tenant B on alias-host
    // with /sales-broadcast prefix. A request to alias-host/sales-broadcast/mcp
    // should resolve to Tenant B (longer matching prefix wins).
    registry.register('tenant_short', {
      agentUrls: ['https://canonical.example.com/sales'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('tenant_long', {
      agentUrls: ['https://canonical.example.com/sales-broadcast'],
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    await registry.recheck('tenant_short');
    await registry.recheck('tenant_long');

    const longMatch = registry.resolveByRequest('canonical.example.com', '/sales-broadcast/mcp');
    assert.ok(longMatch);
    assert.strictEqual(longMatch.tenantId, 'tenant_long');

    const shortMatch = registry.resolveByRequest('canonical.example.com', '/sales/mcp');
    assert.ok(shortMatch);
    assert.strictEqual(shortMatch.tenantId, 'tenant_short');
  });
});

describe('TenantRegistry — unsigned tenants (signingKey optional in 3.x)', () => {
  it('register without signingKey skips JWKS validation; tenant goes straight to healthy', async () => {
    let validatorCalls = 0;
    const validator = fakeValidator(async () => {
      validatorCalls++;
      return { ok: true };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('unsigned', {
      agentUrl: 'https://unsigned.example.com',
      // no signingKey — adopter shipping in 3.x without standing up KMS
      platform: basePlatform(),
    });

    const status = await registry.recheck('unsigned');
    assert.strictEqual(status.health, 'healthy');
    assert.strictEqual(status.reason, 'unsigned (no signingKey)');
    assert.strictEqual(validatorCalls, 0, 'validator must not be invoked when signingKey is omitted');
    assert.ok(registry.resolveByHost('unsigned.example.com'), 'unsigned tenant accepts traffic');
  });

  it('register({ awaitFirstValidation: true }) on unsigned tenant returns healthy synchronously', async () => {
    const validator = fakeValidator(async () => {
      throw new Error('validator should not run for unsigned tenants');
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: true,
    });

    const status = await registry.register(
      'unsigned_sync',
      { agentUrl: 'https://unsigned-sync.example.com', platform: basePlatform() },
      { awaitFirstValidation: true }
    );
    assert.strictEqual(status.health, 'healthy');
    assert.strictEqual(status.reason, 'unsigned (no signingKey)');
  });

  it('signed and unsigned tenants coexist in the same registry', async () => {
    const validator = fakeValidator(async () => ({ ok: true }));
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('signed', {
      agentUrl: 'https://signed.example.com',
      signingKey: SAMPLE_KEY,
      platform: basePlatform(),
    });
    registry.register('unsigned', {
      agentUrl: 'https://unsigned.example.com',
      platform: basePlatform(),
    });

    await Promise.all([registry.recheck('signed'), registry.recheck('unsigned')]);

    assert.strictEqual(registry.getStatus('signed').health, 'healthy');
    assert.strictEqual(registry.getStatus('unsigned').health, 'healthy');
    assert.strictEqual(registry.getStatus('unsigned').reason, 'unsigned (no signingKey)');
  });
});

describe('createSelfSignedTenantKey', () => {
  const { createSelfSignedTenantKey } = require('../dist/lib/server/decisioning/tenant-registry');

  it('returns a TenantSigningKey-shaped object with Ed25519 material', async () => {
    const key = await createSelfSignedTenantKey();
    assert.ok(key.keyId, 'keyId is set');
    assert.match(key.keyId, /^self-signed-/, 'default keyId is timestamped');
    assert.strictEqual(key.publicJwk.kty, 'OKP');
    assert.strictEqual(key.publicJwk.crv, 'Ed25519');
    assert.ok(key.publicJwk.x, 'public x coordinate present');
    assert.ok(key.privateJwk.d, 'private scalar present');
    // Public-half fields match across the keypair (RFC 7517).
    assert.strictEqual(key.privateJwk.x, key.publicJwk.x);
  });

  it('honors explicit keyId override', async () => {
    const key = await createSelfSignedTenantKey({ keyId: 'my-stable-kid' });
    assert.strictEqual(key.keyId, 'my-stable-kid');
  });

  it('roundtrips through the registry — self-signed key + matching JWKS publishes healthy', async () => {
    const key = await createSelfSignedTenantKey({ keyId: 'roundtrip-kid' });
    // Stub validator that simulates a brand.json containing exactly this key.
    const validator = fakeValidator(async ({ signingKey }) => {
      if (
        signingKey.keyId === 'roundtrip-kid' &&
        signingKey.publicJwk.kty === 'OKP' &&
        signingKey.publicJwk.crv === 'Ed25519' &&
        signingKey.publicJwk.x === key.publicJwk.x
      ) {
        return { ok: true };
      }
      return { ok: false, recovery: 'permanent', reason: 'mismatch' };
    });
    const registry = createTenantRegistry({
      jwksValidator: validator,
      defaultServerOptions: DEFAULT_SERVER_OPTIONS,
      autoValidate: false,
    });

    registry.register('rt', {
      agentUrl: 'https://rt.example.com',
      signingKey: key,
      platform: basePlatform(),
    });
    const status = await registry.recheck('rt');
    assert.strictEqual(status.health, 'healthy');
  });
});

describe('createNoopJwksValidator — NODE_ENV allowlist', () => {
  const { createNoopJwksValidator } = require('../dist/lib/server/decisioning/tenant-registry');

  // Save and restore env across tests to keep them hermetic. The test
  // harness sets NODE_ENV='test' at file load (line 4); resetting after
  // each case prevents cross-test bleed.
  function withEnv(overrides, fn) {
    const saved = { NODE_ENV: process.env.NODE_ENV, ADCP_NOOP_JWKS_ACK: process.env.ADCP_NOOP_JWKS_ACK };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('constructs under NODE_ENV=test', () => {
    withEnv({ NODE_ENV: 'test', ADCP_NOOP_JWKS_ACK: undefined }, () => {
      const v = createNoopJwksValidator();
      assert.ok(typeof v.validate === 'function');
    });
  });

  it('constructs under NODE_ENV=development', () => {
    withEnv({ NODE_ENV: 'development', ADCP_NOOP_JWKS_ACK: undefined }, () => {
      const v = createNoopJwksValidator();
      assert.ok(typeof v.validate === 'function');
    });
  });

  it('throws under NODE_ENV=production without ack', () => {
    withEnv({ NODE_ENV: 'production', ADCP_NOOP_JWKS_ACK: undefined }, () => {
      assert.throws(() => createNoopJwksValidator(), /refuses to construct.*production/);
    });
  });

  it('throws when NODE_ENV is unset and no ack — covers raw Lambda / custom containers', () => {
    withEnv({ NODE_ENV: undefined, ADCP_NOOP_JWKS_ACK: undefined }, () => {
      assert.throws(() => createNoopJwksValidator(), /refuses to construct.*<unset>/);
    });
  });

  it('throws under NODE_ENV=staging without ack', () => {
    withEnv({ NODE_ENV: 'staging', ADCP_NOOP_JWKS_ACK: undefined }, () => {
      assert.throws(() => createNoopJwksValidator(), /refuses to construct.*staging/);
    });
  });

  it('ADCP_NOOP_JWKS_ACK=1 unblocks construction outside the allowlist', () => {
    withEnv({ NODE_ENV: 'production', ADCP_NOOP_JWKS_ACK: '1' }, () => {
      const v = createNoopJwksValidator();
      assert.ok(typeof v.validate === 'function');
    });
  });

  it('ADCP_NOOP_JWKS_ACK=true (truthy lookalike) does NOT unblock — strict literal "1" required', () => {
    withEnv({ NODE_ENV: 'production', ADCP_NOOP_JWKS_ACK: 'true' }, () => {
      assert.throws(() => createNoopJwksValidator(), /refuses to construct/);
    });
    withEnv({ NODE_ENV: 'production', ADCP_NOOP_JWKS_ACK: 'yes' }, () => {
      assert.throws(() => createNoopJwksValidator(), /refuses to construct/);
    });
  });

  it('returned validator always returns ok=true', async () => {
    await withEnv({ NODE_ENV: 'test', ADCP_NOOP_JWKS_ACK: undefined }, async () => {
      const v = createNoopJwksValidator();
      const res = await v.validate({
        agentUrl: 'https://anything.example.com',
        signingKey: { keyId: 'k', publicJwk: { kty: 'OKP' }, privateJwk: { kty: 'OKP' } },
      });
      assert.strictEqual(res.ok, true);
    });
  });
});
