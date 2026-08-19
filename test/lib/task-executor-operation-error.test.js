const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor');
const { ProtocolClient } = require('../../dist/lib/protocols');

describe('TaskExecutor business rejection diagnostics', () => {
  test('surfaces a valid business rejection reason through executeTask', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async () => ({
      status: 'rejected',
      data: { success: false, outcome: 'rejected', reason: 'Inventory is unavailable' },
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    try {
      const result = await executor.executeTask(
        { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
        'get_products',
        {}
      );
      assert.equal(result.success, false);
      assert.equal(result.error, 'Inventory is unavailable');
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
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
