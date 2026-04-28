// Integration tests for the v6 BrandRightsPlatform specialism.
// Covers the 3 wire tools that have framework dispatch in AdcpToolMap:
// get_brand_identity, get_rights, acquire_rights. The other 2 surfaces
// (update_rights, creative_approval) stay on the merge-seam path until
// they land in AdcpToolMap (v6.1).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
const { PlatformConfigError } = require('../dist/lib/server/decisioning/runtime/validate-platform');

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
        operator: 'rights.example.com',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    brandRights: {
      getBrandIdentity: async () => ({
        brand: { domain: 'acme.example.com', brand_id: 'brand_acme' },
        identity: {
          legal_name: 'Acme Corp',
          jurisdictions: ['US'],
          ip_categories: ['trademark', 'character'],
        },
      }),
      getRights: async () => ({
        offerings: [
          {
            rights_id: 'rights_1',
            brand: { domain: 'acme.example.com', brand_id: 'brand_acme' },
            uses: ['endorsement'],
            jurisdictions: ['US'],
            term: { start: '2026-05-01', end: '2026-12-31' },
            pricing_options: [
              {
                pricing_option_id: 'po_flat',
                pricing_model: 'flat',
                fixed_price: 100000,
                currency: 'USD',
              },
            ],
          },
        ],
      }),
      acquireRights: async req => {
        // Demo: pre-approved buyers clear sync; everyone else gets pending
        if (req.buyer.brand_id === 'pre_approved') {
          return {
            rights_grant_id: 'rg_42',
            rights_id: req.rights_id,
            buyer: req.buyer,
            term: { start: '2026-05-01', end: '2026-12-31' },
            uses: ['endorsement'],
            jurisdictions: ['US'],
          };
        }
        return {
          status: 'pending_approval',
          rights_grant_id: 'rg_pending_42',
          rights_id: req.rights_id,
          buyer: req.buyer,
          approval_workflow: { type: 'manual_review', estimated_completion: '2026-05-03' },
        };
      },
      ...brOverrides,
    },
  };
}

describe('BrandRightsPlatform — 3-method specialism', () => {
  it('get_brand_identity dispatches through brandRights.getBrandIdentity', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_brand_identity',
        arguments: {
          account: { account_id: 'br_acc_1' },
          brand: { domain: 'acme.example.com' },
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.identity.legal_name, 'Acme Corp');
  });

  it('get_rights dispatches through brandRights.getRights', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
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
    assert.strictEqual(result.structuredContent.offerings.length, 1);
    assert.strictEqual(result.structuredContent.offerings[0].rights_id, 'rights_1');
  });

  it('acquire_rights returns Acquired arm for pre-approved buyer', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          rights_id: 'rights_1',
          pricing_option_id: 'po_flat',
          buyer: { domain: 'pre_approved.example.com', brand_id: 'pre_approved' },
          campaign: { description: 'Brand campaign', uses: ['endorsement'] },
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.rights_grant_id, 'rg_42');
  });

  it('acquire_rights returns PendingApproval arm for non-pre-approved buyer', async () => {
    const server = createAdcpServerFromPlatform(brandRightsPlatform(), {
      name: 'br-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          account: { account_id: 'br_acc_1' },
          rights_id: 'rights_1',
          pricing_option_id: 'po_flat',
          buyer: { domain: 'random.example.com', brand_id: 'random' },
          campaign: { description: 'Brand campaign', uses: ['endorsement'] },
          idempotency_key: '22222222-2222-2222-2222-222222222222',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'pending_approval');
    assert.strictEqual(result.structuredContent.rights_grant_id, 'rg_pending_42');
  });

  it('AdcpError thrown from getBrandIdentity projects to wire envelope', async () => {
    const server = createAdcpServerFromPlatform(
      brandRightsPlatform({
        getBrandIdentity: async () => {
          throw new AdcpError('REFERENCE_NOT_FOUND', {
            recovery: 'terminal',
            message: 'Brand not found',
            field: 'brand',
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
          brand: { domain: 'unknown.example.com' },
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
});
