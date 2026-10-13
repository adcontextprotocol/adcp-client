'use strict';

// Experimental AdCP 3.3 grants (DR-0025) wired through
// `platform.accounts.trustGrants`: checked before any sync_accounts upsert
// and on account-scoped calls; `grant_absent` only for an established agent.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../dist/lib/server/decisioning/buyer-agent');
const { createTrustGrantGate } = require('../dist/lib/server/index.js');
const { TrustGrantEvaluator, TrustRecordEvaluator, trustRecordUrl } = require('../dist/lib/signing/server.js');

process.env.NODE_ENV = 'test';
const ORIGIN = 'https://buyer.platform.com';
const SIGNER_RECORD = { agents: [{ url: ORIGIN, roles: ['adcp:buying'] }] };

function gate(documents, options = {}) {
  const records = new TrustRecordEvaluator({
    now: () => 1000,
    fetch: async url => {
      const document = documents[url];
      return document === undefined ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(document) };
    },
  });
  return createTrustGrantGate({ evaluator: new TrustGrantEvaluator(records, { now: () => 1000 }), ...options });
}

function build(trustGrants, touched, { account: accountOverride } = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    agentRegistry: BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async agent_url => ({
        agent_url,
        display_name: 'Buyer',
        status: 'active',
        billing_capabilities: new Set(['operator', 'agent', 'advertiser']),
      }),
    }),
    accounts: {
      trustGrants,
      resolve: async ref => {
        if (ref == null) return null;
        if (accountOverride !== undefined) return accountOverride(ref);
        return {
          id: ref.account_id ?? 'acc_1',
          name: 'Acme',
          status: 'active',
          brand: { domain: 'brand.com' },
          operator: 'platform.com',
          metadata: {},
          authInfo: { kind: 'api_key' },
        };
      },
      upsert: async refs => {
        touched.push('upsert');
        return refs.map((ref, i) => ({
          account_id: `acc_${i}`,
          brand: ref.brand,
          operator: ref.operator,
          action: 'created',
          status: 'active',
        }));
      },
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => {
        touched.push('products');
        return { cache_scope: 'account', products: [] };
      },
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
      providePerformanceFeedback: async () => ({}),
    },
  };
}

const wbaAuth = () => ({
  token: '',
  clientId: 'principal-1',
  scopes: [],
  extra: {
    credential: markVerifiedHttpSig({
      kind: 'http_sig',
      keyid: 'k'.repeat(43),
      agent_url: ORIGIN,
      verified_at: 1000,
      profile: 'web-bot-auth',
      principal_id: 'principal-1',
    }),
  },
});

const call = (server, name, args, authInfo = wbaAuth()) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } }, authInfo ? { authInfo } : {});

const syncArgs = (operator = 'platform.com') => ({
  idempotency_key: 'sync-accounts-grant-0001',
  accounts: [{ brand: { domain: 'brand.com' }, operator, billing: 'agent' }],
});

const server = (trustGrants, touched, options) =>
  createAdcpServerFromPlatform(build(trustGrants, touched, options), {
    name: 'grants',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });

