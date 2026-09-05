/**
 * Logger utility for AdCP Client
 *
 * Provides structured logging with levels and contextual metadata.
 */

import { SECRET_KEY_PATTERN, secretKeyPatternMatches } from './redact-secrets';
import { redactCredentialPatterns } from './redact-credential-patterns';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  /** Minimum log level to output (default: 'info') */
  level?: LogLevel;
  /** Enable/disable logging globally (default: true) */
  enabled?: boolean;
  /**
   * Redact credential-shaped messages and metadata (default: true). Set to
   * false only when a custom handler provides equivalent protection.
   */
  redactCredentials?: boolean;
  /**
   * Custom log handler (default: console). Redaction retains common collection
   * and date types but returns non-mutating copies when enabled.
   */
  handler?: {
    debug: (message: string, meta?: unknown) => void;
    info: (message: string, meta?: unknown) => void;
    warn: (message: string, meta?: unknown) => void;
    error: (message: string, meta?: unknown) => void;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_DEPTH = 32;
const MAX_LOG_NODES = 10_000;
const MAX_LOG_COLLECTION_ENTRIES = 1_000;
const MAX_LOG_STRING_LENGTH = 16_384;
const MAX_LOG_TOTAL_STRING_UNITS = 1_048_576;

interface LogNormalizationState {
  nodes: number;
  seen: WeakSet<object>;
  stringUnits: number;
}

function redactLogMessage(message: string, state?: LogNormalizationState): string {
  if (message.length > MAX_LOG_STRING_LENGTH) return '[Oversized string redacted]';
  if (state) {
    if (state.stringUnits + message.length > MAX_LOG_TOTAL_STRING_UNITS) return '[String unit limit exceeded]';
    state.stringUnits += message.length;
  }
  return redactCredentialPatterns(message) as string;
}

function findErrorDataString(error: Error, key: 'name' | 'message' | 'stack', fallback: string): string {
  let current: object | null = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : fallback;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return fallback;
}

function normalizeLogMetadata(value: unknown, state: LogNormalizationState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_LOG_NODES) return '[Node limit exceeded]';
  if (typeof value === 'string') return redactLogMessage(value, state);
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (depth > MAX_LOG_DEPTH) return '[Max depth exceeded]';
  if (state.seen.has(value)) return '[Circular]';

  state.seen.add(value);
  let normalized: unknown;
  if (value instanceof Error) {
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    const name = findErrorDataString(value, 'name', 'Error');
    const message = findErrorDataString(value, 'message', '');
    const stack = findErrorDataString(value, 'stack', '');
    const serialized = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(serialized, {
      name: {
        value: redactLogMessage(name, state),
        configurable: true,
        enumerable: true,
        writable: true,
      },
      message: {
        value: redactLogMessage(message, state),
        configurable: true,
        enumerable: true,
        writable: true,
      },
    });
    if (stack) {
      Object.defineProperty(serialized, 'stack', {
        value: redactLogMessage(stack, state),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    if (cause && 'value' in cause) {
      Object.defineProperty(serialized, 'cause', {
        value: normalizeLogMetadata(cause.value, state, depth + 1),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    copyEnumerableDataProperties(value, serialized, state, depth, new Set(['name', 'message', 'stack', 'cause']));
    normalized = serialized;
  } else if (value instanceof Date) {
    normalized = new Date(value.getTime());
  } else if (value instanceof Map) {
    const entries = new Map<unknown, unknown>();
    let count = 0;
    for (const [key, entry] of value) {
      if (count++ >= MAX_LOG_COLLECTION_ENTRIES) {
        entries.set('[Entry limit exceeded]', true);
        break;
      }
      const secretKey = typeof key === 'string' && secretKeyPatternMatches(SECRET_KEY_PATTERN, key);
      const normalizedKey = normalizeLogMetadata(key, state, depth + 1);
      entries.set(
        collisionSafeMapKey(entries, normalizedKey),
        secretKey ? '[redacted]' : normalizeLogMetadata(entry, state, depth + 1)
      );
    }
    normalized = entries;
  } else if (value instanceof Set) {
    const values = new Set<unknown>();
    let count = 0;
    for (const entry of value) {
      if (count++ >= MAX_LOG_COLLECTION_ENTRIES) {
        values.add('[Entry limit exceeded]');
        break;
      }
      values.add(normalizeLogMetadata(entry, state, depth + 1));
    }
    normalized = values;
  } else if (value instanceof RegExp) {
    normalized = new RegExp(redactLogMessage(value.source, state), value.flags);
  } else if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_LOG_COLLECTION_ENTRIES)
      .map(entry => normalizeLogMetadata(entry, state, depth + 1));
    if (value.length > MAX_LOG_COLLECTION_ENTRIES) entries.push('[Entry limit exceeded]');
    normalized = entries;
  } else if (typeof value === 'function') {
    const object: Record<string, unknown> = { type: 'Function' };
    copyEnumerableDataProperties(value, object, state, depth);
    normalized = object;
  } else {
    const object = Object.create(null) as Record<string, unknown>;
    copyEnumerableDataProperties(value, object, state, depth);
    normalized = object;
  }
  state.seen.delete(value);
  return normalized;
}

function collisionSafeMapKey(entries: ReadonlyMap<unknown, unknown>, key: unknown): unknown {
  if (!entries.has(key) || typeof key !== 'string') return key;
  let suffix = 2;
  while (entries.has(`${key}#${suffix}`)) suffix++;
  return `${key}#${suffix}`;
}

function copyEnumerableDataProperties(
  source: object,
  target: Record<string, unknown>,
  state: LogNormalizationState,
  depth: number,
  excluded: ReadonlySet<string> = new Set()
): void {
  let examined = 0;
  let copied = 0;
  let truncated = false;
  for (const key in source) {
    if (examined++ >= MAX_LOG_COLLECTION_ENTRIES * 2) {
      truncated = true;
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (copied++ >= MAX_LOG_COLLECTION_ENTRIES) {
      truncated = true;
      break;
    }
    if (excluded.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    const entry = descriptor && 'value' in descriptor ? descriptor.value : '[Accessor]';
    const redactedKey = redactLogMessage(key, state);
    let safeKey = redactedKey;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(target, safeKey)) safeKey = `${redactedKey}#${suffix++}`;
    Object.defineProperty(target, safeKey, {
      value: secretKeyPatternMatches(SECRET_KEY_PATTERN, key)
        ? '[redacted]'
        : normalizeLogMetadata(entry, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (truncated) target['[Entry limit exceeded]'] = true;
}

function prepareLogMetadata(value: unknown): unknown {
  try {
    return normalizeLogMetadata(value, { nodes: 0, seen: new WeakSet(), stringUnits: 0 });
  } catch {
    return '[Unserializable metadata]';
  }
}

class Logger {
  private config: Required<LoggerConfig>;
  private usingDefaultHandler: boolean;

  constructor(config: LoggerConfig = {}) {
    if (config.redactCredentials === false && !config.handler) {
      throw new Error('redactCredentials can only be disabled when a custom log handler is provided');
    }
    this.usingDefaultHandler = config.handler === undefined;
    this.config = {
      level: config.level || 'info',
      enabled: config.enabled !== false,
      redactCredentials: config.redactCredentials !== false,
      handler: config.handler || {
        // Logger inputs are scrubbed immediately before handler dispatch. The
        // generic logging API itself is not a credential-storage primitive.
        // codeql[js/clear-text-logging]
        debug: (msg, meta) => console.log(msg, meta ?? ''),
        // codeql[js/clear-text-logging]
        info: (msg, meta) => console.log(msg, meta ?? ''),
        // codeql[js/clear-text-logging]
        warn: (msg, meta) => console.warn(msg, meta ?? ''),
        // codeql[js/clear-text-logging]
        error: (msg, meta) => console.error(msg, meta ?? ''),
      },
    };
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false;
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  /**
   * Log debug message (development/troubleshooting)
   */
  debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      this.config.handler.debug(
        this.config.redactCredentials ? redactLogMessage(message) : message,
        this.config.redactCredentials ? prepareLogMetadata(meta) : meta
      );
    }
  }

  /**
   * Log info message (general information)
   */
  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      this.config.handler.info(
        this.config.redactCredentials ? redactLogMessage(message) : message,
        this.config.redactCredentials ? prepareLogMetadata(meta) : meta
      );
    }
  }

  /**
   * Log warning message (non-critical issues)
   */
  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      this.config.handler.warn(
        this.config.redactCredentials ? redactLogMessage(message) : message,
        this.config.redactCredentials ? prepareLogMetadata(meta) : meta
      );
    }
  }

  /**
   * Log error message (critical issues)
   */
  error(message: string, meta?: unknown): void {
    if (this.shouldLog('error')) {
      this.config.handler.error(
        this.config.redactCredentials ? redactLogMessage(message) : message,
        this.config.redactCredentials ? prepareLogMetadata(meta) : meta
      );
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
        error: (msg, meta) => parentHandler.error(`[${context}] ${msg}`, meta),
      },
    });
  }

  /**
   * Update logger configuration
   */
  configure(config: Partial<LoggerConfig>): void {
    if (config.redactCredentials === false && !config.handler && this.usingDefaultHandler) {
      throw new Error('redactCredentials can only be disabled when a custom log handler is provided');
    }
    Object.assign(this.config, config);
    if (config.handler) this.usingDefaultHandler = false;
  }
}

// Default global logger instance
export const logger = new Logger({
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  enabled: process.env.LOG_ENABLED !== 'false',
});

/**
 * Create a new logger instance with custom configuration
 */
export function createLogger(config?: LoggerConfig): Logger {
  return new Logger(config);
}
