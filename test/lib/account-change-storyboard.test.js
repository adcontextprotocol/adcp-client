const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { executeWebhookAssertionStep } = require('../../dist/lib/testing/storyboard/webhook-assertions.js');
const { createRunnerVariables } = require('../../dist/lib/testing/storyboard/context.js');

test('published account-feed selectors observe distinct logical fires on a persistent subscriber URL', async () => {
  const receiver = await createWebhookReceiver();
  const state = {
    contributions: new Set(),
    stepRequestStarts: new Map(),
    priorStepResults: new Map([
      [
        'register',
        {
          task: 'sync_accounts',
          passed: true,
          request: {
            payload: {
              accounts: [
                {
                  account: { account_id: 'another-account' },
                  notification_configs: [
                    {
                      subscriber_id: 'buyer-primary',
                      event_types: ['account.change_recorded'],
                      url: `${receiver.base_url}/step/other/account`,
                    },
                  ],
                },
                {
                  account: { account_id: 'acc_luma_shared' },
                  notification_configs: [
                    {
                      subscriber_id: 'buyer-primary',
                      event_types: ['account.change_recorded'],
                      url: `${receiver.base_url}/step/subscription/registration`,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      ['seed', { passed: true }],
      ['update', { passed: true }],
    ]),
    priorProbes: new Map(),
    agentUrl: '',
    webhookReceiver: receiver,
    runnerVars: createRunnerVariables({ webhookBase: receiver.base_url }),
  };
  const step = {
    id: 'observe',
    title: 'Observe account invalidation',
    task: 'expect_webhook',
    triggered_by: 'seed',
    filter: {
      notification_type: 'account.change_recorded',
      subscriber_id: 'buyer-primary',
      change_id: '*',
      body: { account_id: 'acc_luma_shared' },
    },
    webhook_payload_schema_ref: 'core/account-change-recorded-webhook.json',
    timeout_seconds: 1,
  };
  const emit = async (changeId, overrides = {}, route = 'subscription/registration') => {
    const response = await fetch(`${receiver.base_url}/step/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notification_type: 'account.change_recorded',
        notification_id: changeId,
        change_id: changeId,
        idempotency_key: `delivery-${changeId}-0123456789`,
        account_id: 'acc_luma_shared',
        subscriber_id: 'buyer-primary',
        fired_at: '2026-08-24T11:58:05Z',
        recorded_at: '2026-08-24T11:58:04Z',
        resource: { type: 'creative', resource_id: 'creative-1' },
        action: 'updated',
        ...overrides,
      }),
    });
    assert.equal(response.status, 204);
  };
  try {
    await emit('stale-unasserted');
    await new Promise(resolve => setTimeout(resolve, 5));
    state.stepRequestStarts.set('seed', new Date().toISOString());
    state.stepRequestStarts.set('update', state.stepRequestStarts.get('seed'));
    await emit('wrong-endpoint', {}, 'unregistered/path');
    await emit('wrong-subscriber', { subscriber_id: 'someone-else' });
    await emit('first');
    assert.equal((await executeWebhookAssertionStep(step, 'p', {}, [], {}, state)).passed, true);
    await emit('first', { idempotency_key: 'reemission-first-0123456789' });
    const duplicate = await executeWebhookAssertionStep(
      { ...step, id: 'observe_duplicate', triggered_by: 'update', timeout_seconds: 0.05 },
      'p',
      {},
      [],
      {},
      state
    );
    assert.equal(duplicate.passed, false, 'a retry or re-emission cannot satisfy a second logical-change assertion');
    await emit('second');
    assert.equal(
      (
        await executeWebhookAssertionStep(
          { ...step, id: 'observe_second', triggered_by: 'update' },
          'p',
          {},
          [],
          {},
          state
        )
      ).passed,
      true
    );
    await assert.rejects(
      executeWebhookAssertionStep(
        { ...step, filter: { ...step.filter, body: { subscriber_id: 'someone-else' } } },
        'p',
        {},
        [],
        {},
        state
      ),
      /Conflicting flat and nested webhook selectors/
    );
    state.priorStepResults.set('update', { passed: false });
    assert.equal(
      (await executeWebhookAssertionStep({ ...step, triggered_by: 'update' }, 'p', {}, [], {}, state)).skipped,
      true
    );
  } finally {
    await receiver.close();
  }
});
