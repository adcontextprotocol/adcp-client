const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  registerWholesaleFeedWebhooks,
  WholesaleFeedWebhookRegistrationError,
} = require('../../dist/lib/wholesale-feed-sync/index.js');

const account = { account_id: 'acc_acme' };

function makeClient(result = { status: 'success', data: { accounts: [] } }) {
  const calls = [];
  return {
    calls,
    client: {
      async syncAccounts(params) {
        calls.push(params);
        return result;
      },
    },
  };
}

describe('registerWholesaleFeedWebhooks', () => {
  test('preserves sibling subscribers and non-wholesale events while replacing the wholesale selection', async () => {
    const currentConfigs = [
      {
        subscriber_id: 'audit',
        url: 'https://audit.example/hooks',
        event_types: ['creative.purged'],
        active: false,
      },
      {
        subscriber_id: 'buyer-primary',
        url: 'https://buyer.example/hooks',
        event_types: ['creative.status_changed', 'signal.updated'],
        authentication: { schemes: ['HMAC-SHA256'] },
      },
    ];
    const original = structuredClone(currentConfigs);
    const { client, calls } = makeClient();

    await registerWholesaleFeedWebhooks(client, {
      account,
      currentConfigs,
      subscriber: {
        subscriber_id: 'buyer-primary',
        url: 'https://buyer.example/hooks',
        event_types: ['product.updated', 'wholesale_feed.bulk_change'],
        active: true,
      },
      revision: 7,
      idempotencyKey: 'wholesale-feed-registration-0001',
    });

    assert.deepStrictEqual(currentConfigs, original);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], {
      accounts: [
        {
          account,
          revision: 7,
          notification_configs: [
            currentConfigs[0],
            {
              subscriber_id: 'buyer-primary',
              url: 'https://buyer.example/hooks',
              event_types: ['creative.status_changed', 'product.updated', 'wholesale_feed.bulk_change'],
              authentication: { schemes: ['HMAC-SHA256'] },
              active: true,
              product_payload_view: 'legacy',
            },
          ],
        },
      ],
      idempotency_key: 'wholesale-feed-registration-0001',
    });
  });

  test('removes stale product payload view when replacing product events with signal events', async () => {
    const { client, calls } = makeClient();

    await registerWholesaleFeedWebhooks(client, {
      account,
      currentConfigs: [
        {
          subscriber_id: 'buyer-primary',
          url: 'https://buyer.example/hooks',
          event_types: ['creative.status_changed', 'product.updated'],
          product_payload_view: 'canonical',
        },
      ],
      subscriber: {
        subscriber_id: 'buyer-primary',
        url: 'https://buyer.example/hooks',
        event_types: ['signal.updated'],
      },
    });

    assert.deepStrictEqual(calls[0].accounts[0].notification_configs[0], {
      subscriber_id: 'buyer-primary',
      url: 'https://buyer.example/hooks',
      event_types: ['creative.status_changed', 'signal.updated'],
    });
  });

  test('adds a new subscriber without changing existing entries', async () => {
    const existing = {
      subscriber_id: 'audit',
      url: 'https://audit.example/hooks',
      event_types: ['creative.purged'],
    };
    const { client, calls } = makeClient();

    await registerWholesaleFeedWebhooks(client, {
      account,
      currentConfigs: [existing],
      subscriber: {
        subscriber_id: 'wholesale-feed',
        url: 'https://buyer.example/wholesale-feed',
        event_types: ['signal.created', 'signal.updated'],
      },
    });

    assert.deepStrictEqual(calls[0].accounts[0].notification_configs, [
      existing,
      {
        subscriber_id: 'wholesale-feed',
        url: 'https://buyer.example/wholesale-feed',
        event_types: ['signal.created', 'signal.updated'],
      },
    ]);
  });

  test('requires fresh legacy credentials when changing an authenticated subscriber URL', async () => {
    const currentConfigs = [
      {
        subscriber_id: 'buyer-primary',
        url: 'https://buyer.example/old',
        event_types: ['product.updated'],
        product_payload_view: 'legacy',
        authentication: { schemes: ['Bearer'] },
      },
    ];
    const { client, calls } = makeClient();
    const subscriber = {
      subscriber_id: 'buyer-primary',
      url: 'https://buyer.example/new',
      event_types: ['product.updated'],
    };

    assert.throws(
      () => registerWholesaleFeedWebhooks(client, { account, currentConfigs, subscriber }),
      error => error instanceof WholesaleFeedWebhookRegistrationError && error.field === 'subscriber.authentication'
    );
    assert.strictEqual(calls.length, 0);

    await registerWholesaleFeedWebhooks(client, {
      account,
      currentConfigs,
      subscriber: {
        ...subscriber,
        authentication: { schemes: ['Bearer'], credentials: 'new-token-at-least-thirty-two-characters' },
      },
    });
    assert.strictEqual(calls.length, 1);
  });

  test('rejects malformed current state and invalid wholesale event selections before calling the client', () => {
    const { client, calls } = makeClient();
    const subscriber = {
      subscriber_id: 'wholesale-feed',
      url: 'https://buyer.example/hooks',
      event_types: ['product.updated'],
    };
    const duplicate = {
      subscriber_id: 'duplicate',
      url: 'https://buyer.example/one',
      event_types: ['signal.updated'],
    };

    assert.throws(
      () =>
        registerWholesaleFeedWebhooks(client, {
          account,
          currentConfigs: [duplicate, { ...duplicate, url: 'https://buyer.example/two' }],
          subscriber,
        }),
      error => error.field === 'currentConfigs[1]'
    );
    assert.throws(
      () =>
        registerWholesaleFeedWebhooks(client, {
          account,
          currentConfigs: [],
          subscriber: { ...subscriber, event_types: ['creative.purged'] },
        }),
      error => error.field === 'subscriber.event_types'
    );
    assert.throws(
      () =>
        registerWholesaleFeedWebhooks(client, {
          account,
          currentConfigs: [],
          subscriber: { ...subscriber, event_types: ['product.updated', 'product.updated'] },
        }),
      error => error.field === 'subscriber.event_types'
    );
    assert.strictEqual(calls.length, 0);
  });
});
