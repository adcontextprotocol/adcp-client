const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { createWebhookReceiver } = require('../../dist/lib/testing/storyboard/webhook-receiver.js');
const { executeWebhookAssertionStep } = require('../../dist/lib/testing/storyboard/webhook-assertions.js');
const { createRunnerVariables } = require('../../dist/lib/testing/storyboard/context.js');

async function fixture(t, task = 'sync_accounts', proxy = false) {
  let receiverOptions;
  if (proxy) {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    receiverOptions = { mode: 'proxy_url', port, public_url: `http://127.0.0.1:${port}/hooks`, allowHttp: true };
  }
  const receiver = await createWebhookReceiver(receiverOptions);
  t.after(() => receiver.close());
  const url = `${receiver.base_url}/step/creative_lifecycle_events/subscription-operation`;
  const config = {
    subscriber_id: 'buyer-primary',
    url,
    active: true,
    event_types: ['creative.status_changed', 'creative.purged'],
  };
  const account = { account: { account_id: 'account-1' }, notification_configs: [config] };
  const payload = task === 'sync_accounts' ? { accounts: [account] } : { notification_configs: [config] };
  const setup = { id: 'register', title: 'Register notifications', task, sample_request: payload };
  const trigger = { id: 'trigger', title: 'Trigger', task: 'comply_test_controller' };
  const runnerVars = createRunnerVariables({ webhookBase: receiver.base_url });
  runnerVars.stepOperationIds.set('trigger', 'mutation-operation');
  const state = {
    contributions: new Set(),
    priorStepResults: new Map([
      ['register', { step_id: 'register', task, passed: true, request: { payload }, response: {} }],
      ['trigger', { step_id: 'trigger', task: 'comply_test_controller', passed: true }],
    ]),
    stepRequestStarts: new Map([['trigger', new Date(Date.now() - 20).toISOString()]]),
    priorProbes: new Map(),
    agentUrl: '',
    webhookReceiver: receiver,
    runnerVars,
  };
  const body = {
    notification_type: 'creative.status_changed',
    subscriber_id: 'buyer-primary',
    account_id: 'account-1',
    creative_id: 'creative-1',
    notification_id: 'notification-1',
    idempotency_key: 'evt_first_1234567890abcdef',
    fired_at: new Date().toISOString(),
    transition: { from: 'approved', to: 'suspended' },
    reason_code: 'policy_violation',
    initiator: 'seller',
  };
  const step = {
    id: 'observe',
    title: 'Observe',
    task: 'expect_webhook',
    triggered_by: 'trigger',
    filter: {
      notification_type: body.notification_type,
      subscriber_id: body.subscriber_id,
      creative_id: body.creative_id,
    },
    timeout_seconds: 0.02,
    expect_idempotency_key: true,
  };
  const post = (value = body, target = url) =>
    fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const run = (assertion = step) =>
    executeWebhookAssertionStep(
      assertion,
      'events',
      {},
      [
        { step: setup, phaseId: 'setup', globalIndex: 0 },
        { step: trigger, phaseId: 'events', globalIndex: 1 },
        { step: assertion, phaseId: 'events', globalIndex: 2 },
      ],
      {},
      state
    );
  return { receiver, url, config, account, payload, setup, state, body, step, post, run };
}

for (const task of ['sync_accounts', 'sync_agent_notification_configs']) {
  test(`persistent notifications use the actual ${task} subscriber route and retain trigger causality`, async t => {
    const f = await fixture(t, task);
    await f.post();
    const result = await f.run();
    assert.equal(result.passed, true, JSON.stringify(result.validations));
    assert.notEqual(f.url, `${f.receiver.base_url}/step/trigger/mutation-operation`);
  });
  test(`${task} clear does not resurrect an older subscription`, async t => {
    const f = await fixture(t, task);
    const payload =
      task === 'sync_accounts'
        ? { accounts: [{ ...f.account, notification_configs: [] }] }
        : { notification_configs: [] };
    f.state.priorStepResults.set('clear', { step_id: 'clear', task, passed: true, request: { payload }, response: {} });
    await f.post();
    const result = await f.run({ ...f.step, triggered_by: undefined, filter: { body: f.step.filter } });
    assert.equal(result.passed, false);
  });
}

