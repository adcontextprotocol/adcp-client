// Integration tests for the v6 BrandRightsPlatform specialism.
// Covers the 3 wire tools that have framework dispatch in AdcpToolMap:
// get_brand_identity, get_rights, acquire_rights. The other 2 surfaces
// (update_rights, creative_approval) stay on the merge-seam path until
// they land in AdcpToolMap (v6.1).
//
// Fixtures use the actual wire shapes (per `core.generated.ts`) rather
// than placeholder objects. Validation is `'strict'` on the happy paths
// so future drift between fixtures and wire schema is caught at test
// time — the 'off' workaround used in earlier rounds let real wire-shape
// bugs ship.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
const { PlatformConfigError } = require('../dist/lib/server/decisioning/runtime/validate-platform');

// Wire-shaped fixtures. These mirror `GetBrandIdentitySuccess`,
// `GetRightsSuccess`, `AcquireRightsAcquired`, `AcquireRightsPendingApproval`,
// and `AcquireRightsRejected` exactly so a strict-validating buyer accepts.

const ACME_BRAND_IDENTITY = {
  brand_id: 'brand_acme_42',
  house: { domain: 'acme-corp.example.com', name: 'Acme Corp' },
  names: [{ en_US: 'Acme', en_GB: 'ACME Co.' }],
  description: 'Brand identity for Acme Corp',
  industries: ['retail'],
  keller_type: 'master',
};

const RIGHTS_OFFERING = {
  rights_id: 'rights_endorsement_us',
  brand_id: 'brand_acme_42',
  name: 'Acme endorsement, US',
  description: 'Endorsement rights, US-only, 90-day term',
  right_type: 'brand_ip',
  available_uses: ['endorsement'],
  countries: ['US'],
  pricing_options: [
    {
      pricing_option_id: 'po_flat_100k',
      model: 'flat_rate',
      price: 100000,
      currency: 'USD',
      uses: ['endorsement'],
      period: 'one_time',
    },
  ],
};

function buildAcquired(rightsId, brandId, pricingOptionId) {
  return {
    rights_id: rightsId,
    status: 'acquired',
    brand_id: brandId,
    terms: {
      pricing_option_id: pricingOptionId,
      amount: 100000,
      currency: 'USD',
      uses: ['endorsement'],
      period: 'one_time',
      start_date: '2026-05-01',
      end_date: '2026-12-31',
    },
    generation_credentials: [],
    rights_constraint: {
      rights_id: rightsId,
      rights_agent: { url: 'https://rights.example.com/mcp', id: 'rights-agent' },
      uses: ['endorsement'],
      countries: ['US'],
      valid_from: '2026-05-01T00:00:00Z',
      valid_until: '2026-12-31T23:59:59Z',
    },
  };
}

