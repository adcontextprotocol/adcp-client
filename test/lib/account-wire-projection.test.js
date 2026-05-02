// Tests for toWireAccount — confirms v3 field projection and write-only bank strip.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { toWireAccount } = require('../../dist/lib/server/decisioning/account');

function baseAccount(overrides = {}) {
  return {
    id: 'acc_1',
    name: 'Acme Corp',
    status: 'active',
    ctx_metadata: {},
    authInfo: { kind: 'api_key' },
    ...overrides,
  };
}

describe('toWireAccount — v3 field projection', () => {
  it('projects existing fields unchanged', () => {
    const wire = toWireAccount(
      baseAccount({
        brand: { domain: 'acme.example' },
        operator: 'agency.example',
        advertiser: 'acme.example',
        billing: { invoicedTo: 'operator' },
      })
    );
    assert.strictEqual(wire.account_id, 'acc_1');
    assert.strictEqual(wire.name, 'Acme Corp');
    assert.strictEqual(wire.status, 'active');
    assert.deepStrictEqual(wire.brand, { domain: 'acme.example' });
    assert.strictEqual(wire.operator, 'agency.example');
    assert.strictEqual(wire.advertiser, 'acme.example');
    assert.strictEqual(wire.billing, 'operator');
  });

  it('strips billing_entity.bank and emits the rest', () => {
    const account = baseAccount({
      billing_entity: {
        legal_name: 'Acme Legal GmbH',
        vat_id: 'DE123456789',
        bank: {
          account_holder: 'Acme Legal GmbH',
          iban: 'XX00000000000000000000',
          bic: 'TESTBIC0XXX',
        },
      },
    });
    const wire = toWireAccount(account);
    assert.ok(wire.billing_entity, 'billing_entity should be present');
    assert.strictEqual(wire.billing_entity.legal_name, 'Acme Legal GmbH');
    assert.strictEqual(wire.billing_entity.vat_id, 'DE123456789');
    assert.ok(!('bank' in wire.billing_entity), 'bank must be stripped from wire output');
  });

  it('emits billing_entity without bank when no bank was set', () => {
    const account = baseAccount({
      billing_entity: { legal_name: 'No Bank Corp' },
    });
    const wire = toWireAccount(account);
    assert.ok(wire.billing_entity);
    assert.strictEqual(wire.billing_entity.legal_name, 'No Bank Corp');
    assert.ok(!('bank' in wire.billing_entity));
  });

  it('passes reporting_bucket through verbatim', () => {
    const bucket = {
      protocol: 's3',
      bucket: 'acme-reports',
      prefix: 'daily/',
      file_retention_days: 30,
    };
    const wire = toWireAccount(baseAccount({ reporting_bucket: bucket }));
    assert.deepStrictEqual(wire.reporting_bucket, bucket);
  });

  it('passes rate_card, payment_terms, credit_limit, setup, account_scope, governance_agents through', () => {
    const account = baseAccount({
      rate_card: 'rc_standard',
      payment_terms: 'net_30',
      credit_limit: { amount: 50000, currency: 'USD' },
      setup: {
        message: 'Complete your credit application',
        url: 'https://example.com/apply',
        expires_at: '2026-06-01T00:00:00Z',
      },
      account_scope: 'brand',
      governance_agents: [{ url: 'https://gov.example.com/mcp', categories: ['budget_authority'] }],
    });
    const wire = toWireAccount(account);
    assert.strictEqual(wire.rate_card, 'rc_standard');
    assert.strictEqual(wire.payment_terms, 'net_30');
    assert.deepStrictEqual(wire.credit_limit, { amount: 50000, currency: 'USD' });
    assert.deepStrictEqual(wire.setup, {
      message: 'Complete your credit application',
      url: 'https://example.com/apply',
      expires_at: '2026-06-01T00:00:00Z',
    });
    assert.strictEqual(wire.account_scope, 'brand');
    assert.deepStrictEqual(wire.governance_agents, [
      { url: 'https://gov.example.com/mcp', categories: ['budget_authority'] },
    ]);
  });

  it('omits new fields from wire when not set — existing adopters unaffected', () => {
    const wire = toWireAccount(baseAccount());
    assert.strictEqual(wire.billing_entity, undefined);
    assert.strictEqual(wire.reporting_bucket, undefined);
    assert.strictEqual(wire.rate_card, undefined);
    assert.strictEqual(wire.payment_terms, undefined);
    assert.strictEqual(wire.credit_limit, undefined);
    assert.strictEqual(wire.setup, undefined);
    assert.strictEqual(wire.account_scope, undefined);
    assert.strictEqual(wire.governance_agents, undefined);
  });
});
