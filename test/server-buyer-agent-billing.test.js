'use strict';

// Phase 2 of #1292 — framework-level sync_accounts commercial gates.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { suggestBilling } = require('../dist/lib/server/decisioning/buyer-agent');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');

const sampleAgent = overrides => ({
  agent_url: 'https://buyer.example/agent',
  display_name: 'Buyer Agent',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  ...overrides,
});

function buildPlatform({ agent, resolveAgent = async () => agent, capabilities = {}, captures = {} } = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      supportedBillings: ['operator', 'agent', 'advertiser'],
      config: {},
      ...capabilities,
    },
    accounts: {
      resolve: async ref =>
        ref
          ? {
              id: ref.account_id ?? 'acc_1',
              name: 'Acme',
              status: 'active',
              brand: ref.brand,
              operator: ref.operator,
            }
          : null,
      upsert: async refs => {
        captures.upsertCalls = (captures.upsertCalls ?? 0) + 1;
        captures.lastUpsertRefs = refs;
        return refs.map(ref => ({
          account_id: 'acc_1',
          brand: ref.brand,
          operator: ref.operator,
          action: 'created',
          status: 'active',
          billing: ref.billing,
        }));
      },
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ cache_scope: 'account', products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    agentRegistry: {
      resolve: resolveAgent,
    },
  };
}

function createServer(platform, opts = {}) {
  return createAdcpServerFromPlatform(platform, {
    name: 'billing-gate-test',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    resolveIdempotencyPrincipal: () => 'buyer-agent',
    ...opts,
  });
}

function syncAccountsBatch(server, accounts, extra = {}) {
  return server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          idempotency_key: extra.idempotency_key ?? '11111111-1111-1111-1111-111111111111',
          accounts,
        },
      },
    },
    {
      authInfo: {
        clientId: 'buyer-agent',
        credential: { kind: 'api_key', key_id: 'buyer-key' },
      },
    }
  );
}

function syncAccounts(server, account, extra = {}) {
  return syncAccountsBatch(server, [account], extra);
}

describe('BuyerAgent billing suggestions', () => {
  it('selects one suggested billing value using operator > advertiser > agent', () => {
    assert.equal(suggestBilling(new Set(['agent', 'advertiser', 'operator']), 'agent'), 'operator');
    assert.equal(suggestBilling(new Set(['advertiser', 'agent']), 'operator'), 'advertiser');
    assert.equal(suggestBilling(new Set(['agent']), 'operator'), 'agent');
    assert.equal(suggestBilling(new Set(), 'agent'), undefined);
  });
});

