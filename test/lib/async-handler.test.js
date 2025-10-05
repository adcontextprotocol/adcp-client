const { test } = require('node:test');
const assert = require('node:assert');
const { AsyncHandler } = require('../../dist/lib/core/AsyncHandler');

/**
 * Tests for AsyncHandler status change callbacks
 *
 * These tests verify that the refactored onXXXStatusChange handlers
 * are called correctly for all status types (completed, failed, needs_input, working, etc)
 */

test('onGetProductsStatusChange called with completed status', async () => {
  let handlerCalled = false;
  let receivedStatus = null;
  let receivedResponse = null;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: (response, metadata) => {
      handlerCalled = true;
      receivedStatus = metadata.status;
      receivedResponse = response;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_123',
    task_type: 'get_products',
    status: 'completed',
    result: { products: [{ id: 'prod_1', name: 'Product 1' }] }
  }, 'agent_1');

  assert.strictEqual(handlerCalled, true, 'Handler should be called');
  assert.strictEqual(receivedStatus, 'completed', 'Should receive completed status');
  assert.strictEqual(receivedResponse.products.length, 1, 'Should receive products');
});

test('onGetProductsStatusChange called with failed status', async () => {
  let handlerCalled = false;
  let receivedStatus = null;
  let receivedError = null;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: (response, metadata) => {
      handlerCalled = true;
      receivedStatus = metadata.status;
      receivedError = metadata.error;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_123',
    task_type: 'get_products',
    status: 'failed',
    error: 'Agent timeout',
    result: null
  }, 'agent_1');

  assert.strictEqual(handlerCalled, true, 'Handler should be called');
  assert.strictEqual(receivedStatus, 'failed', 'Should receive failed status');
  assert.strictEqual(receivedError, 'Agent timeout', 'Should receive error message');
});

test('onGetProductsStatusChange called with needs_input status', async () => {
  let handlerCalled = false;
  let receivedStatus = null;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: (response, metadata) => {
      handlerCalled = true;
      receivedStatus = metadata.status;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_123',
    task_type: 'get_products',
    status: 'needs_input',
    result: { message: 'Please specify product category' }
  }, 'agent_1');

  assert.strictEqual(handlerCalled, true, 'Handler should be called');
  assert.strictEqual(receivedStatus, 'needs_input', 'Should receive needs_input status');
});

test('onGetProductsStatusChange called with working status', async () => {
  let handlerCalled = false;
  let receivedStatus = null;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: (response, metadata) => {
      handlerCalled = true;
      receivedStatus = metadata.status;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_123',
    task_type: 'get_products',
    status: 'working',
    result: { message: 'Fetching products...' }
  }, 'agent_1');

  assert.strictEqual(handlerCalled, true, 'Handler should be called');
  assert.strictEqual(receivedStatus, 'working', 'Should receive working status');
});

test('onCreateMediaBuyStatusChange called with completed status', async () => {
  let handlerCalled = false;
  let receivedMediaBuyId = null;

  const handler = new AsyncHandler({
    onCreateMediaBuyStatusChange: (response, metadata) => {
      handlerCalled = true;
      receivedMediaBuyId = response.media_buy_id;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_456',
    task_type: 'create_media_buy',
    status: 'completed',
    result: { media_buy_id: 'mb_789', status: 'active' }
  }, 'agent_2');

  assert.strictEqual(handlerCalled, true, 'Handler should be called');
  assert.strictEqual(receivedMediaBuyId, 'mb_789', 'Should receive media buy ID');
});

test('onTaskStatusChange fallback handler called for unmapped task type', async () => {
  let fallbackCalled = false;
  let receivedTaskType = null;

  const handler = new AsyncHandler({
    onTaskStatusChange: (response, metadata) => {
      fallbackCalled = true;
      receivedTaskType = metadata.task_type;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_999',
    task_type: 'unknown_task',
    status: 'completed',
    result: { data: 'test' }
  }, 'agent_3');

  assert.strictEqual(fallbackCalled, true, 'Fallback handler should be called');
  assert.strictEqual(receivedTaskType, 'unknown_task', 'Should receive task type');
});

test('onMediaBuyDeliveryNotification called for delivery notifications', async () => {
  let notificationCalled = false;
  let receivedNotificationType = null;
  let receivedSequence = null;

  const handler = new AsyncHandler({
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      notificationCalled = true;
      receivedNotificationType = metadata.notification_type;
      receivedSequence = metadata.sequence_number;
    }
  });

  await handler.handleWebhook({
    operation_id: 'delivery_report_agent1_2025-10',
    task_type: 'media_buy_delivery',
    status: 'completed',
    result: {
      notification_type: 'scheduled',
      sequence_number: 3,
      media_buy_deliveries: [
        { media_buy_id: 'mb_1', impressions: 1000, clicks: 50 }
      ]
    }
  }, 'agent_1');

  assert.strictEqual(notificationCalled, true, 'Notification handler should be called');
  assert.strictEqual(receivedNotificationType, 'scheduled', 'Should receive notification type');
  assert.strictEqual(receivedSequence, 3, 'Should receive sequence number');
});

test('onMediaBuyDeliveryNotification called for final notification', async () => {
  let notificationCalled = false;
  let receivedNotificationType = null;

  const handler = new AsyncHandler({
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      notificationCalled = true;
      receivedNotificationType = metadata.notification_type;
    }
  });

  await handler.handleWebhook({
    operation_id: 'delivery_report_agent1_2025-10',
    task_type: 'media_buy_delivery',
    status: 'completed',
    result: {
      notification_type: 'final',
      sequence_number: 10,
      media_buy_deliveries: [
        { media_buy_id: 'mb_1', impressions: 10000, clicks: 500 }
      ]
    }
  }, 'agent_1');

  assert.strictEqual(notificationCalled, true, 'Notification handler should be called');
  assert.strictEqual(receivedNotificationType, 'final', 'Should receive final notification type');
});