describe('accounts.trustGrants (DR-0025)', () => {
  it('denies sync_accounts with grant_absent before any upsert', async () => {
    const touched = [];
    const result = await call(
      server(gate({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD, [trustRecordUrl('brand.com')]: { agents: [] } }), touched),
      'sync_accounts',
      syncArgs()
    );
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.deepEqual(result.structuredContent.adcp_error.details, { scope: 'agent', reason: 'grant_absent' });
    assert.deepEqual(touched, []);
  });

  it('allows sync_accounts when the brand grants the signer operator on the chain', async () => {
    const touched = [];
    const result = await call(
      server(
        gate({
          [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
          [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes: ['adcp:media_buying'] }] },
        }),
        touched
      ),
      'sync_accounts',
      syncArgs()
    );
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(touched, ['upsert'], JSON.stringify(result.structuredContent));
  });

  it('re-checks existing accounts on account-scoped calls', async () => {
    const touched = [];
    const result = await call(
      server(gate({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD, [trustRecordUrl('brand.com')]: { agents: [] } }), touched),
      'get_products',
      { buying_mode: 'brief', brief: 'any', account: { account_id: 'acc_1' } }
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.details?.reason, 'grant_absent');
    assert.deepEqual(touched, []);
  });

  it('omits details for a caller without an established agent (oracle clamp)', async () => {
    const touched = [];
    const result = await call(server(gate({}), touched), 'sync_accounts', syncArgs(), {
      token: 't',
      clientId: 'anon',
      scopes: [],
      extra: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.equal(result.structuredContent.adcp_error.details, undefined);
    assert.deepEqual(touched, []);
  });

  it('requires an explicit scope for operations outside media buying', async () => {
    const trustGrants = gate(
      {
        [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
        [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes: ['adcp:media_buying'] }] },
      },
      { claimForAccount: () => ({ brandDomain: 'brand.com', accountOperator: 'platform.com' }) }
    );
    const account = { brand: { domain: 'brand.com' }, operator: 'platform.com' };
    const agent = { agent_url: ORIGIN };
    const authInfo = { credential: wbaAuth().extra.credential };
    await trustGrants.requireAccount(account, { agent, authInfo, operation: 'create_media_buy' });
    await assert.rejects(
      trustGrants.requireAccount(account, { agent, authInfo, operation: 'build_creative' }),
      error => {
        assert.deepEqual(error.details, { scope: 'agent', reason: 'grant_absent' });
        return true;
      }
    );
    // Implicit (same-domain) authority still covers other domains.
    const implicit = gate({ [trustRecordUrl(ORIGIN)]: SIGNER_RECORD });
    await implicit.requireAccount(
      { brand: { domain: 'platform.com' }, operator: 'platform.com' },
      { agent, authInfo, operation: 'build_creative' }
    );
  });

  it('covers list_products and the other media-buy tasks', async () => {
    const trustGrants = gate({
      [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
      [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes: ['adcp:media_buying'] }] },
    });
    const ctx = { agent: { agent_url: ORIGIN }, authInfo: { credential: wbaAuth().extra.credential } };
    for (const operation of ['list_products', 'sync_catalogs', 'log_event']) {
      await trustGrants.requireAccount(
        { brand: { domain: 'brand.com' }, operator: 'platform.com' },
        { ...ctx, operation }
      );
    }
  });

  it('fails closed for an account without a brand or operator unless claimForAccount opts it out', async () => {
    const ctx = {
      agent: { agent_url: ORIGIN },
      authInfo: { credential: wbaAuth().extra.credential },
      operation: 'create_media_buy',
    };
    await assert.rejects(
      gate({}).requireAccount({ brand: { domain: 'brand.com' } }, ctx),
      error => error.details?.reason === 'grant_absent'
    );
    await gate({}, { claimForAccount: () => undefined }).requireAccount({ brand: { domain: 'brand.com' } }, ctx);
  });

  it('checks a natural-key settings update against the existing account', async () => {
    const touched = [];
    const result = await call(
      server(
        gate({
          [trustRecordUrl(ORIGIN)]: SIGNER_RECORD,
          [trustRecordUrl('brand.com')]: { grants: [{ grantee: 'platform.com', scopes: ['adcp:media_buying'] }] },
        }),
        touched
      ),
      'sync_accounts',
      {
        idempotency_key: 'sync-accounts-grant-0002',
        accounts: [{ account: { brand: { domain: 'brand.com' }, operator: 'platform.com' }, payment_terms: 'net_30' }],
      }
    );
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(touched, ['upsert'], JSON.stringify(result.structuredContent));
  });

  it('denies a settings update for an account that does not resolve', async () => {
    const touched = [];
    const result = await call(server(gate({}), touched, { account: () => null }), 'sync_accounts', {
      idempotency_key: 'sync-accounts-grant-0003',
      accounts: [{ account: { account_id: 'missing' }, payment_terms: 'net_30' }],
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.details?.reason, 'grant_absent');
    assert.deepEqual(touched, []);
  });
});

describe('accounts.trustGrants settings updates and not-found resolvers', () => {
  it('treats a resolver that throws AccountNotFoundError like null', async () => {
    const { AccountNotFoundError } = require('../dist/lib/server/index.js');
    const touched = [];
    const result = await call(
      server(gate({}), touched, {
        account: () => {
          throw new AccountNotFoundError();
        },
      }),
      'sync_accounts',
      {
        idempotency_key: 'sync-accounts-grant-0004',
        accounts: [{ account: { account_id: 'missing' }, payment_terms: 'net_30' }],
      }
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.details?.reason, 'grant_absent');
    assert.deepEqual(touched, []);
  });
});

describe('accounts.trustGrants and task polling', () => {
  it('does not re-assert a grant when polling task status', async () => {
    const trustGrants = gate({});
    await trustGrants.requireAccount(
      { brand: { domain: 'brand.com' }, operator: 'platform.com' },
      { operation: 'get_task_status' }
    );
  });
});