test('flat creative selectors cannot match a different creative on the same subscriber', async t => {
  const f = await fixture(t);
  await f.post({ ...f.body, creative_id: 'wrong-creative' });
  assert.equal((await f.run({ ...f.step, triggered_by: undefined })).passed, false);
});

test('flat and nested selector conflicts are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({ ...f.step, filter: { ...f.step.filter, body: { creative_id: 'different' } } }),
    /Conflicting flat and nested/
  );
});

test('persistent events from before the triggering request cannot satisfy its assertion', async t => {
  const f = await fixture(t);
  await f.post();
  f.state.stepRequestStarts.set('trigger', new Date(Date.now() + 100).toISOString());
  assert.equal((await f.run()).passed, false);
});

test('a consumed delivery cannot satisfy a later lifecycle assertion', async t => {
  const f = await fixture(t);
  const step = { ...f.step, triggered_by: undefined, filter: { body: f.step.filter } };
  await f.post();
  assert.equal((await f.run(step)).passed, true);
  assert.equal((await f.run({ ...step, id: 'later' })).passed, false);
});

test('a retry with the same logical notification identity cannot satisfy a later lifecycle assertion', async t => {
  const f = await fixture(t);
  const step = { ...f.step, triggered_by: undefined, filter: { body: f.step.filter } };
  await f.post();
  assert.equal((await f.run(step)).passed, true);
  await f.post();
  assert.equal((await f.run({ ...step, id: 'later' })).passed, false);
});

test('concurrent positive assertions cannot both consume one delivery', async t => {
  const f = await fixture(t);
  await f.post();
  const step = { ...f.step, triggered_by: undefined, filter: { body: f.step.filter } };
  const results = await Promise.all([f.run(step), f.run({ ...step, id: 'parallel' })]);
  assert.equal(results.filter(result => result.passed).length, 1);
});

test('a fresh logical delivery can satisfy the next lifecycle assertion', async t => {
  const f = await fixture(t);
  const step = { ...f.step, triggered_by: undefined, filter: { body: f.step.filter } };
  await f.post();
  assert.equal((await f.run(step)).passed, true);
  await f.post({
    ...f.body,
    notification_id: 'notification-2',
    idempotency_key: 'evt_second_1234567890abcdef',
    transition: { from: 'suspended', to: 'rejected' },
  });
  assert.equal((await f.run({ ...step, id: 'later' })).passed, true);
});

test('concurrent account-change assertions cannot consume distinct deliveries for the same logical change', async t => {
  const f = await fixture(t);
  f.config.event_types = ['account.change_recorded'];
  const body = { ...f.body, notification_type: 'account.change_recorded', change_id: 'same-change' };
  await f.post(body);
  await f.post({ ...body, notification_id: 'notification-2', idempotency_key: 'evt_second_1234567890abcdef' });
  const filter = { notification_type: body.notification_type, subscriber_id: body.subscriber_id, change_id: '*' };
  const results = await Promise.all([
    f.run({ ...f.step, filter: { ...filter, notification_id: body.notification_id } }),
    f.run({ ...f.step, id: 'parallel', filter: { ...filter, notification_id: 'notification-2' } }),
  ]);
  assert.equal(results.filter(result => result.passed).length, 1);
});

test('dry-run registration is not treated as persisted subscription state', async t => {
  const f = await fixture(t, 'sync_agent_notification_configs');
  f.payload.dry_run = true;
  await f.post();
  assert.equal((await f.run({ ...f.step, triggered_by: undefined, filter: { body: f.step.filter } })).passed, false);
});

for (const action of ['failed', 'error']) {
  test(`an agent-level ${action} action cannot establish subscription state`, async t => {
    const f = await fixture(t, 'sync_agent_notification_configs');
    f.state.priorStepResults.get('register').response = { action };
    await f.post();
    assert.equal((await f.run()).passed, false);
  });
}