test('onActivity called for webhook received event', async () => {
  let activityCalled = false;
  let receivedActivityType = null;
  let receivedOperationId = null;

  const handler = new AsyncHandler({
    onActivity: (activity) => {
      activityCalled = true;
      receivedActivityType = activity.type;
      receivedOperationId = activity.operation_id;
    },
    onGetProductsStatusChange: () => {} // Need this to avoid error
  });

  await handler.handleWebhook({
    operation_id: 'op_activity_test',
    task_type: 'get_products',
    status: 'completed',
    result: { products: [] }
  }, 'agent_1');

  assert.strictEqual(activityCalled, true, 'Activity callback should be called');
  assert.strictEqual(receivedActivityType, 'webhook_received', 'Should receive webhook_received event');
  assert.strictEqual(receivedOperationId, 'op_activity_test', 'Should receive operation ID');
});

test('metadata includes all webhook fields', async () => {
  let receivedMetadata = null;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: (response, metadata) => {
      receivedMetadata = metadata;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_meta_test',
    context_id: 'ctx_123',
    task_id: 'task_456',
    task_type: 'get_products',
    status: 'completed',
    result: { products: [] },
    timestamp: '2025-10-05T12:00:00Z'
  }, 'agent_meta');

  assert.strictEqual(receivedMetadata.operation_id, 'op_meta_test', 'Should have operation_id');
  assert.strictEqual(receivedMetadata.context_id, 'ctx_123', 'Should have context_id');
  assert.strictEqual(receivedMetadata.task_id, 'task_456', 'Should have task_id');
  assert.strictEqual(receivedMetadata.agent_id, 'agent_meta', 'Should have agent_id');
  assert.strictEqual(receivedMetadata.task_type, 'get_products', 'Should have task_type');
  assert.strictEqual(receivedMetadata.status, 'completed', 'Should have status');
  assert.strictEqual(receivedMetadata.timestamp, '2025-10-05T12:00:00Z', 'Should have timestamp');
});

test('handler can be async', async () => {
  let asyncCompleted = false;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: async (response, metadata) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      asyncCompleted = true;
    }
  });

  await handler.handleWebhook({
    operation_id: 'op_async',
    task_type: 'get_products',
    status: 'completed',
    result: { products: [] }
  }, 'agent_1');

  assert.strictEqual(asyncCompleted, true, 'Async handler should complete');
});

test('multiple handlers can be configured', async () => {
  let getProductsCalled = false;
  let createMediaBuyCalled = false;
  let activityCalled = false;

  const handler = new AsyncHandler({
    onGetProductsStatusChange: () => { getProductsCalled = true; },
    onCreateMediaBuyStatusChange: () => { createMediaBuyCalled = true; },
    onActivity: () => { activityCalled = true; }
  });

  await handler.handleWebhook({
    operation_id: 'op_1',
    task_type: 'get_products',
    status: 'completed',
    result: { products: [] }
  }, 'agent_1');

  await handler.handleWebhook({
    operation_id: 'op_2',
    task_type: 'create_media_buy',
    status: 'completed',
    result: { media_buy_id: 'mb_1' }
  }, 'agent_1');

  assert.strictEqual(getProductsCalled, true, 'GetProducts handler should be called');
  assert.strictEqual(createMediaBuyCalled, true, 'CreateMediaBuy handler should be called');
  assert.strictEqual(activityCalled, true, 'Activity handler should be called for both');
});
