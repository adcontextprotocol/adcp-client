const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createComplyController, DISCOVERY_ARM_SCENARIOS } = require('../../dist/lib/testing/index.js');
const { handleTestControllerRequest } = require('../../dist/lib/server/index.js');

describe('async discovery controller extension scenarios', () => {
  test('flat store advertises discovery arm scenarios in list_scenarios', async () => {
    const result = await handleTestControllerRequest(
      {
        async forceGetProductsArm() {},
        async forceGetSignalsArm() {},
      },
      { scenario: 'list_scenarios' }
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.scenarios, [
      DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
    ]);
  });

  test('dispatches force_get_products_arm submitted and input-required directives', async () => {
    const seen = [];
    const store = {
      async forceGetProductsArm(params) {
        seen.push(params);
        return { success: true, forced: { arm: params.arm, task_id: params.task_id } };
      },
    };

    const submitted = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      params: {
        arm: 'submitted',
        task_id: 'task_products_async_1',
        message: 'queued for curation',
      },
    });
    const inputRequired = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      params: { arm: 'input-required', message: 'budget needed' },
    });

    assert.equal(submitted.success, true);
    assert.deepEqual(submitted.forced, { arm: 'submitted', task_id: 'task_products_async_1' });
    assert.equal(inputRequired.success, true);
    assert.deepEqual(seen, [
      { arm: 'submitted', task_id: 'task_products_async_1', message: 'queued for curation' },
      { arm: 'input-required', task_id: undefined, message: 'budget needed' },
    ]);
  });

  test('validates discovery arm directive params', async () => {
    const store = {
      async forceGetProductsArm(params) {
        return { success: true, forced: { arm: params.arm, task_id: params.task_id } };
      },
      async forceGetSignalsArm(params) {
        return { success: true, forced: { arm: params.arm, task_id: params.task_id } };
      },
    };

    const productsMissingTaskId = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      params: { arm: 'submitted' },
    });
    const productsUnexpectedTaskId = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      params: { arm: 'input-required', task_id: 'task_not_allowed' },
    });
    const signalsWrongArm = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
      params: { arm: 'input-required', task_id: 'task_signals_async_1' },
    });
    const signalsMissingTaskId = await handleTestControllerRequest(store, {
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
      params: { arm: 'submitted' },
    });

    assert.equal(productsMissingTaskId.success, false);
    assert.equal(productsMissingTaskId.error, 'INVALID_PARAMS');
    assert.equal(productsUnexpectedTaskId.success, false);
    assert.equal(productsUnexpectedTaskId.error, 'INVALID_PARAMS');
    assert.equal(signalsWrongArm.success, false);
    assert.equal(signalsWrongArm.error, 'INVALID_PARAMS');
    assert.equal(signalsMissingTaskId.success, false);
    assert.equal(signalsMissingTaskId.error, 'INVALID_PARAMS');
  });

  test('createComplyController exposes typed discovery arm adapters', async () => {
    const seen = [];
    const controller = createComplyController({
      force: {
        get_products_arm: (params, ctx) => {
          seen.push({ tool: 'get_products', params, scenario: ctx.input.scenario });
          return { success: true, forced: { arm: params.arm, task_id: params.task_id } };
        },
        get_signals_arm: (params, ctx) => {
          seen.push({ tool: 'get_signals', params, scenario: ctx.input.scenario });
          return { success: true, forced: { arm: params.arm, task_id: params.task_id } };
        },
      },
    });

    const scenarios = await controller.handleRaw({ scenario: 'list_scenarios' });
    const products = await controller.handleRaw({
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      params: { arm: 'submitted', task_id: 'task_products_async_2' },
    });
    const signals = await controller.handleRaw({
      scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
      params: { arm: 'submitted', task_id: 'task_signals_async_2' },
    });

    assert.equal(scenarios.success, true);
    assert.deepEqual(scenarios.scenarios, [
      DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
      DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
    ]);
    assert.equal(products.success, true);
    assert.equal(signals.success, true);
    assert.deepEqual(seen, [
      {
        tool: 'get_products',
        scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_PRODUCTS_ARM,
        params: { arm: 'submitted', task_id: 'task_products_async_2', message: undefined },
      },
      {
        tool: 'get_signals',
        scenario: DISCOVERY_ARM_SCENARIOS.FORCE_GET_SIGNALS_ARM,
        params: { arm: 'submitted', task_id: 'task_signals_async_2', message: undefined },
      },
    ]);
  });
});
