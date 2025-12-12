// Unit tests for Logger utility with JSON format support
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the library
const { createLogger } = require('../../dist/lib/index.js');

describe('Logger', () => {
  test('should create a logger with default config', () => {
    const testLogger = createLogger();
    assert.ok(testLogger);
  });

  test('should respect log levels', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const testLogger = createLogger({
      level: 'warn',
      handler: mockHandler,
    });

    testLogger.debug('debug message');
    testLogger.info('info message');
    testLogger.warn('warn message');
    testLogger.error('error message');

    assert.strictEqual(calls.filter((c) => c.method === 'debug').length, 0);
    assert.strictEqual(calls.filter((c) => c.method === 'info').length, 0);
    assert.strictEqual(calls.filter((c) => c.method === 'warn').length, 1);
    assert.strictEqual(calls.filter((c) => c.method === 'error').length, 1);
  });

  test('should log with metadata', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const testLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const meta = { userId: '123', action: 'test' };
    testLogger.info('test message', meta);

    assert.deepStrictEqual(calls[0], { method: 'info', msg: 'test message', meta });
  });

  test('should create child logger with context', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const parentLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const childLogger = parentLogger.child('A2A');
    childLogger.info('calling tool');

    assert.strictEqual(calls[0].msg, '[A2A] calling tool');
  });

  test('should be disabled when enabled=false', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const testLogger = createLogger({
      enabled: false,
      handler: mockHandler,
    });

    testLogger.error('should not log');

    assert.strictEqual(calls.length, 0);
  });

  test('should allow runtime configuration updates', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const testLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    testLogger.debug('should not log');
    assert.strictEqual(calls.filter((c) => c.method === 'debug').length, 0);

    testLogger.configure({ level: 'debug' });
    testLogger.debug('should log now');
    assert.strictEqual(calls.filter((c) => c.method === 'debug').length, 1);
  });

  test('should handle nested child loggers', () => {
    const calls = [];
    const mockHandler = {
      debug: (msg, meta) => calls.push({ method: 'debug', msg, meta }),
      info: (msg, meta) => calls.push({ method: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ method: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ method: 'error', msg, meta }),
    };

    const rootLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const mcpLogger = rootLogger.child('MCP');
    const toolLogger = mcpLogger.child('get_products');

    toolLogger.info('calling agent');

    assert.strictEqual(calls[0].msg, '[MCP] [get_products] calling agent');
  });

  describe('JSON format', () => {
    test('should output JSON format when configured', () => {
      const logged = [];
      const originalLog = console.log;
      console.log = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'info',
          format: 'json',
        });

        testLogger.info('test message');

        assert.strictEqual(logged.length, 1);
        const parsed = JSON.parse(logged[0]);

        assert.strictEqual(parsed.level, 'info');
        assert.strictEqual(parsed.message, 'test message');
        assert.ok(parsed.timestamp);
      } finally {
        console.log = originalLog;
      }
    });

    test('should include metadata in JSON output', () => {
      const logged = [];
      const originalLog = console.log;
      console.log = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'info',
          format: 'json',
        });

        const meta = { userId: '123', action: 'test' };
        testLogger.info('test message', meta);

        const parsed = JSON.parse(logged[0]);

        assert.deepStrictEqual(parsed.meta, meta);
      } finally {
        console.log = originalLog;
      }
    });

    test('should include context in JSON output for child loggers', () => {
      const logged = [];
      const originalLog = console.log;
      console.log = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'info',
          format: 'json',
        });

        const childLogger = testLogger.child('MCP');
        childLogger.info('calling tool');

        const parsed = JSON.parse(logged[0]);

        assert.strictEqual(parsed.context, 'MCP');
        assert.strictEqual(parsed.message, 'calling tool');
      } finally {
        console.log = originalLog;
      }
    });

    test('should handle nested child loggers in JSON format', () => {
      const logged = [];
      const originalLog = console.log;
      console.log = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'info',
          format: 'json',
        });

        const mcpLogger = testLogger.child('MCP');
        const toolLogger = mcpLogger.child('get_products');
        toolLogger.info('calling agent');

        const parsed = JSON.parse(logged[0]);

        assert.strictEqual(parsed.context, 'MCP:get_products');
        assert.strictEqual(parsed.message, 'calling agent');
      } finally {
        console.log = originalLog;
      }
    });

    test('should use console.warn for warn level in JSON format', () => {
      const logged = [];
      const originalWarn = console.warn;
      console.warn = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'warn',
          format: 'json',
        });

        testLogger.warn('warning message');

        assert.strictEqual(logged.length, 1);
        const parsed = JSON.parse(logged[0]);

        assert.strictEqual(parsed.level, 'warn');
        assert.strictEqual(parsed.message, 'warning message');
      } finally {
        console.warn = originalWarn;
      }
    });

    test('should use console.error for error level in JSON format', () => {
      const logged = [];
      const originalError = console.error;
      console.error = (msg) => logged.push(msg);

      try {
        const testLogger = createLogger({
          level: 'error',
          format: 'json',
        });

        testLogger.error('error message');

        assert.strictEqual(logged.length, 1);
        const parsed = JSON.parse(logged[0]);

        assert.strictEqual(parsed.level, 'error');
        assert.strictEqual(parsed.message, 'error message');
      } finally {
        console.error = originalError;
      }
    });
  });
});
