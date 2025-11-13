/**
 * Logger Usage Examples
 *
 * Demonstrates how to use the structured logger in AdCP Client
 */

import { logger, createLogger } from '../src/lib/utils/logger';

// ====== BASIC USAGE ======

console.log('\n=== Basic Usage ===\n');

logger.debug('Debugging info (only visible if LOG_LEVEL=debug)');
logger.info('General information');
logger.warn('Warning message');
logger.error('Error message');

// ====== LOGGING WITH METADATA ======

console.log('\n=== Logging with Metadata ===\n');

logger.info('Task completed', {
  taskId: 'task_123',
  duration: 1250,
  status: 'success',
});

logger.error('Connection failed', {
  agentId: 'agent_xyz',
  error: 'ECONNREFUSED',
  retryCount: 3,
});

// ====== CONTEXT-AWARE LOGGING ======

console.log('\n=== Context-Aware Logging ===\n');

// Create protocol-specific logger
const mcpLogger = logger.child('MCP');
mcpLogger.info('Connecting to agent', { url: 'https://agent.example.com' });
mcpLogger.debug('Sending initialize request');

// Create nested context
const toolLogger = mcpLogger.child('get_products');
toolLogger.info('Calling tool', { params: { brief: 'Coffee products' } });
toolLogger.debug('Parsing response');

// ====== CUSTOM LOGGER INSTANCES ======

console.log('\n=== Custom Logger Instances ===\n');

// Create a debug-level logger for development
const devLogger = createLogger({
  level: 'debug',
  enabled: true,
});

devLogger.debug('This message is visible with debug level');
devLogger.info('Standard info message');

// Create a production logger (warn level only)
const prodLogger = createLogger({
  level: 'warn',
  enabled: true,
});

prodLogger.debug('This will NOT be logged');
prodLogger.info('This will NOT be logged');
prodLogger.warn('This WILL be logged');
prodLogger.error('This WILL be logged');

// ====== CUSTOM LOG HANDLERS ======

console.log('\n=== Custom Log Handlers ===\n');

// Example: Send logs to external service
const externalLogger = createLogger({
  level: 'info',
  handler: {
    debug: (msg, meta) => console.log(`[EXT-DEBUG] ${msg}`, meta || ''),
    info: (msg, meta) => console.log(`[EXT-INFO] ${msg}`, meta || ''),
    warn: (msg, meta) => console.log(`[EXT-WARN] ${msg}`, meta || ''),
    error: (msg, meta) => console.log(`[EXT-ERROR] ${msg}`, meta || ''),
  },
});

externalLogger.info('Using custom handler', { service: 'external' });

// ====== RUNTIME CONFIGURATION ======

console.log('\n=== Runtime Configuration ===\n');

// Start with info level
logger.configure({ level: 'info' });
logger.debug('This will NOT be logged');
logger.info('This will be logged');

// Change to debug level
logger.configure({ level: 'debug' });
logger.debug('Now this WILL be logged');

// Disable logging temporarily
logger.configure({ enabled: false });
logger.error('This will NOT be logged (disabled)');

// Re-enable
logger.configure({ enabled: true });
logger.info('Logging re-enabled');

// ====== PRACTICAL EXAMPLES ======

console.log('\n=== Practical Examples ===\n');

// Example 1: Component-specific logging
class MediaBuyService {
  private logger = logger.child('MediaBuyService');

  async createMediaBuy(params: any) {
    this.logger.info('Creating media buy', { params });

    try {
      // Simulate API call
      this.logger.debug('Calling agent API');
      // ...
      this.logger.info('Media buy created', { buyId: 'mb_123' });
    } catch (error) {
      this.logger.error('Failed to create media buy', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      throw error;
    }
  }
}

const service = new MediaBuyService();
service.createMediaBuy({ brief: 'Coffee campaign' });

// Example 2: Protocol client logging
class ProtocolClient {
  private logger = logger.child('ProtocolClient');

  async connect(protocol: string, url: string) {
    const protocolLogger = this.logger.child(protocol.toUpperCase());

    protocolLogger.info('Connecting to agent', { url });

    try {
      // Simulate connection
      protocolLogger.debug('Sending initialize request');
      protocolLogger.info('Connected successfully');
    } catch (error) {
      protocolLogger.error('Connection failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

const client = new ProtocolClient();
client.connect('mcp', 'https://agent.example.com');

console.log('\n=== Examples Complete ===\n');