describe('sync_accounts billing enforcement', () => {
  it('rejects per-agent billing mismatch with clamped BILLING_NOT_PERMITTED_FOR_AGENT details', async () => {
    const captures = {};
    const server = createServer(
      buildPlatform({ agent: sampleAgent({ billing_capabilities: new Set(['operator']) }), captures })
    );

    const result = await syncAccounts(server, {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'agent',
    });

    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const row = result.structuredContent.accounts[0];
    assert.equal(row.action, 'failed');
    assert.equal(row.status, 'rejected');
    assert.equal(row.errors[0].code, 'BILLING_NOT_PERMITTED_FOR_AGENT');
    assert.equal(row.errors[0].recovery, 'correctable');
    assert.deepEqual(row.errors[0].details, {
      rejected_billing: 'agent',
      suggested_billing: 'operator',
    });
    assert.equal(row.errors[0].details.permitted_billing, undefined);
    assert.equal(captures.upsertCalls ?? 0, 0, 'rejected entry must not reach accounts.upsert');
  });

  it('omits suggested_billing when the agent has no accepted fallback', async () => {
    const server = createServer(buildPlatform({ agent: sampleAgent({ billing_capabilities: new Set() }) }));

    const result = await syncAccounts(server, {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'agent',
    });

    const details = result.structuredContent.accounts[0].errors[0].details;
    assert.deepEqual(details, { rejected_billing: 'agent' });
  });

  it('rejects seller-wide unsupported billing with capability-scoped BILLING_NOT_SUPPORTED', async () => {
    const server = createServer(
      buildPlatform({
        agent: sampleAgent({ billing_capabilities: new Set(['operator', 'agent', 'advertiser']) }),
        capabilities: { supportedBillings: ['operator'] },
      })
    );

    const result = await syncAccounts(server, {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'advertiser',
    });

    const error = result.structuredContent.accounts[0].errors[0];
    assert.equal(error.code, 'BILLING_NOT_SUPPORTED');
    assert.equal(error.details.scope, 'capability');
    assert.deepEqual(error.details.supported_billing, ['operator']);
  });

  it('clamps bearer-without-mapping to BILLING_NOT_SUPPORTED with details.scope omitted', async () => {
    const server = createServer(
      buildPlatform({
        resolveAgent: async () => null,
        capabilities: { supportedBillings: ['agent'] },
      })
    );

    const result = await syncAccounts(server, {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'agent',
    });

    const error = result.structuredContent.accounts[0].errors[0];
    assert.equal(error.code, 'BILLING_NOT_SUPPORTED');
    assert.equal(error.details?.scope, undefined);
  });

  it('rejects unsupported payment_terms when supportedPaymentTerms is declared', async () => {
    const server = createServer(
      buildPlatform({
        agent: sampleAgent({ billing_capabilities: new Set(['operator']) }),
        capabilities: { supportedPaymentTerms: ['net_30'] },
      })
    );

    const result = await syncAccounts(server, {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'operator',
      payment_terms: 'net_60',
    });

    assert.equal(result.structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  });

  it('preserves original order when commercial policy filters a mixed batch', async () => {
    const captures = {};
    const server = createServer(
      buildPlatform({ agent: sampleAgent({ billing_capabilities: new Set(['operator']) }), captures })
    );

    const result = await syncAccountsBatch(server, [
      {
        brand: { domain: 'ok-1.example' },
        operator: 'agency.example',
        billing: 'operator',
      },
      {
        brand: { domain: 'blocked.example' },
        operator: 'agency.example',
        billing: 'agent',
      },
      {
        brand: { domain: 'ok-2.example' },
        operator: 'agency.example',
        billing: 'operator',
      },
    ]);

    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(captures.upsertCalls, 1);
    assert.deepEqual(
      captures.lastUpsertRefs.map(ref => ref.brand.domain),
      ['ok-1.example', 'ok-2.example']
    );

    const rows = result.structuredContent.accounts;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].brand.domain, 'ok-1.example');
    assert.equal(rows[1].status, 'rejected');
    assert.equal(rows[1].brand.domain, 'blocked.example');
    assert.equal(rows[1].errors[0].code, 'BILLING_NOT_PERMITTED_FOR_AGENT');
    assert.equal(rows[2].status, 'active');
    assert.equal(rows[2].brand.domain, 'ok-2.example');
  });

  it('returns a service diagnostic when accounts.upsert omits accepted batch rows', async () => {
    const platform = buildPlatform({ agent: sampleAgent({ billing_capabilities: new Set(['operator']) }) });
    platform.accounts.upsert = async refs =>
      refs.slice(0, 1).map(ref => ({
        account_id: 'acc_1',
        brand: ref.brand,
        operator: ref.operator,
        action: 'created',
        status: 'active',
        billing: ref.billing,
      }));
    const server = createServer(platform, { exposeErrorDetails: true });

    const result = await syncAccountsBatch(server, [
      {
        brand: { domain: 'ok-1.example' },
        operator: 'agency.example',
        billing: 'operator',
      },
      {
        brand: { domain: 'ok-2.example' },
        operator: 'agency.example',
        billing: 'operator',
      },
    ]);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.match(
      result.structuredContent.adcp_error.message,
      /sync_accounts accounts\.upsert returned 1 row for 2 accepted account entries/
    );
  });

  it('emits BRAND_REQUIRED when a billable account sync entry has no brand or account_id', async () => {
    const server = createServer(buildPlatform({ agent: sampleAgent({ billing_capabilities: new Set(['agent']) }) }));

    const result = await syncAccounts(server, { billing: 'agent' });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'BRAND_REQUIRED');
    assert.equal(result.structuredContent.adcp_error.recovery, 'correctable');
  });

  it('does not idempotency-cache billing rejection rows across capability changes', async () => {
    let currentAgent = sampleAgent({ billing_capabilities: new Set(['operator']) });
    const captures = {};
    const platform = buildPlatform({
      captures,
      resolveAgent: async () => currentAgent,
    });
    const idempotency = createIdempotencyStore({
      backend: memoryBackend({ sweepIntervalMs: 0 }),
      ttlSeconds: 86400,
    });
    const server = createServer(platform, { idempotency });
    const account = {
      brand: { domain: 'acme.example' },
      operator: 'agency.example',
      billing: 'agent',
    };
    const key = 'same-key-billing-retry-0001';

    const first = await syncAccounts(server, account, { idempotency_key: key });
    assert.equal(first.structuredContent.accounts[0].errors[0].code, 'BILLING_NOT_PERMITTED_FOR_AGENT');

    currentAgent = sampleAgent({ billing_capabilities: new Set(['operator', 'agent']) });
    const second = await syncAccounts(server, account, { idempotency_key: key });

    assert.equal(captures.upsertCalls, 1, 'retry after capability change must execute accounts.upsert');
    assert.equal(second.structuredContent.accounts[0].status, 'active');
    assert.equal(second.structuredContent.replayed, undefined);
  });
});