test('successful agent registration may carry nonfatal warnings per the pinned response schema', async t => {
  const f = await fixture(t, 'sync_agent_notification_configs');
  f.state.priorStepResults.get('register').response = {
    action: 'updated',
    errors: [{ code: 'WARNING', message: 'Nonfatal' }],
  };
  await f.post();
  assert.equal((await f.run()).passed, true);
});

test('a failed expected-error registration is not treated as persisted subscription state', async t => {
  const f = await fixture(t);
  f.state.priorStepResults.get('register').expect_error = true;
  await f.post();
  assert.equal((await f.run({ ...f.step, triggered_by: undefined, filter: { body: f.step.filter } })).passed, false);
});

test('an account sync operation-level error cannot establish subscription state', async t => {
  const f = await fixture(t);
  f.state.priorStepResults.get('register').response = { errors: [{ code: 'INVALID_REQUEST' }] };
  await f.post();
  assert.equal((await f.run()).passed, false);
});

test('clearing a sibling sub-brand does not shadow another brand_id registration', async t => {
  const f = await fixture(t);
  const account = brand_id => ({
    brand: { domain: 'brands.example', brand_id },
    operator: 'buyer.example',
    sandbox: true,
  });
  f.account.account = account('spark');
  f.state.priorStepResults.set('clear-other', {
    step_id: 'clear-other',
    task: 'sync_accounts',
    passed: true,
    request: { payload: { accounts: [{ account: account('glow'), notification_configs: [] }] } },
    response: {},
  });
  await f.post();
  assert.equal((await f.run()).passed, true);
});

for (const [field, first, second, equivalent] of [
  ['currency', 'USD', 'EUR', false],
  ['timezone', 'America/New_York', 'Europe/Amsterdam', false],
  ['countries', ['US'], ['NL'], false],
  ['countries', ['US', 'NL'], ['NL', 'US'], true],
]) {
  test(`registration identity preserves ${field}: ${JSON.stringify(first)} versus ${JSON.stringify(second)}`, async t => {
    const f = await fixture(t);
    const account = value => ({
      brand: { domain: 'brands.example', ...(field === 'countries' && { countries: value }) },
      operator: 'buyer.example',
      sandbox: true,
      ...(field !== 'countries' && { [field]: value }),
    });
    f.account.account = account(first);
    f.state.priorStepResults.set('clear', {
      step_id: 'clear',
      task: 'sync_accounts',
      passed: true,
      request: { payload: { accounts: [{ account: account(second), notification_configs: [] }] } },
      response: {},
    });
    await f.post();
    assert.equal((await f.run()).passed, !equivalent);
  });
}

test('negative webhook assertions require explicit nested payload selectors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ ...f.step, task: 'expect_no_webhook' }), /use filter.body/);
});

for (const nested of [false, true, 'combined']) {
  test(`account change wildcard is ${nested ? 'literal in nested selectors' : 'presence-only in flat selectors'}`, async t => {
    const f = await fixture(t);
    f.config.event_types = ['account.change_recorded'];
    const selectors = {
      notification_type: 'account.change_recorded',
      subscriber_id: 'buyer-primary',
      account_id: 'account-1',
      change_id: '*',
    };
    await f.post({ ...f.body, notification_type: 'account.change_recorded', change_id: 'actual-change' });
    const result = await f.run({
      ...f.step,
      filter: nested === 'combined' ? { ...selectors, body: selectors } : nested ? { body: selectors } : selectors,
    });
    assert.equal(result.passed, !nested, JSON.stringify(result.validations));
  });
}

test('persistent subscriber routing uses the logical path in proxy receiver mode', async t => {
  const f = await fixture(t, 'sync_accounts', true);
  await f.post();
  assert.equal((await f.run()).passed, true);
});

test('negative persistent assertions detect a prohibited subscriber delivery', async t => {
  const f = await fixture(t);
  await f.post();
  const result = await f.run({ ...f.step, task: 'expect_no_webhook', filter: { body: f.step.filter } });
  assert.equal(result.passed, false);
  assert.ok(result.validations.some(value => value.actual?.code === 'unexpected_webhook_received'));
});

