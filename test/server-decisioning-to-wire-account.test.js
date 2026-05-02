'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toWireAccount, toWireSyncAccountRow } = require('../dist/lib/server/decisioning/account');

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

    it('omits billing_entity when only bank is set (no empty {} on the wire)', () => {
      // schema requires legal_name on BusinessEntity; emitting `{}` after
      // strip would fail validation. Project to undefined instead.
      const wire = toWireAccount({
        ...baseAccount(),
        billing_entity: { bank: { account_holder: 'X', iban: 'DE89...' } },
      });
      assert.equal('billing_entity' in wire, false);
    });

    it('handles bank: undefined cleanly (no empty {} either)', () => {
      const wire = toWireAccount({
        ...baseAccount(),
        billing_entity: { bank: undefined },
      });
      assert.equal('billing_entity' in wire, false);
    });

    it('strips bank against a class-instance billing_entity', () => {
      class BE {
        constructor() {
          this.legal_name = 'Acme Corp.';
          this.vat_id = 'DE123456789';
          this.bank = { account_holder: 'Acme', iban: 'DE89...' };
        }
      }
      const wire = toWireAccount({ ...baseAccount(), billing_entity: new BE() });
      assert.equal('bank' in wire.billing_entity, false);
      assert.equal(wire.billing_entity.legal_name, 'Acme Corp.');
      assert.equal(wire.billing_entity.vat_id, 'DE123456789');
    });

    it('strips bank against a no-prototype billing_entity (Object.create(null))', () => {
      const entity = Object.create(null);
      entity.legal_name = 'Acme';
      entity.bank = { iban: 'DE89...' };
      const wire = toWireAccount({ ...baseAccount(), billing_entity: entity });
      assert.equal('bank' in wire.billing_entity, false);
      assert.equal(wire.billing_entity.legal_name, 'Acme');
    });

    it('strips bank when defined as enumerable getter', () => {
      const entity = { legal_name: 'Acme' };
      Object.defineProperty(entity, 'bank', {
        enumerable: true,
        configurable: true,
        get() {
          return { iban: 'DE89...' };
        },
      });
      const wire = toWireAccount({ ...baseAccount(), billing_entity: entity });
      assert.equal('bank' in wire.billing_entity, false);
      assert.equal(wire.billing_entity.legal_name, 'Acme');
    });

    it('preserves all other optional fields when stripping bank from a fully-populated entity', () => {
      const billing_entity = {
        legal_name: 'Acme Corp.',
        vat_id: 'DE123456789',
        tax_id: 'US-87-6543210',
        registration_number: 'HRB 12345',
        address: { street: '1 Acme Way', city: 'Berlin', postal_code: '10117', country: 'DE' },
        contacts: [{ role: 'billing', name: 'Alice', email: 'alice@acme.com' }],
        bank: { account_holder: 'Acme', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
      };
      const wire = toWireAccount({ ...baseAccount(), billing_entity });
      assert.equal('bank' in wire.billing_entity, false);
      for (const k of ['legal_name', 'vat_id', 'tax_id', 'registration_number', 'address', 'contacts']) {
        assert.deepEqual(wire.billing_entity[k], billing_entity[k]);
      }
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

    it('drops unknown keys on governance_agents elements (credential smuggling guard)', () => {
      // Schema notes governance auth credentials are write-only; the wire type
      // already excludes them, but adopters using JS / `as any` could otherwise
      // smuggle a credentials field straight to the wire. Element-level
      // projection closes that gap.
      const wire = toWireAccount({
        ...baseAccount(),
        governance_agents: [
          {
            url: 'https://gov.acme.com/mcp',
            categories: ['budget_authority'],
            credentials: { token: 'secret_should_never_appear' },
            api_key: 'secret_should_never_appear',
          },
        ],
      });
      assert.equal('credentials' in wire.governance_agents[0], false);
      assert.equal('api_key' in wire.governance_agents[0], false);
      assert.equal(wire.governance_agents[0].url, 'https://gov.acme.com/mcp');
      assert.deepEqual(wire.governance_agents[0].categories, ['budget_authority']);
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

  it('projects billing_proxy, sandbox, ext when set', () => {
    const wire = toWireAccount({
      ...baseAccount(),
      billing_proxy: 'pinnacle.com',
      sandbox: true,
      ext: { custom_field: 'value' },
    });
    assert.equal(wire.billing_proxy, 'pinnacle.com');
    assert.equal(wire.sandbox, true);
    assert.deepEqual(wire.ext, { custom_field: 'value' });
  });

  it('omits all optional fields when not set on the source', () => {
    const wire = toWireAccount(baseAccount());
    for (const k of [
      'brand',
      'operator',
      'advertiser',
      'billing_proxy',
      'billing',
      'billing_entity',
      'rate_card',
      'payment_terms',
      'credit_limit',
      'setup',
      'account_scope',
      'governance_agents',
      'reporting_bucket',
      'sandbox',
      'ext',
    ]) {
      assert.equal(k in wire, false, `${k} must be omitted when source has no value`);
    }
  });
});

describe('toWireSyncAccountRow', () => {
  const baseRow = () => ({
    brand: { domain: 'acme.com' },
    operator: 'acme.com',
    action: 'created',
    status: 'active',
  });

  it('passes through the required wire fields', () => {
    const wire = toWireSyncAccountRow(baseRow());
    assert.deepEqual(wire, {
      brand: { domain: 'acme.com' },
      operator: 'acme.com',
      action: 'created',
      status: 'active',
    });
  });

  it('strips billing_entity.bank on adopter rows (no leak when adopter spreads a DB record)', () => {
    // The realistic leak: adopter does `{ ...db.findByBrand(r.brand), action: 'updated' }`
    // and the DB row carries bank coordinates collected during onboarding.
    const wire = toWireSyncAccountRow({
      ...baseRow(),
      action: 'updated',
      billing_entity: {
        legal_name: 'Acme Corp.',
        vat_id: 'DE123456789',
        bank: {
          account_holder: 'Acme Corp.',
          iban: 'DE89370400440532013000',
        },
      },
    });
    assert.equal('bank' in wire.billing_entity, false, 'bank MUST NOT appear on sync_accounts response');
    assert.equal(wire.billing_entity.legal_name, 'Acme Corp.');
    assert.equal(wire.billing_entity.vat_id, 'DE123456789');
  });

  it('omits billing_entity when only bank is set (parity with toWireAccount)', () => {
    const wire = toWireSyncAccountRow({
      ...baseRow(),
      billing_entity: { bank: { iban: 'DE89...' } },
    });
    assert.equal('billing_entity' in wire, false);
  });

  it('projects setup, billing, account_scope, rate_card, payment_terms, credit_limit', () => {
    const setup = {
      url: 'https://acme.com/onboarding/credit-app',
      message: 'Complete the credit application to activate this account.',
      expires_at: '2026-06-01T00:00:00Z',
    };
    const wire = toWireSyncAccountRow({
      ...baseRow(),
      action: 'created',
      status: 'pending_approval',
      billing: 'agent',
      account_scope: 'operator_brand',
      setup,
      rate_card: 'rc_premium_2026',
      payment_terms: 'net_30',
      credit_limit: { amount: 250000, currency: 'USD' },
    });
    assert.equal(wire.billing, 'agent');
    assert.equal(wire.account_scope, 'operator_brand');
    assert.deepEqual(wire.setup, setup);
    assert.equal(wire.rate_card, 'rc_premium_2026');
    assert.equal(wire.payment_terms, 'net_30');
    assert.deepEqual(wire.credit_limit, { amount: 250000, currency: 'USD' });
  });

  it('projects account_id, name, errors, warnings, sandbox', () => {
    const wire = toWireSyncAccountRow({
      ...baseRow(),
      account_id: 'acc_42',
      name: 'Acme c/o Pinnacle',
      action: 'failed',
      errors: [{ code: 'CREDIT_DECLINED', message: 'Credit application denied.' }],
      warnings: ['Operator domain not yet verified.'],
      sandbox: false,
    });
    assert.equal(wire.account_id, 'acc_42');
    assert.equal(wire.name, 'Acme c/o Pinnacle');
    assert.deepEqual(wire.errors, [{ code: 'CREDIT_DECLINED', message: 'Credit application denied.' }]);
    assert.deepEqual(wire.warnings, ['Operator domain not yet verified.']);
    assert.equal(wire.sandbox, false);
  });

  it('omits all optional fields when source carries only the required four', () => {
    const wire = toWireSyncAccountRow(baseRow());
    for (const k of [
      'account_id',
      'name',
      'billing',
      'billing_entity',
      'account_scope',
      'setup',
      'rate_card',
      'payment_terms',
      'credit_limit',
      'errors',
      'warnings',
      'sandbox',
    ]) {
      assert.equal(k in wire, false, `${k} must be omitted when source has no value`);
    }
  });
});
