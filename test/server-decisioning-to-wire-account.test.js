'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toWireAccount } = require('../dist/lib/server/decisioning/account');

const baseAccount = () => ({
  id: 'acc_42',
  name: 'Acme',
  status: 'active',
  ctx_metadata: {},
  authInfo: { kind: 'api_key' },
});

describe('toWireAccount', () => {
  it('renames id → account_id and strips framework-internal fields', () => {
    const wire = toWireAccount(baseAccount());
    assert.equal(wire.account_id, 'acc_42');
    assert.equal(wire.name, 'Acme');
    assert.equal(wire.status, 'active');
    assert.equal('id' in wire, false);
    assert.equal('ctx_metadata' in wire, false);
    assert.equal('authInfo' in wire, false);
  });

  it('projects brand, operator, advertiser when set', () => {
    const wire = toWireAccount({
      ...baseAccount(),
      brand: { domain: 'acme.com' },
      operator: 'pinnacle.com',
      advertiser: 'acme.com',
    });
    assert.deepEqual(wire.brand, { domain: 'acme.com' });
    assert.equal(wire.operator, 'pinnacle.com');
    assert.equal(wire.advertiser, 'acme.com');
  });

  it('collapses billing.invoicedTo string passthrough and BrandReference → "advertiser"', () => {
    assert.equal(toWireAccount({ ...baseAccount(), billing: { invoicedTo: 'agent' } }).billing, 'agent');
    assert.equal(toWireAccount({ ...baseAccount(), billing: { invoicedTo: 'operator' } }).billing, 'operator');
    assert.equal(
      toWireAccount({ ...baseAccount(), billing: { invoicedTo: { domain: 'amazon.com' } } }).billing,
      'advertiser'
    );
  });

  describe('billing_entity', () => {
    it('passes through legal_name, vat_id, tax_id, registration_number, address, contacts', () => {
      const billing_entity = {
        legal_name: 'Acme Corp.',
        vat_id: 'DE123456789',
        tax_id: 'US-87-6543210',
        registration_number: 'HRB 12345',
        address: {
          street: '1 Acme Way',
          city: 'Berlin',
          postal_code: '10117',
          country: 'DE',
        },
        contacts: [
          { role: 'billing', name: 'Alice', email: 'alice@acme.com' },
          { role: 'legal', name: 'Bob', email: 'legal@acme.com' },
        ],
      };
      const wire = toWireAccount({ ...baseAccount(), billing_entity });
      assert.deepEqual(wire.billing_entity, billing_entity);
    });

    it('strips bank from billing_entity (write-only on response)', () => {
      const wire = toWireAccount({
        ...baseAccount(),
        billing_entity: {
          legal_name: 'Acme Corp.',
          vat_id: 'DE123456789',
          bank: {
            account_holder: 'Acme Corp.',
            iban: 'DE89370400440532013000',
            bic: 'COBADEFFXXX',
          },
        },
      });
      assert.equal('bank' in wire.billing_entity, false, 'bank must NOT appear in projected billing_entity');
      assert.equal(wire.billing_entity.legal_name, 'Acme Corp.');
      assert.equal(wire.billing_entity.vat_id, 'DE123456789');
    });

    it('does not mutate the source billing_entity when stripping bank', () => {
      const billing_entity = {
        legal_name: 'Acme Corp.',
        bank: { account_holder: 'Acme Corp.', iban: 'DE89370400440532013000' },
      };
      toWireAccount({ ...baseAccount(), billing_entity });
      assert.ok(billing_entity.bank, 'source billing_entity.bank must remain intact');
      assert.equal(billing_entity.bank.iban, 'DE89370400440532013000');
    });

    it('omits billing_entity entirely when source is undefined', () => {
      const wire = toWireAccount(baseAccount());
      assert.equal('billing_entity' in wire, false);
    });
  });

  describe('lifecycle and commercial fields', () => {
    it('projects rate_card, payment_terms, credit_limit unchanged', () => {
      const wire = toWireAccount({
        ...baseAccount(),
        rate_card: 'rc_premium_2026',
        payment_terms: 'net_30',
        credit_limit: { amount: 250000, currency: 'USD' },
      });
      assert.equal(wire.rate_card, 'rc_premium_2026');
      assert.equal(wire.payment_terms, 'net_30');
      assert.deepEqual(wire.credit_limit, { amount: 250000, currency: 'USD' });
    });

    it('projects setup payload (pending_approval lifecycle)', () => {
      const setup = {
        url: 'https://acme.com/onboarding/credit-app',
        message: 'Complete the credit application to activate this account.',
        expires_at: '2026-06-01T00:00:00Z',
      };
      const wire = toWireAccount({
        ...baseAccount(),
        status: 'pending_approval',
        setup,
      });
      assert.deepEqual(wire.setup, setup);
    });

    it('projects account_scope and governance_agents', () => {
      const wire = toWireAccount({
        ...baseAccount(),
        account_scope: 'operator_brand',
        governance_agents: [
          { url: 'https://gov.acme.com/mcp', categories: ['budget_authority'] },
        ],
      });
      assert.equal(wire.account_scope, 'operator_brand');
      assert.deepEqual(wire.governance_agents, [
        { url: 'https://gov.acme.com/mcp', categories: ['budget_authority'] },
      ]);
    });

    it('projects reporting_bucket', () => {
      const reporting_bucket = {
        protocol: 's3',
        bucket: 'acme-reporting',
        prefix: 'accounts/acc_42/',
        region: 'us-east-1',
        format: 'parquet',
        file_retention_days: 30,
      };
      const wire = toWireAccount({ ...baseAccount(), reporting_bucket });
      assert.deepEqual(wire.reporting_bucket, reporting_bucket);
    });
  });

  it('omits all optional fields when not set on the source', () => {
    const wire = toWireAccount(baseAccount());
    for (const k of [
      'brand',
      'operator',
      'advertiser',
      'billing',
      'billing_entity',
      'rate_card',
      'payment_terms',
      'credit_limit',
      'setup',
      'account_scope',
      'governance_agents',
      'reporting_bucket',
    ]) {
      assert.equal(k in wire, false, `${k} must be omitted when source has no value`);
    }
  });
});