function brandRightsPlatform(brOverrides = {}) {
  return {
    capabilities: {
      specialisms: ['brand-rights'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'br_acc_1',
        name: 'Acme Tenant',
        status: 'active',
        operator: 'rights.example.com',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    brandRights: {
      getBrandIdentity: async () => ACME_BRAND_IDENTITY,
      getRights: async () => ({ rights: [RIGHTS_OFFERING] }),
      acquireRights: async req => {
        // Demo branch: pre-approved buyers clear sync; everyone else gets pending.
        if (req.buyer.brand_id === 'brand_pre_approved') {
          return buildAcquired(req.rights_id, RIGHTS_OFFERING.brand_id, req.pricing_option_id);
        }
        return {
          rights_id: req.rights_id,
          status: 'pending_approval',
          brand_id: RIGHTS_OFFERING.brand_id,
          detail: 'Awaiting rights-holder counter-signature',
          estimated_response_time: '48h',
        };
      },
      ...brOverrides,
    },
  };
}

const STRICT = { requests: 'strict', responses: 'strict' };

describe('BrandRightsPlatform — 3-method specialism', () => {
  it('get_brand_identity dispatches through brandRights.getBrandIdentity (strict validation)', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: STRICT,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_brand_identity',
        arguments: {
          account: { account_id: 'br_acc_1' },
          brand_id: 'brand_acme_42',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.brand_id, 'brand_acme_42');
    assert.strictEqual(result.structuredContent.house.domain, 'acme-corp.example.com');
  });

  it('get_rights returns wire-shaped offerings under `rights:` (strict validation)', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: STRICT,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          query: 'endorsement rights for Acme',
          uses: ['endorsement'],
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(Array.isArray(result.structuredContent.rights), 'wire field is `rights`, not `offerings`');
    assert.strictEqual(result.structuredContent.rights.length, 1);
    assert.strictEqual(result.structuredContent.rights[0].rights_id, 'rights_endorsement_us');
  });

  it('acquire_rights returns Acquired arm with full wire shape (strict validation)', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: STRICT,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          rights_id: 'rights_endorsement_us',
          pricing_option_id: 'po_flat_100k',
          buyer: { domain: 'preapproved.example.com', brand_id: 'brand_pre_approved' },
          campaign: { description: 'Endorsement campaign', uses: ['endorsement'] },
          revocation_webhook: { url: 'https://buyer.example.com/webhooks/rights' },
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'acquired');
    assert.strictEqual(result.structuredContent.rights_id, 'rights_endorsement_us');
    assert.strictEqual(result.structuredContent.brand_id, 'brand_acme_42');
    assert.ok(result.structuredContent.terms, 'Acquired arm requires terms');
    assert.ok(result.structuredContent.rights_constraint, 'Acquired arm requires rights_constraint');
  });

  it('acquire_rights returns PendingApproval arm with detail + estimated_response_time', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: STRICT,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          rights_id: 'rights_endorsement_us',
          pricing_option_id: 'po_flat_100k',
          buyer: { domain: 'random.example.com', brand_id: 'brand_random' },
          campaign: { description: 'Endorsement campaign', uses: ['endorsement'] },
          revocation_webhook: { url: 'https://buyer.example.com/webhooks/rights' },
          idempotency_key: '22222222-2222-2222-2222-222222222222',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'pending_approval');
    assert.strictEqual(result.structuredContent.estimated_response_time, '48h');
  });

  it('AdcpError thrown from getBrandIdentity projects to wire envelope', async () => {
    // Validation off here because the AdcpError wire envelope path is
    // a different shape than GetBrandIdentitySuccess.
    const server = createAdcpServerFromPlatform(
      brandRightsPlatform({
        getBrandIdentity: async () => {
          throw new AdcpError('REFERENCE_NOT_FOUND', {
            recovery: 'terminal',
            message: 'Brand not found',
            field: 'brand_id',
          });
        },
      }),
      {
        name: 'br-host',
        version: '0.0.1',
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_brand_identity',
        arguments: {
          account: { account_id: 'br_acc_1' },
          brand_id: 'brand_unknown',
        },
      },
    });

    assert.strictEqual(result.isError, true);
    const env = result.structuredContent.adcp_error ?? result.structuredContent;
    assert.strictEqual(env.code, 'REFERENCE_NOT_FOUND');
  });

  it('claiming brand-rights without brandRights field throws PlatformConfigError', () => {
    const platform = brandRightsPlatform();
    delete platform.brandRights;
    assert.throws(
      () =>
        createAdcpServerFromPlatform(platform, {
          name: 'broken',
          version: '0.0.1',
          validation: { requests: 'off', responses: 'off' },
        }),
      err => err instanceof PlatformConfigError && /brand-rights.*brandRights is missing/.test(err.message)
    );
  });

  it('opts.brandRights merge seam fills gaps (updateRights deferred to v6.1)', async () => {
    // The v6 BrandRightsPlatform covers 3 of 5 wire surfaces; update_rights
    // and creative_approval stay on the merge seam until they land in
    // AdcpToolMap. Adopters supply them via opts.brandRights.{updateRights,
    // creativeApproval}; framework wires alongside platform-derived handlers.
    let received;
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      brandRights: {
        // updateRights is NOT in AdcpToolMap so this is a custom-tool-style
        // entry the framework registers via the merge seam — the test
        // verifies the seam at least accepts it without error. (Actual
        // dispatch lives in framework follow-up when AdcpToolMap is widened.)
        updateRights: async params => {
          received = params;
          return { rights_id: params.rights_id, updated_at: '2026-04-28T00:00:00Z' };
        },
      },
    });

    // Platform-derived getRights still works; merge-seam additions don't shadow.
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          query: 'endorsement rights',
          uses: ['endorsement'],
        },
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.rights.length, 1);
    void received; // updateRights wiring is verified at construction; no AdcpToolMap entry yet
  });
});
