const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toWireAccount, toWireSyncAccountRow } = require('../../dist/lib/server/decisioning/account.js');
const { listAccountsResponse, syncAccountsResponse } = require('../../dist/lib/server/responses.js');

const reportingDeliveryState = {
  configuration: {
    delivery_config_id: 'daily-delivery',
    delivery_config_version: 1,
    offering_id: 'delivery-v1',
    active: true,
    feed_purpose: 'analytics',
    report_definition_id: 'media-buy-delivery-v1',
    reporting_profile: 'media_buy_delivery_v1',
    scope: { all_media_buys: true },
    coverage_requirement: 'full',
    required_finality: 'snapshot',
    reconciliation_mode: 'delivery_only',
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT1H' },
  },
  state: 'ready',
  validated_at: '2026-09-03T00:00:00Z',
  activated_at: '2026-09-03T00:00:00Z',
  current_coverage: {
    status: 'full',
    evaluated_at: '2026-09-03T00:00:00Z',
    media_buy_ids: [],
    fully_covered_media_buy_ids: [],
    partially_covered_media_buy_ids: [],
    unsupported_media_buy_ids: [],
    unknown_media_buy_ids: [],
    package_ids: [],
    covered_package_ids: [],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  },
};

describe('account notification_configs projection', () => {
  test('list_accounts projection preserves resolved reporting delivery state', () => {
    const wire = toWireAccount({
      id: 'acc_acme',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {},
      reporting_delivery_configs: [reportingDeliveryState],
    });

    assert.deepStrictEqual(wire.reporting_delivery_configs, [reportingDeliveryState]);
    assert.ok(!JSON.stringify(wire).includes('credentials'));
  });

  test('list_accounts projection rejects reporting delivery state with retained credentials', () => {
    assert.throws(
      () =>
        toWireAccount({
          id: 'acc_acme',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          reporting_delivery_configs: [
            {
              ...reportingDeliveryState,
              configuration: { ...reportingDeliveryState.configuration, credentials: 'must-not-echo' },
            },
          ],
        }),
      /reporting_delivery_configs/
    );
  });

  test('list_accounts projection preserves account-level webhook subscribers and strips credentials', () => {
    const wire = toWireAccount({
      id: 'acc_acme',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {},
      notification_configs: [
        {
          subscriber_id: 'wholesale-feed-sync',
          url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
          event_types: ['product.updated', 'signal.priced', 'wholesale_feed.bulk_change'],
          authentication: {
            schemes: ['Bearer'],
            credentials: 'super-secret-token',
          },
          active: true,
        },
      ],
    });

    assert.deepStrictEqual(wire.notification_configs, [
      {
        subscriber_id: 'wholesale-feed-sync',
        url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
        event_types: ['product.updated', 'signal.priced', 'wholesale_feed.bulk_change'],
        authentication: {
          schemes: ['Bearer'],
        },
        active: true,
      },
    ]);
  });

  test('sync_accounts result projection echoes applied subscribers without credentials', () => {
    const wire = toWireSyncAccountRow({
      brand: { domain: 'acme.example' },
      operator: 'acme-direct',
      account_id: 'acc_acme',
      action: 'updated',
      status: 'active',
      notification_configs: [
        {
          subscriber_id: 'wholesale-feed-sync',
          url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
          event_types: ['product.created'],
          authentication: {
            schemes: ['HMAC-SHA256'],
            credentials: 'shared-secret-that-must-not-echo',
          },
        },
      ],
    });

    assert.deepStrictEqual(wire.notification_configs, [
      {
        subscriber_id: 'wholesale-feed-sync',
        url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
        event_types: ['product.created'],
        authentication: {
          schemes: ['HMAC-SHA256'],
        },
      },
    ]);
  });

  test('sync_accounts result projection preserves resolved reporting delivery state', () => {
    const wire = toWireSyncAccountRow({
      brand: { domain: 'acme.example' },
      operator: 'acme-direct',
      account_id: 'acc_acme',
      action: 'unchanged',
      status: 'active',
      reporting_delivery_configs: [reportingDeliveryState],
    });

    assert.deepStrictEqual(wire.reporting_delivery_configs, [reportingDeliveryState]);
    assert.ok(!JSON.stringify(wire).includes('credentials'));
  });

  test('sync_accounts projection rejects reporting delivery state with retained credentials', () => {
    assert.throws(
      () =>
        toWireSyncAccountRow({
          brand: { domain: 'acme.example' },
          operator: 'acme-direct',
          action: 'updated',
          status: 'active',
          reporting_delivery_configs: [
            {
              ...reportingDeliveryState,
              configuration: { ...reportingDeliveryState.configuration, credentials: 'must-not-echo' },
            },
          ],
        }),
      /reporting_delivery_configs/
    );
  });

  test('account projectors reject credential-bearing reporting setup URLs', () => {
    const stateWithBearerUrl = {
      ...reportingDeliveryState,
      state: 'pending_setup',
      setup: {
        action: 'authorize_provider',
        message: 'Authorize the reporting provider.',
        url: 'https://seller.example/reporting/setup?token=must-not-echo',
      },
    };
    assert.throws(
      () =>
        toWireAccount({
          id: 'acc_acme',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          reporting_delivery_configs: [stateWithBearerUrl],
        }),
      /setup\.url/
    );
    assert.throws(
      () =>
        toWireSyncAccountRow({
          brand: { domain: 'acme.example' },
          operator: 'acme-direct',
          action: 'updated',
          status: 'active',
          reporting_delivery_configs: [stateWithBearerUrl],
        }),
      /setup\.url/
    );
    assert.throws(
      () =>
        toWireAccount({
          id: 'acc_acme',
          name: 'Acme',
          status: 'active',
          ctx_metadata: {},
          reporting_delivery_configs: [
            {
              ...stateWithBearerUrl,
              setup: {
                ...stateWithBearerUrl.setup,
                url: 'https://seller.example/reporting/setup#access_token=must-not-echo',
              },
            },
          ],
        }),
      /setup\.url/
    );

    const wire = toWireAccount({
      id: 'acc_acme',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {},
      reporting_delivery_configs: [
        {
          ...stateWithBearerUrl,
          setup: { ...stateWithBearerUrl.setup, url: 'https://seller.example/reporting/setup#continue' },
        },
      ],
    });
    assert.strictEqual(wire.reporting_delivery_configs[0].setup.url, 'https://seller.example/reporting/setup#continue');
  });

  test('raw list_accounts response builder strips notification credentials and bank details', () => {
    const response = listAccountsResponse({
      accounts: [
        {
          account_id: 'acc_acme',
          name: 'Acme',
          status: 'active',
          billing_entity: {
            legal_name: 'Acme Corp.',
            bank: { account_holder: 'Acme Corp.', iban: 'DE89370400440532013000' },
          },
          notification_configs: [
            {
              subscriber_id: 'wholesale-feed-sync',
              url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
              event_types: ['product.updated'],
              authentication: {
                schemes: ['Bearer'],
                credentials: 'super-secret-token',
              },
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(response.structuredContent.accounts[0].notification_configs[0].authentication, {
      schemes: ['Bearer'],
    });
    assert.equal('bank' in response.structuredContent.accounts[0].billing_entity, false);
  });

  test('raw account response builders reject reporting delivery states with retained credentials', () => {
    const account = {
      brand: { domain: 'acme.example' },
      operator: 'acme.example',
      action: 'updated',
      status: 'active',
      reporting_delivery_configs: [
        {
          ...reportingDeliveryState,
          configuration: { ...reportingDeliveryState.configuration, credentials: 'must-not-echo' },
        },
      ],
    };

    assert.throws(
      () => listAccountsResponse({ accounts: [{ ...account, account_id: 'acc_acme', name: 'Acme' }] }),
      /reporting_delivery_configs/
    );
    assert.throws(() => syncAccountsResponse({ accounts: [account] }), /reporting_delivery_configs/);
  });

  test('raw sync_accounts response builder strips notification credentials and bank details before replay caching', () => {
    const response = syncAccountsResponse({
      accounts: [
        {
          brand: { domain: 'acme.example' },
          operator: 'acme.example',
          action: 'updated',
          status: 'active',
          billing_entity: {
            legal_name: 'Acme Corp.',
            bank: { account_holder: 'Acme Corp.', iban: 'DE89370400440532013000' },
          },
          notification_configs: [
            {
              subscriber_id: 'wholesale-feed-sync',
              url: 'https://buyer.example/webhooks/adcp/wholesale-feed',
              event_types: ['signal.updated'],
              authentication: {
                schemes: ['HMAC-SHA256'],
                credentials: 'shared-secret-that-must-not-echo',
              },
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(response.structuredContent.accounts[0].notification_configs[0].authentication, {
      schemes: ['HMAC-SHA256'],
    });
    assert.equal('bank' in response.structuredContent.accounts[0].billing_entity, false);
  });
});
