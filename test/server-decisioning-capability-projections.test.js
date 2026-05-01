// Integration tests for v6 capability projections: audience_targeting,
// conversion_tracking, and content_standards declared on platform.capabilities
// must surface on get_adcp_capabilities.media_buy via the framework's
// overrides.media_buy deep-merge seam.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform(capabilityOverrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
      ...capabilityOverrides,
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'cap_acc_1',
        operator: 'caps.example.com',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

async function dispatchCapabilities(server) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
}

describe('Capability projections — declarative capability blocks on DecisioningCapabilities', () => {
  it('audience_targeting projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        audience_targeting: {
          supported_identifier_types: ['hashed_email', 'hashed_phone'],
          minimum_audience_size: 100,
          matching_latency_hours: { min: 1, max: 24 },
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const at = result.structuredContent?.media_buy?.audience_targeting;
    assert.ok(at, `audience_targeting missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.deepStrictEqual(at.supported_identifier_types, ['hashed_email', 'hashed_phone']);
    assert.strictEqual(at.minimum_audience_size, 100);
    assert.deepStrictEqual(at.matching_latency_hours, { min: 1, max: 24 });
  });

  it('conversion_tracking projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        conversion_tracking: {
          multi_source_event_dedup: true,
          supported_action_sources: ['website', 'app'],
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const ct = result.structuredContent?.media_buy?.conversion_tracking;
    assert.ok(ct, `conversion_tracking missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.strictEqual(ct.multi_source_event_dedup, true);
    assert.deepStrictEqual(ct.supported_action_sources, ['website', 'app']);
  });

  it('content_standards projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        content_standards: {
          supports_local_evaluation: true,
          supported_channels: ['display', 'olv'],
          supports_webhook_delivery: false,
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const cs = result.structuredContent?.media_buy?.content_standards;
    assert.ok(cs, `content_standards missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.strictEqual(cs.supports_local_evaluation, true);
    assert.deepStrictEqual(cs.supported_channels, ['display', 'olv']);
    assert.strictEqual(cs.supports_webhook_delivery, false);
  });

  it('all three blocks project together when declared together', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        audience_targeting: { supported_identifier_types: ['hashed_email'], minimum_audience_size: 50 },
        conversion_tracking: { multi_source_event_dedup: false },
        content_standards: { supports_local_evaluation: false },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const mb = result.structuredContent?.media_buy;
    assert.ok(mb?.audience_targeting, 'audience_targeting missing');
    assert.ok(mb?.conversion_tracking, 'conversion_tracking missing');
    assert.ok(mb?.content_standards, 'content_standards missing');
  });

  it('rich blocks force corresponding media_buy.features.* booleans to true', async () => {
    // Buyers gating on `features.audience_targeting === false` (the
    // framework's auto-derived default) would otherwise skip the rich
    // block sitting next to it. The projection forces the boolean to
    // true when the rich block is present so feature-gating buyers see
    // the discovery field.
    const server = createAdcpServerFromPlatform(
      basePlatform({
        audience_targeting: { supported_identifier_types: ['hashed_email'], minimum_audience_size: 50 },
        conversion_tracking: { multi_source_event_dedup: false },
        // content_standards intentionally omitted — boolean stays at framework default
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const features = result.structuredContent?.media_buy?.features;
    assert.ok(features, 'features block present');
    assert.strictEqual(features.audience_targeting, true, 'audience_targeting feature flipped to true');
    assert.strictEqual(features.conversion_tracking, true, 'conversion_tracking feature flipped to true');
    // content_standards stays at framework default (false, since not declared)
    assert.notStrictEqual(features.content_standards, true);
  });

  it('brand-protocol capability block projects via overrides.brand', async () => {
    // Brand-rights adopters declare capabilities.brand; the framework
    // projects via the overrides.brand deep-merge seam. When
    // BrandRightsPlatform is supplied, rights: true is auto-derived.
    const platform = {
      capabilities: {
        specialisms: ['brand-rights'],
        creative_agents: [],
        channels: ['display'],
        pricingModels: ['cpm'],
        config: {},
        brand: {
          right_types: ['talent', 'brand_ip'],
          available_uses: ['endorsement', 'likeness'],
          generation_providers: ['midjourney', 'elevenlabs'],
          description: 'Acme Brand-Rights Agent',
        },
      },
      statusMappers: {},
      accounts: {
        resolve: async () => ({
          id: 'br_acc_1',
          name: 'Acme',
          status: 'active',
          metadata: {},
          authInfo: { kind: 'api_key' },
        }),
      },
      brandRights: {
        getBrandIdentity: async () => ({
          brand_id: 'b1',
          house: { domain: 'acme.example.com', name: 'Acme' },
          names: [{ en_US: 'Acme' }],
        }),
        getRights: async () => ({ rights: [] }),
        acquireRights: async req => ({
          rights_id: req.rights_id,
          status: 'rejected',
          brand_id: 'b1',
          reason: 'no rights',
        }),
      },
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const brand = result.structuredContent?.brand;
    assert.ok(brand, 'brand block projected');
    assert.strictEqual(brand.rights, true, 'rights: true auto-derived from BrandRightsPlatform');
    assert.deepStrictEqual(brand.right_types, ['talent', 'brand_ip']);
    assert.deepStrictEqual(brand.available_uses, ['endorsement', 'likeness']);
    assert.deepStrictEqual(brand.generation_providers, ['midjourney', 'elevenlabs']);
    assert.strictEqual(brand.description, 'Acme Brand-Rights Agent');
  });

  it('accounts.resolution: explicit projects onto wire account.require_operator_auth', async () => {
    // Storyboard runner reads `account.require_operator_auth` to grade
    // `sync_accounts` as `'not_applicable'` (rather than `'missing_tool'`)
    // for explicit-mode adopters who correctly don't implement the tool.
    // Without this projection the runner's gate never fires for v6
    // platforms — see runner.ts account-mode capability gate.
    const platform = basePlatform();
    platform.accounts.resolution = 'explicit';
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const account = result.structuredContent?.account;
    assert.ok(account, 'account block projected');
    assert.strictEqual(account.require_operator_auth, true);
  });

  it('explicit capabilities.requireOperatorAuth: true overrides resolution-derived bit', async () => {
    // Either signal alone projects to require_operator_auth: true.
    const platform = basePlatform({ requireOperatorAuth: true });
    platform.accounts.resolution = 'derived';
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    assert.strictEqual(result.structuredContent?.account?.require_operator_auth, true);
  });

  it('accounts.resolution: implicit does NOT project account block (sync_accounts is the correct tool)', async () => {
    const platform = basePlatform();
    platform.accounts.resolution = 'implicit';
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    // Implicit-mode adopters use sync_accounts; require_operator_auth must
    // remain false / unset so the runner does NOT mark sync_accounts as
    // not_applicable.
    const requireOperatorAuth = result.structuredContent?.account?.require_operator_auth;
    assert.notStrictEqual(requireOperatorAuth, true);
  });

  it('capabilities.supportedBillings projects onto wire account.supported_billing', async () => {
    // Retail-media adopters declare ['operator'] so buyers route through
    // operator-billed (Criteo / Amazon) settlement flows. Without this
    // projection buyers default-route to agent-billed pass-through.
    const platform = basePlatform({ supportedBillings: ['operator', 'agent'] });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const account = result.structuredContent?.account;
    assert.ok(account, 'account block projected');
    assert.deepStrictEqual(account.supported_billing, ['operator', 'agent']);
  });

  it('supportedBillings + explicit resolution project together', async () => {
    const platform = basePlatform({ supportedBillings: ['operator'] });
    platform.accounts.resolution = 'explicit';
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const account = result.structuredContent?.account;
    assert.strictEqual(account.require_operator_auth, true);
    assert.deepStrictEqual(account.supported_billing, ['operator']);
  });

  it('explicit resolution without supportedBillings emits account.supported_billing: [\'agent\'] default (regression test for #1186)', async () => {
    // Schema requires supported_billing (minItems: 1) on every emitted
    // account block. Pre-fix, v6 dropped the field when supportedBillings
    // was undefined → capabilities response failed schema validation →
    // storyboard runner auto-downgraded to v2 fallback, cascading errors
    // into every downstream step. Default ['agent'] matches the platform
    // interface contract documented at capabilities.ts:130.
    const platform = basePlatform(); // no supportedBillings
    platform.accounts.resolution = 'explicit';
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const account = result.structuredContent?.account;
    assert.ok(account, 'account block projected (explicit resolution)');
    assert.strictEqual(account.require_operator_auth, true);
    assert.deepStrictEqual(
      account.supported_billing,
      ['agent'],
      'supported_billing must be present and non-empty on every emitted account block'
    );
  });

  it('requireOperatorAuth=true without supportedBillings emits account.supported_billing: [\'agent\'] default (regression test for #1186)', async () => {
    // Same regression as above, triggered via explicit requireOperatorAuth
    // rather than accounts.resolution.
    const platform = basePlatform({ requireOperatorAuth: true });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const account = result.structuredContent?.account;
    assert.ok(account, 'account block projected');
    assert.strictEqual(account.require_operator_auth, true);
    assert.deepStrictEqual(account.supported_billing, ['agent']);
  });

  it('omitting all three leaves get_adcp_capabilities unchanged (no empty media_buy block)', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const mb = result.structuredContent?.media_buy;
    // media_buy may exist with framework-derived defaults — what we want is
    // that the three projection blocks are absent when not declared.
    assert.strictEqual(mb?.audience_targeting, undefined);
    assert.strictEqual(mb?.conversion_tracking, undefined);
    assert.strictEqual(mb?.content_standards, undefined);
  });
});