test('negative persistent assertions also detect a delivery to an obsolete subscriber URL', async t => {
  const f = await fixture(t);
  const oldUrl = f.url;
  f.config.url = `${f.receiver.base_url}/step/replaced/new-operation`;
  await f.post(f.body, oldUrl);
  assert.equal((await f.run({ ...f.step, task: 'expect_no_webhook', filter: { body: f.step.filter } })).passed, false);
});

test('negative persistent assertions exclude events older than the triggering request', async t => {
  const f = await fixture(t);
  await f.post();
  f.state.stepRequestStarts.set('trigger', new Date(Date.now() + 100).toISOString());
  assert.equal((await f.run({ ...f.step, task: 'expect_no_webhook', filter: { body: f.step.filter } })).passed, true);
});

for (const delivered of [false, true]) {
  test(`a cleared subscriber ${delivered ? 'still fails a negative assertion if it receives an event' : 'passes a negative assertion when it stays quiet'}`, async t => {
    const f = await fixture(t);
    f.state.priorStepResults.set('clear', {
      step_id: 'clear',
      task: 'sync_accounts',
      passed: true,
      request: { payload: { accounts: [{ ...f.account, notification_configs: [] }] } },
      response: {},
    });
    if (delivered) await f.post();
    assert.equal(
      (await f.run({ ...f.step, task: 'expect_no_webhook', filter: { body: f.step.filter } })).passed,
      !delivered
    );
  });
}

for (const natural of [false, true]) {
  test(`a mixed-success batch preserves a successful ${natural ? 'natural-key' : 'account-id'} subscriber clear`, async t => {
    const f = await fixture(t);
    const account = natural
      ? { brand: { domain: 'brand.example' }, operator: 'buyer.example', sandbox: true }
      : f.account.account;
    f.account.account = account;
    f.state.priorStepResults.set('clear', {
      step_id: 'clear',
      task: 'sync_accounts',
      passed: true,
      request: {
        payload: {
          accounts: [
            { account, notification_configs: [] },
            { account: { account_id: 'other' }, notification_configs: [] },
          ],
        },
      },
      response: {
        accounts: [
          { account, account_id: 'account-1', action: 'updated', notification_configs: [] },
          { account: { account_id: 'other' }, action: 'failed', errors: [{ code: 'INVALID_REQUEST' }] },
        ],
      },
    });
    await f.post();
    assert.equal((await f.run()).passed, false);
  });
}

test('an explicit account-change delivery count retains previously observed evidence', async t => {
  const f = await fixture(t);
  f.config.event_types = ['account.change_recorded'];
  const filter = { notification_type: 'account.change_recorded', subscriber_id: 'buyer-primary', change_id: '*' };
  await f.post({ ...f.body, notification_type: 'account.change_recorded', change_id: 'change-1' });
  assert.equal((await f.run({ ...f.step, filter })).passed, true);
  assert.equal(
    (await f.run({ ...f.step, id: 'count', filter, expect_max_deliveries_per_logical_event: 1 })).passed,
    true
  );
});

for (const clear of [false, true]) {
  test(`seller account identity ${clear ? 'shadows a natural-key registration when cleared' : 'matches an account selector for a natural-key registration'}`, async t => {
    const f = await fixture(t);
    const account = { brand: { domain: 'brand.example' }, operator: 'buyer.example', sandbox: true };
    f.account.account = account;
    f.state.priorStepResults.get('register').response = {
      accounts: [{ account, account_id: 'account-1', action: 'updated' }],
    };
    if (clear)
      f.state.priorStepResults.set('clear', {
        step_id: 'clear',
        task: 'sync_accounts',
        passed: true,
        request: { payload: { accounts: [{ account: { account_id: 'account-1' }, notification_configs: [] }] } },
        response: { accounts: [{ account: { account_id: 'account-1' }, account_id: 'account-1', action: 'updated' }] },
      });
    await f.post();
    assert.equal((await f.run({ ...f.step, filter: { ...f.step.filter, account_id: 'account-1' } })).passed, !clear);
  });
}
