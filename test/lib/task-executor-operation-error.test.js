const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor');

describe('TaskExecutor business rejection diagnostics', () => {
  test('surfaces a valid business rejection reason instead of the generic fallback', () => {
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    assert.equal(
      executor.extractOperationError({ success: false, outcome: 'rejected', reason: 'Inventory is unavailable' }),
      'Inventory is unavailable'
    );
  });

  test('surfaces plural structured errors even without a terminal status field', () => {
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    assert.equal(
      executor.extractOperationError({
        success: false,
        errors: [
          { code: 'POLICY_VIOLATION', message: 'Placement policy rejected the request' },
          { code: 'PRODUCT_UNAVAILABLE' },
        ],
      }),
      'Placement policy rejected the request; PRODUCT_UNAVAILABLE'
    );
  });
});
