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

async function dispatchCapabilities(server, args = {}) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: args },
  });
}

describe('Capability projections — declarative capability blocks on DecisioningCapabilities', () => {
  it('modern platform servers advertise canonical creatives by default', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'canonical-default',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    assert.strictEqual(result.structuredContent?.media_buy?.features?.canonical_creatives, true);
  });

  it('3.0-pinned servers reject newer release claims and advertise only their real legacy support', async () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(
          basePlatform({
            features: { canonicalCreatives: true },
            supported_versions: ['3.0', '3.2'],
          }),
          {
            name: 'invalid-newer-release-claim',
            version: '4.0.0',
            adcpVersion: '3.0.12',
            validation: { requests: 'off', responses: 'off' },
          }
        ),
      /newer than the configured server schema 3\.0\.12/
    );

    const server = createAdcpServerFromPlatform(
      basePlatform({ features: { canonicalCreatives: true }, supported_versions: ['3.0'] }),
      {
        name: 'canonical-legacy-pin',
        version: '4.0.0',
        adcpVersion: '3.0.12',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await dispatchCapabilities(server);
    assert.notStrictEqual(result.structuredContent?.media_buy?.features?.canonical_creatives, true);
    assert.strictEqual(
      result.structuredContent?.adcp?.supported_versions,
      undefined,
      '3.0 capability responses predate release-precision supported_versions'
    );
  });

  it('serves get_adcp_capabilities at the mutually selected 3.0 release', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        supported_versions: ['3.0', '3.1'],
        overrides: {
          oauth: { supported: true },
          measurement: { supported: true },
          wholesale_feed_versioning: { supported: true },
          adcp: {
            capability_changes: { supported: true },
            governance_enforcement: { mode: 'strict' },
            idempotency: { supported: true, replay_ttl_seconds: 3600, in_flight_max_seconds: 30 },
          },
          account: { timezone: { supported: true }, notifications: { supported: true } },
          media_buy: {
            buying_modes: ['brief'],
            budget_capping: { supported: true },
            supported_pricing_models: ['cpm', 'revenue_share'],
            features: { canonical_creatives: true, seller_optimized_budget: true },
            execution: {
              targeting: {
                geo_postal_areas: {
                  us_zip: true,
                  us_zip_plus_four: true,
                  US: ['zip', 'zip_plus_four'],
                  NL: ['postal_code'],
                },
              },
            },
          },
          signals: { discovery_modes: ['brief'] },
          governance: { runtime_attestations: { supported: true } },
          creative: { supports_transformers: true, preview: { supported: true } },
          request_signing: { protocol_methods_required_for: ['tools/call'] },
          identity: { brand_json_url: 'https://seller.example/.well-known/brand.json' },
          specialisms: ['sales-non-guaranteed', 'creative-transformers', 'sponsored-intelligence'],
          supported_protocols: ['media_buy', 'measurement'],
        },
      }),
      {
        name: 'capability-downshift',
        version: '4.0.0',
        validation: { requests: 'off', responses: 'strict' },
      }
    );

    const result = await dispatchCapabilities(server, { adcp_version: '3.0' });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent?.adcp_version, undefined);
    assert.strictEqual(result.structuredContent?.adcp?.supported_versions, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.features?.canonical_creatives, undefined);
    assert.strictEqual(result.structuredContent?.library_version, undefined);
    assert.strictEqual(result.structuredContent?.oauth, undefined);
    assert.strictEqual(result.structuredContent?.measurement, undefined);
    assert.strictEqual(result.structuredContent?.wholesale_feed_versioning, undefined);
    assert.strictEqual(result.structuredContent?.adcp?.capability_changes, undefined);
    assert.strictEqual(result.structuredContent?.adcp?.idempotency?.in_flight_max_seconds, undefined);
    assert.strictEqual(result.structuredContent?.adcp?.idempotency?.replay_ttl_seconds, 3600);
    assert.strictEqual(result.structuredContent?.account?.timezone, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.buying_modes, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.budget_capping, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.features?.seller_optimized_budget, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.execution?.targeting?.geo_postal_areas?.US, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.execution?.targeting?.geo_postal_areas?.NL, undefined);
    assert.strictEqual(result.structuredContent?.media_buy?.execution?.targeting?.geo_postal_areas?.us_zip, true);
    assert.strictEqual(
      result.structuredContent?.media_buy?.execution?.targeting?.geo_postal_areas?.us_zip_plus_four,
      true
    );
    assert.strictEqual(result.structuredContent?.signals?.discovery_modes, undefined);
    assert.strictEqual(result.structuredContent?.governance?.runtime_attestations, undefined);
    assert.strictEqual(result.structuredContent?.creative?.supports_transformers, undefined);
    assert.strictEqual(result.structuredContent?.creative?.preview, undefined);
    assert.strictEqual(result.structuredContent?.request_signing?.protocol_methods_required_for, undefined);
    assert.strictEqual(result.structuredContent?.identity?.brand_json_url, undefined);
    assert.deepStrictEqual(result.structuredContent?.supported_protocols, ['media_buy']);
    assert.deepStrictEqual(result.structuredContent?.specialisms, ['sales-non-guaranteed']);
    assert.deepStrictEqual(result.structuredContent?.media_buy?.supported_pricing_models, ['cpm']);
  });

  it('rejects 2.x capability negotiation before response projection', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        supported_versions: ['2.5', '3.2'],
        overrides: {
          adcp: { capability_changes: { supported: true } },
          media_buy: {
            lifecycle_tools: ['create_media_buy', 'sync_media_buy'],
            proposal_refinement: { supported: true },
            features: { canonical_creatives: true },
          },
        },
      }),
      {
        name: 'capability-2x-downshift',
        version: '4.0.0',
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const result = await dispatchCapabilities(server, { adcp_version: '2.5' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent?.adcp_error?.code, 'VERSION_UNSUPPORTED');
    assert.match(result.structuredContent?.adcp_error?.message ?? '', /not defined.*2\.5/i);
  });

  it('canonical creative capability remains authoritative over adopter overrides', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        features: { canonicalCreatives: false },
        overrides: { media_buy: { features: { canonical_creatives: false } } },
      }),
      { name: 'canonical-authoritative', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    assert.strictEqual(result.structuredContent?.media_buy?.features?.canonical_creatives, true);
  });

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
    assert.strictEqual(
      ct.supported_targets,
      undefined,
      'omitted supported_targets must stay omitted; target-less event goals are the only guaranteed default'
    );
  });

  it('conversion_tracking preserves explicit supported_targets override', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        conversion_tracking: {
          supported_targets: ['cost_per', 'per_ad_spend'],
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    assert.deepStrictEqual(result.structuredContent?.media_buy?.conversion_tracking?.supported_targets, [
      'cost_per',
      'per_ad_spend',
    ]);
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

  it('targeting projects postal-area capabilities in native and deprecated forms', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        targeting: {
          geo_countries: true,
          geo_postal_areas: {
            us_zip: true,
            US: ['zip_plus_four'],
            GB: ['outward'],
            gb_full: true,
            NL: ['postal_code'],
            ca_fsa: false,
          },
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const targeting = result.structuredContent?.media_buy?.execution?.targeting;
    assert.ok(targeting, `targeting missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.strictEqual(targeting.geo_countries, true);
    assert.deepStrictEqual(targeting.geo_postal_areas.US, ['zip', 'zip_plus_four']);
    assert.deepStrictEqual(targeting.geo_postal_areas.GB, ['outward', 'full']);
    assert.deepStrictEqual(targeting.geo_postal_areas.NL, ['postal_code']);
    assert.strictEqual(targeting.geo_postal_areas.us_zip, true);
    assert.strictEqual(targeting.geo_postal_areas.us_zip_plus_four, true);
    assert.strictEqual(targeting.geo_postal_areas.gb_outward, true);
    assert.strictEqual(targeting.geo_postal_areas.gb_full, true);
    assert.strictEqual(targeting.geo_postal_areas.ca_fsa, undefined);
  });

  it('targeting rejects invalid postal-area capability keys and systems before projection', () => {
    assert.throws(
      () =>
        createAdcpServerFromPlatform(
          basePlatform({
            targeting: {
              geo_postal_areas: { NL: ['outward'] },
            },
          }),
          { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
        ),
      /Invalid geo_postal_areas support for NL/
    );

    assert.throws(
      () =>
        createAdcpServerFromPlatform(
          basePlatform({
            targeting: {
              geo_postal_areas: { foo: ['postal_code'] },
            },
          }),
          { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
        ),
      /Invalid geo_postal_areas key "foo"/
    );
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

  it('forwards AdcpCapabilitiesConfig passthroughs declared on DecisioningCapabilities', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        features: {
          canonicalCreatives: true,
          inlineCreativeManagement: true,
          propertyListFiltering: true,
          audienceTargeting: false,
        },
        audience_targeting: {
          supported_identifier_types: ['hashed_email'],
          minimum_audience_size: 50,
        },
        targeting: {
          geo_countries: true,
        },
        creative: {
          supportsCompliance: false,
          hasCreativeLibrary: false,
          supportsGeneration: true,
          supportsTransformation: false,
        },
        account: {
          requireOperatorAuth: false,
          supportedBilling: ['agent'],
          defaultBilling: 'agent',
          requiredForProducts: true,
          sandbox: true,
        },
        requireOperatorAuth: true,
        supportedBillings: ['operator'],
        supported_versions: ['3.1'],
        overrides: {
          media_buy: {
            execution: {
              targeting: {
                keyword_targets: {
                  supported_match_types: ['exact'],
                },
              },
            },
          },
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );

    const result = await dispatchCapabilities(server);
    const caps = result.structuredContent;

    assert.deepStrictEqual(caps?.adcp?.supported_versions, ['3.1']);
    assert.strictEqual(caps?.media_buy?.features?.canonical_creatives, true);
    assert.strictEqual(caps?.media_buy?.features?.inline_creative_management, true);
    assert.strictEqual(caps?.media_buy?.features?.property_list_filtering, true);
    assert.strictEqual(caps?.media_buy?.features?.audience_targeting, true);
    assert.strictEqual(caps?.media_buy?.execution?.targeting?.geo_countries, true);
    assert.deepStrictEqual(caps?.media_buy?.execution?.targeting?.keyword_targets?.supported_match_types, ['exact']);
    assert.strictEqual(caps?.creative?.supports_generation, true);
    assert.strictEqual(caps?.account?.required_for_products, true);
    assert.strictEqual(caps?.account?.sandbox, true);
    assert.strictEqual(caps?.account?.require_operator_auth, true);
    assert.deepStrictEqual(caps?.account?.supported_billing, ['operator']);
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
        getRightsLegacy: async () => ({ rights: [] }),
        acquireRightsLegacy: async req => ({
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

  it("explicit resolution without supportedBillings emits account.supported_billing: ['agent'] default (regression test for #1186)", async () => {
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

  it("requireOperatorAuth=true without supportedBillings emits account.supported_billing: ['agent'] default (regression test for #1186)", async () => {
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

  it('omitting all five leaves get_adcp_capabilities unchanged (no empty media_buy block)', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const mb = result.structuredContent?.media_buy;
    // media_buy may exist with framework-derived defaults — what we want is
    // that the projection blocks are absent when not declared.
    assert.strictEqual(mb?.audience_targeting, undefined);
    assert.strictEqual(mb?.conversion_tracking, undefined);
    assert.strictEqual(mb?.content_standards, undefined);
    assert.strictEqual(mb?.supported_optimization_metrics, undefined);
    assert.strictEqual(mb?.frequency_capping, undefined);
  });

  // AdCP 3.1 additions — adcp#4669 (supported_optimization_metrics) +
  // adcp#4670 (frequency_capping). Closes adcp-client#1853 projection gap.

  it('supported_optimization_metrics projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        supported_optimization_metrics: ['clicks', 'completed_views', 'views'],
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const som = result.structuredContent?.media_buy?.supported_optimization_metrics;
    assert.ok(som, `supported_optimization_metrics missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.deepStrictEqual(som, ['clicks', 'completed_views', 'views']);
  });

  it('supported_optimization_metrics auto-derives from a declared product catalog', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        productCatalog: [
          { product_id: 'p1', metric_optimization: { supported_metrics: ['views', 'clicks'] } },
          { product_id: 'p2', metric_optimization: { supported_metrics: ['completed_views', 'views'] } },
        ],
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    assert.deepStrictEqual(result.structuredContent?.media_buy?.supported_optimization_metrics, [
      'clicks',
      'completed_views',
      'views',
    ]);
  });

  it('explicit supported_optimization_metrics wins over productCatalog derivation', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        supported_optimization_metrics: ['clicks'],
        productCatalog: [{ product_id: 'p1', metric_optimization: { supported_metrics: ['views'] } }],
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    assert.deepStrictEqual(result.structuredContent?.media_buy?.supported_optimization_metrics, ['clicks']);
  });

  it('frequency_capping projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        frequency_capping: {
          supported_per_units: ['impression'],
          supported_window_units: ['day', 'week'],
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const fc = result.structuredContent?.media_buy?.frequency_capping;
    assert.ok(fc, `frequency_capping missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.deepStrictEqual(fc.supported_per_units, ['impression']);
    assert.deepStrictEqual(fc.supported_window_units, ['day', 'week']);
  });

  it('the 3.1 additions do NOT flip features.* booleans (presence-of-block is the gate)', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        supported_optimization_metrics: ['clicks'],
        frequency_capping: {
          supported_per_units: ['impression'],
          supported_window_units: ['day'],
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const features = result.structuredContent?.media_buy?.features ?? {};
    // Framework auto-derives the existing flags as `false` when no rich
    // block is declared. The 3.1 additions must NOT flip them to `true` —
    // their gate is presence-of-block, not a features.* mirror.
    assert.notStrictEqual(features.audience_targeting, true);
    assert.notStrictEqual(features.conversion_tracking, true);
    assert.notStrictEqual(features.content_standards, true);
  });
});
