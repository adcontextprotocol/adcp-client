import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger, logger } from './logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
