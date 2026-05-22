const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toWireAccount, toWireSyncAccountRow } = require('../../dist/lib/server/decisioning/account.js');

describe('account notification_configs projection', () => {
  test('list_accounts projection preserves account-level webhook subscribers and strips credentials', () => {
    const wire = toWireAccount({
      id: 'acc_acme',
      name: 'Acme',
      status: 'active',
      ctx_metadata: {},
      notification_configs: [
        {
          subscriber_id: 'catalog-sync',
          url: 'https://buyer.example/webhooks/adcp/catalog',
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
        subscriber_id: 'catalog-sync',
        url: 'https://buyer.example/webhooks/adcp/catalog',
        event_types: ['product.updated', 'signal.priced', 'wholesale_feed.bulk_change'],
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
          subscriber_id: 'catalog-sync',
          url: 'https://buyer.example/webhooks/adcp/catalog',
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
        subscriber_id: 'catalog-sync',
        url: 'https://buyer.example/webhooks/adcp/catalog',
        event_types: ['product.created'],
      },
    ]);
  });
});
