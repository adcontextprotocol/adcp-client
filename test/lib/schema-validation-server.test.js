// Server-middleware integration tests for schema-driven validation (issue #688).
// Exercises createAdcpServer's opt-in request/response validator against real handlers.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createAdcpServer, InMemoryStateStore } = require('../../dist/lib/index.js');

async function callTool(server, toolName, params) {
  const raw = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: toolName, arguments: params ?? {} },
  });
  return raw;
}

const VALID_GET_PRODUCTS = {
  brief: 'test campaign',
  promoted_offering: 'shoes',
  buying_mode: 'brief',
};

describe('createAdcpServer validation middleware', () => {
  describe('requests: "strict"', () => {
    test('rejects malformed requests with VALIDATION_ERROR before dispatch', async () => {
      let handlerCalled = false;
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        validation: { requests: 'strict' },
        mediaBuy: {
          getProducts: async () => {
            handlerCalled = true;
            return { products: [] };
          },
        },
      });

      const res = await callTool(server, 'get_products', {}); // missing required fields
      assert.strictEqual(handlerCalled, false, 'handler must not run when request fails schema');
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      assert.ok(res.structuredContent.adcp_error.field, 'expected field pointer on error');
      assert.strictEqual(res.structuredContent.adcp_error.details.side, 'request');
    });

    test('accepts valid requests unchanged', async () => {
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        validation: { requests: 'strict' },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });

      const res = await callTool(server, 'get_products', VALID_GET_PRODUCTS);
      assert.notStrictEqual(res.isError, true);
      assert.ok(Array.isArray(res.structuredContent.products));
    });
  });

  describe('requests: "warn"', () => {
    test('logs warning but still dispatches', async () => {
      const warnings = [];
      const logger = {
        info: () => {},
        warn: (msg, meta) => warnings.push({ msg, meta }),
        error: () => {},
        debug: () => {},
      };
      let handlerCalled = false;
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        logger,
        validation: { requests: 'warn' },
        mediaBuy: {
          getProducts: async () => {
            handlerCalled = true;
            return { products: [] };
          },
        },
      });

      await callTool(server, 'get_products', {});
      assert.strictEqual(handlerCalled, true, 'warn mode must not block dispatch');
      const validationWarnings = warnings.filter(w => w.msg.includes('Schema validation warning (request)'));
      assert.ok(validationWarnings.length > 0, 'expected at least one validation warning in logger');
    });
  });

  describe('requests: "off" (default)', () => {
    test('does not validate when no validation config provided', async () => {
      let handlerCalled = false;
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        mediaBuy: {
          getProducts: async () => {
            handlerCalled = true;
            return { products: [] };
          },
        },
      });

      await callTool(server, 'get_products', {});
      assert.strictEqual(handlerCalled, true, 'off mode must not block dispatch');
    });
  });

  describe('responses', () => {
    test('strict: drift in handler response surfaces VALIDATION_ERROR', async () => {
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        validation: { responses: 'strict' },
        mediaBuy: {
          // Drift: products should be an array, not a string.
          getProducts: async () => ({ products: 'oops' }),
        },
      });

      const res = await callTool(server, 'get_products', VALID_GET_PRODUCTS);
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      assert.strictEqual(res.structuredContent.adcp_error.details.side, 'response');
    });

    test('warn: drift in response logs but returns response unchanged', async () => {
      const warnings = [];
      const logger = {
        info: () => {},
        warn: (msg, meta) => warnings.push({ msg, meta }),
        error: () => {},
        debug: () => {},
      };
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        logger,
        validation: { responses: 'warn' },
        mediaBuy: {
          getProducts: async () => ({ products: 'oops' }),
        },
      });

      const res = await callTool(server, 'get_products', VALID_GET_PRODUCTS);
      assert.notStrictEqual(res.isError, true, 'warn mode should not turn the response into an error');
      assert.strictEqual(res.structuredContent.products, 'oops', 'original response passes through');
      const validationWarnings = warnings.filter(w => w.msg.includes('Schema validation warning (response)'));
      assert.ok(validationWarnings.length > 0);
    });

    test('valid handler responses pass strict mode', async () => {
      const server = createAdcpServer({
        name: 'test',
        version: '0.0.1',
        stateStore: new InMemoryStateStore(),
        validation: { responses: 'strict' },
        mediaBuy: {
          getProducts: async () => ({ products: [] }),
        },
      });

      const res = await callTool(server, 'get_products', VALID_GET_PRODUCTS);
      assert.notStrictEqual(res.isError, true);
    });
  });
});
