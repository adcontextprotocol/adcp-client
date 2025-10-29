/**
 * Logger utility for AdCP Client
 *
 * Provides structured logging with levels and contextual metadata.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  /** Minimum log level to output (default: 'info') */
  level?: LogLevel;
  /** Enable/disable logging globally (default: true) */
  enabled?: boolean;
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
  error: 3
};

class Logger {
  private config: Required<LoggerConfig>;

  constructor(config: LoggerConfig = {}) {
    this.config = {
      level: config.level || 'info',
      enabled: config.enabled !== false,
      handler: config.handler || {
        debug: (msg, meta) => console.log(msg, meta ? meta : ''),
        info: (msg, meta) => console.log(msg, meta ? meta : ''),
        warn: (msg, meta) => console.warn(msg, meta ? meta : ''),
        error: (msg, meta) => console.error(msg, meta ? meta : '')
      }
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
    const parentHandler = this.config.handler;
    return new Logger({
      ...this.config,
      handler: {
        debug: (msg, meta) => parentHandler.debug(`[${context}] ${msg}`, meta),
        info: (msg, meta) => parentHandler.info(`[${context}] ${msg}`, meta),
        warn: (msg, meta) => parentHandler.warn(`[${context}] ${msg}`, meta),
        error: (msg, meta) => parentHandler.error(`[${context}] ${msg}`, meta)
      }
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
  enabled: process.env.LOG_ENABLED !== 'false'
});

/**
 * Create a new logger instance with custom configuration
 */
export function createLogger(config?: LoggerConfig): Logger {
  return new Logger(config);
}
