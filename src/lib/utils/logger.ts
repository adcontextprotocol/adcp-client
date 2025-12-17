/**
 * Logger utility for AdCP Client
 *
 * Provides structured logging with levels and contextual metadata.
 * Supports JSON format for production deployments.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface LoggerConfig {
  /** Minimum log level to output (default: 'info') */
  level?: LogLevel;
  /** Enable/disable logging globally (default: true) */
  enabled?: boolean;
  /** Output format: 'text' for human-readable, 'json' for structured (default: 'text') */
  format?: LogFormat;
  /** Custom log handler (default: console) */
  handler?: {
    debug: (message: string, meta?: any) => void;
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Create a JSON log entry
 */
function createJsonLogEntry(level: LogLevel, message: string, meta?: any, context?: string): string {
  const entry: Record<string, any> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (context) {
    entry.context = context;
  }
  if (meta !== undefined) {
    entry.meta = meta;
  }
  return JSON.stringify(entry);
}

/**
 * Create default handlers based on format
 */
function createDefaultHandler(format: LogFormat, context?: string) {
  if (format === 'json') {
    return {
      debug: (msg: string, meta?: any) => console.log(createJsonLogEntry('debug', msg, meta, context)),
      info: (msg: string, meta?: any) => console.log(createJsonLogEntry('info', msg, meta, context)),
      warn: (msg: string, meta?: any) => console.warn(createJsonLogEntry('warn', msg, meta, context)),
      error: (msg: string, meta?: any) => console.error(createJsonLogEntry('error', msg, meta, context)),
    };
  }
  // Text format (default)
  const prefix = context ? `[${context}] ` : '';
  return {
    debug: (msg: string, meta?: any) => console.log(`${prefix}${msg}`, meta ? meta : ''),
    info: (msg: string, meta?: any) => console.log(`${prefix}${msg}`, meta ? meta : ''),
    warn: (msg: string, meta?: any) => console.warn(`${prefix}${msg}`, meta ? meta : ''),
    error: (msg: string, meta?: any) => console.error(`${prefix}${msg}`, meta ? meta : ''),
  };
}

/**
 * Logger interface for dependency injection
 * Libraries can accept this interface to allow consumers to inject their own logger
 */
export interface ILogger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  child(context: string): ILogger;
}

class Logger implements ILogger {
  private config: Required<LoggerConfig>;
  private context?: string;

  constructor(config: LoggerConfig = {}, context?: string) {
    const format = config.format || 'text';
    this.context = context;
    this.config = {
      level: config.level || 'info',
      enabled: config.enabled !== false,
      format,
      handler: config.handler || createDefaultHandler(format, context),
    };
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  /**
   * Log debug message (development/troubleshooting)
   */
  debug(message: string, meta?: any): void {
    if (this.shouldLog('debug')) {
      this.config.handler.debug(message, meta);
    }
  }

  /**
   * Log info message (general information)
   */
  info(message: string, meta?: any): void {
    if (this.shouldLog('info')) {
      this.config.handler.info(message, meta);
    }
  }

  /**
   * Log warning message (non-critical issues)
   */
  warn(message: string, meta?: any): void {
    if (this.shouldLog('warn')) {
      this.config.handler.warn(message, meta);
    }
  }

  /**
   * Log error message (critical issues)
   */
  error(message: string, meta?: any): void {
    if (this.shouldLog('error')) {
      this.config.handler.error(message, meta);
    }
  }

  /**
   * Create a child logger with contextual prefix
   */
  child(context: string): Logger {
    const fullContext = this.context ? `${this.context}:${context}` : context;

    // For JSON format, create new default handler with combined context
    if (this.config.format === 'json') {
      return new Logger(
        {
          level: this.config.level,
          enabled: this.config.enabled,
          format: 'json',
        },
        fullContext
      );
    }

    // For text format, chain the handlers
    const parentHandler = this.config.handler;
    return new Logger({
      level: this.config.level,
      enabled: this.config.enabled,
      format: 'text',
      handler: {
        debug: (msg, meta) => parentHandler.debug(`[${context}] ${msg}`, meta),
        info: (msg, meta) => parentHandler.info(`[${context}] ${msg}`, meta),
        warn: (msg, meta) => parentHandler.warn(`[${context}] ${msg}`, meta),
        error: (msg, meta) => parentHandler.error(`[${context}] ${msg}`, meta),
      },
    });
  }

  /**
   * Update logger configuration
   */
  configure(config: Partial<LoggerConfig>): void {
    Object.assign(this.config, config);
  }
}

// Default global logger instance
export const logger = new Logger({
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  enabled: process.env.LOG_ENABLED !== 'false',
  format: (process.env.LOG_FORMAT as LogFormat) || 'text',
});

/**
 * Create a new logger instance with custom configuration
 */
export function createLogger(config?: LoggerConfig): Logger {
  return new Logger(config);
}

/**
 * A no-op logger that silently discards all log messages.
 * Used as the default for library code to ensure silent operation unless
 * the consumer explicitly provides a logger.
 */
class NoopLogger implements ILogger {
  debug(_message: string, _meta?: any): void {}
  info(_message: string, _meta?: any): void {}
  warn(_message: string, _meta?: any): void {}
  error(_message: string, _meta?: any): void {}
  child(_context: string): ILogger {
    return this;
  }
}

/**
 * Singleton no-op logger instance for library internal use.
 * Libraries should use this as their default logger to remain silent
 * unless the consumer injects their own logger.
 */
export const noopLogger: ILogger = new NoopLogger();
