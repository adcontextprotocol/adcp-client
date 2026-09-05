import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, logger } from './logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a logger with default config', () => {
    const testLogger = createLogger();
    expect(testLogger).toBeDefined();
  });

  it('should respect log levels', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const testLogger = createLogger({
      level: 'warn',
      handler: mockHandler,
    });

    testLogger.debug('debug message');
    testLogger.info('info message');
    testLogger.warn('warn message');
    testLogger.error('error message');

    expect(mockHandler.debug).not.toHaveBeenCalled();
    expect(mockHandler.info).not.toHaveBeenCalled();
    expect(mockHandler.warn).toHaveBeenCalledWith('warn message', undefined);
    expect(mockHandler.error).toHaveBeenCalledWith('error message', undefined);
  });

  it('should log with metadata', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const testLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const meta = { userId: '123', action: 'test' };
    testLogger.info('test message', meta);

    expect(mockHandler.info).toHaveBeenCalledWith('test message', meta);
  });

  it('allows custom handlers with equivalent protection to opt out of redaction', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const testLogger = createLogger({ handler: mockHandler, redactCredentials: false });
    const failure = new Error('token=custom-handler-owned');
    const meta = { at: new Date('2026-09-05T12:00:00.000Z'), failure };

    testLogger.error('token=custom-handler-owned', meta);

    expect(mockHandler.error).toHaveBeenCalledWith('token=custom-handler-owned', meta);
    expect(mockHandler.error.mock.calls[0]![1]).toBe(meta);
    expect(meta.failure).toBe(failure);
  });

  it('rejects credential-redaction opt-out for the default console handler', () => {
    expect(() => createLogger({ redactCredentials: false })).toThrow(/custom log handler/);

    const testLogger = createLogger();
    expect(() => testLogger.configure({ redactCredentials: false })).toThrow(/custom log handler/);
  });

  it('redacts credential-shaped metadata before writing to the default console', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error('request failed', {
      oauth_client_credentials: {
        client_id: 'public-client',
        client_secret: 'do-not-log',
      },
      access_token: 'also-do-not-log',
    });

    expect(consoleError).toHaveBeenCalledWith('request failed', {
      oauth_client_credentials: {
        client_id: 'public-client',
        client_secret: '[redacted]',
      },
      access_token: '[redacted]',
    });
  });

  it('redacts credential material embedded in messages', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error('request failed with token=secret-token-value');

    expect(consoleError).toHaveBeenCalledWith('request failed with token=<redacted>', '');
  });

  it('redacts alternate authorization and serialized credential shapes without changing benign escaping', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error('failure Authorization: Basic dXNlcjpwYXNz; realm=upstream');
    testLogger.error(String.raw`payload={\"access_token\":\"secret.value\"}`);
    testLogger.error('failure x-adcp-auth=raw.secret');
    testLogger.error(String.raw`benign=\"quoted value\"`);

    expect(consoleError).toHaveBeenNthCalledWith(1, 'failure Authorization=<redacted>', '');
    expect(consoleError).toHaveBeenNthCalledWith(2, String.raw`payload={\"access_token\":\"<redacted>\"}`, '');
    expect(consoleError).toHaveBeenNthCalledWith(3, 'failure x-adcp-auth=<redacted>', '');
    expect(consoleError).toHaveBeenNthCalledWith(4, String.raw`benign=\"quoted value\"`, '');
  });

  it('fully redacts escaped quotes inside serialized credential values', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error(String.raw`payload={"token":"abc\"secret"} tail`);
    testLogger.error(String.raw`payload={\"token\":\"abc\\\"secret\"} tail`);
    testLogger.error('payload={"token":"unterminated');

    expect(consoleError).toHaveBeenNthCalledWith(1, 'payload={"token":"<redacted>"} tail', '');
    expect(consoleError).toHaveBeenNthCalledWith(2, String.raw`payload={\"token\":\"<redacted>\"} tail`, '');
    expect(consoleError).toHaveBeenNthCalledWith(3, 'payload={"token":"<redacted>', '');
  });

  it('preserves useful Error metadata while redacting embedded credentials', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();
    const failure = new Error('connection failed with token=do-not-log');

    testLogger.error('request failed', { error: failure });

    expect(consoleError).toHaveBeenCalledWith('request failed', {
      error: expect.objectContaining({
        name: 'Error',
        message: 'connection failed with token=<redacted>',
        stack: expect.not.stringContaining('do-not-log'),
      }),
    });
    const normalized = consoleError.mock.calls[0]![1] as { error: Record<string, unknown> };
    expect(Object.keys(normalized.error)).toEqual(expect.arrayContaining(['name', 'message', 'stack']));
  });

  it('preserves built-in Error subclass names without invoking accessors', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const testLogger = createLogger({ handler: mockHandler });

    testLogger.error('request failed', new TypeError('bad argument'));

    expect(mockHandler.error).toHaveBeenCalledWith(
      'request failed',
      expect.objectContaining({ name: 'TypeError', message: 'bad argument' })
    );
  });

  it('redacts unlabeled token-shaped values at debug level', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger({ level: 'debug' });
    const digest = 'a'.repeat(64);

    testLogger.debug(`upstream rejected ${digest}`);

    expect(consoleLog).toHaveBeenCalledWith('upstream rejected <redacted-token>', '');
  });

  it('redacts unlabeled token-shaped values above debug level', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error(`upstream rejected ${'a'.repeat(64)}`);

    expect(consoleError).toHaveBeenCalledWith('upstream rejected <redacted-token>', '');
  });

  it('redacts padded Base64 tokens at explicit token-character boundaries', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error(`upstream rejected ${'a'.repeat(39)}=`);

    expect(consoleError).toHaveBeenCalledWith('upstream rejected <redacted-token>', '');
  });

  it('preserves common structured metadata values', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();
    const at = new Date('2026-09-05T12:00:00.000Z');

    testLogger.info('structured metadata', {
      at,
      ids: new Set(['one', 'two']),
      values: new Map<string, unknown>([
        ['count', 2],
        ['access_token', 'do-not-log'],
      ]),
      pattern: /token=.*/i,
    });

    expect(consoleLog).toHaveBeenCalledWith('structured metadata', {
      at,
      ids: new Set(['one', 'two']),
      values: new Map<string, unknown>([
        ['count', 2],
        ['access_token', '[redacted]'],
      ]),
      pattern: /token=<redacted>/i,
    });
  });

  it('preserves Map entries when normalized keys collide', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();
    const values = new Map([
      ['a'.repeat(64), 'first'],
      ['b'.repeat(64), 'second'],
    ]);

    testLogger.info('structured metadata', values);

    expect(consoleLog).toHaveBeenCalledWith(
      'structured metadata',
      new Map([
        ['<redacted-token>', 'first'],
        ['<redacted-token>#2', 'second'],
      ])
    );
  });

  it('redacts credential-shaped metadata keys and ignores accessors', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();
    const secretKey = 'a'.repeat(64);
    const meta = Object.defineProperty({ [secretKey]: 'value' }, 'dangerous', {
      enumerable: true,
      get: () => {
        throw new Error('getter must not run');
      },
    });

    expect(() => testLogger.info('metadata', meta)).not.toThrow();
    expect(consoleLog).toHaveBeenCalledWith('metadata', {
      '<redacted-token>': 'value',
      dangerous: '[Accessor]',
    });
  });

  it('uses inert records for arbitrary objects without invoking inherited inspection hooks', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let inspected = false;
    const prototype = {
      toJSON() {
        inspected = true;
        return { access_token: 'do-not-log' };
      },
    };
    const meta = Object.assign(Object.create(prototype), { safe: 'value' });
    const testLogger = createLogger({ handler: mockHandler });

    testLogger.info('metadata', meta);

    const normalized = mockHandler.info.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(normalized.safe).toBe('value');
    expect(inspected).toBe(false);
  });

  it('preserves metadata entries when redacted property names collide', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();
    const meta = {
      ['a'.repeat(64)]: 'first',
      ['b'.repeat(64)]: 'second',
    };

    testLogger.info('metadata', meta);

    expect(consoleLog).toHaveBeenCalledWith(
      'metadata',
      expect.objectContaining({
        '<redacted-token>': 'first',
        '<redacted-token>#2': 'second',
      })
    );
  });

  it('redacts enumerable properties on function-valued console metadata', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();
    const callback = Object.assign(() => undefined, { access_token: 'do-not-log' });

    testLogger.info('metadata', callback);

    expect(consoleLog).toHaveBeenCalledWith('metadata', {
      type: 'Function',
      access_token: '[redacted]',
    });
  });

  it('bounds large metadata collections', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.info(
      'large metadata',
      Array.from({ length: 2_000 }, (_, index) => index)
    );

    const normalized = consoleLog.mock.calls[0]![1] as unknown[];
    expect(normalized).toHaveLength(1_001);
    expect(normalized.at(-1)).toBe('[Entry limit exceeded]');
  });

  it('fails closed for oversized diagnostic strings', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testLogger = createLogger();

    testLogger.error(`prefix ${'x'.repeat(20_000)} token=secret`);

    expect(consoleError).toHaveBeenCalledWith('[Oversized string redacted]', '');
  });

  it('should create child logger with context', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const parentLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const childLogger = parentLogger.child('A2A');
    childLogger.info('calling tool');

    expect(mockHandler.info).toHaveBeenCalledWith('[A2A] calling tool', undefined);
  });

  it('should be disabled when enabled=false', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const testLogger = createLogger({
      enabled: false,
      handler: mockHandler,
    });

    testLogger.error('should not log');

    expect(mockHandler.error).not.toHaveBeenCalled();
  });

  it('should allow runtime configuration updates', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const testLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    testLogger.debug('should not log');
    expect(mockHandler.debug).not.toHaveBeenCalled();

    testLogger.configure({ level: 'debug' });
    testLogger.debug('should log now');
    expect(mockHandler.debug).toHaveBeenCalledWith('should log now', undefined);
  });

  it('should handle nested child loggers', () => {
    const mockHandler = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const rootLogger = createLogger({
      level: 'info',
      handler: mockHandler,
    });

    const mcpLogger = rootLogger.child('MCP');
    const toolLogger = mcpLogger.child('get_products');

    toolLogger.info('calling agent');

    expect(mockHandler.info).toHaveBeenCalledWith('[MCP] [get_products] calling agent', undefined);
  });
});
