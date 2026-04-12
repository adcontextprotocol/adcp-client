// Tests for issue #306: operationSuccess should detect AdCP errors (plural) envelope
//
// The AdCP protocol schemas use { errors: [...] } for error responses.
// TaskExecutor must detect this alongside singular { error: "..." }.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

describe('TaskExecutor detects AdCP errors (plural) envelope', () => {
  let TaskExecutor;
  let ProtocolClient;
  let originalCallTool;
  let mockAgent;

  beforeEach(() => {
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    TaskExecutor = lib.TaskExecutor;
    ProtocolClient = lib.ProtocolClient;
    originalCallTool = ProtocolClient.callTool;
    mockAgent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://test.example',
      protocol: 'mcp',
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  // MCP responses use structuredContent to wrap AdCP data.
  // The response unwrapper extracts structuredContent as the inner data.
  function mcpResponse(data) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }

  test('marks result as failure when response has errors array', async () => {
    ProtocolClient.callTool = async () =>
      mcpResponse({
        errors: [{ code: 'invalid_product', message: 'Product not found' }],
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {});

    assert.strictEqual(result.success, false, 'should detect errors array as failure');
    assert.ok(result.error, 'should have an error message');
    assert.ok(result.error.includes('Product not found'), 'error should contain the message from errors array');
  });

  test('marks result as failure when response has errors array with multiple errors', async () => {
    ProtocolClient.callTool = async () =>
      mcpResponse({
        errors: [
          { code: 'invalid_budget', message: 'Budget too low' },
          { code: 'invalid_dates', message: 'End date before start date' },
        ],
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {});

    assert.strictEqual(result.success, false, 'should detect multiple errors as failure');
    assert.ok(result.error.includes('Budget too low'), 'should include first error message');
    assert.ok(result.error.includes('End date before start date'), 'should include second error message');
  });

  test('still detects singular error field', async () => {
    // Use get_products (no response schema in unwrapper) to test singular error detection
    // without schema validation interfering
    ProtocolClient.callTool = async () =>
      mcpResponse({
        error: 'Something went wrong',
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'get_products', {});

    assert.strictEqual(result.success, false, 'should still detect singular error');
  });

  test('treats empty errors array as success', async () => {
    ProtocolClient.callTool = async () =>
      mcpResponse({
        media_buy_id: 'mb-123',
        errors: [],
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {});

    assert.strictEqual(result.success, true, 'empty errors array should not be treated as failure');
  });

  test('treats response without errors as success', async () => {
    ProtocolClient.callTool = async () =>
      mcpResponse({
        media_buy_id: 'mb-123',
        status: 'active',
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'create_media_buy', {});

    assert.strictEqual(result.success, true, 'normal response should be success');
  });

  test('extracts error code when message is missing', async () => {
    // Use get_products (no response schema in unwrapper) to avoid schema validation
    // requiring `message` field on error objects
    ProtocolClient.callTool = async () =>
      mcpResponse({
        errors: [{ code: 'budget_exceeded' }],
      });

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mockAgent, 'get_products', {});

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('budget_exceeded'), 'should fall back to error code');
  });
});
