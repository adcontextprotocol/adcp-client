/**
 * Protocol Logging Examples
 *
 * Demonstrates how to enable detailed wire-level logging for MCP and A2A protocol requests.
 * This is useful for debugging, monitoring, and understanding exactly what's being sent over the wire.
 */

import { ADCPClient } from '../src/lib';
import type { AgentConfig } from '../src/lib/types';

// ============================================================================
// Example 1: Basic Protocol Logging (All Defaults)
// ============================================================================

const agent: AgentConfig = {
  id: 'my-sales-agent',
  name: 'Sales Agent',
  agent_uri: 'https://sales-agent.example.com',
  protocol: 'mcp',
  auth_token_env: 'YOUR_AUTH_TOKEN_HERE'
};

// Enable protocol logging with all defaults
const clientWithLogging = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true
    // All other options default to true:
    // - logRequests: true
    // - logResponses: true
    // - logRequestBodies: true
    // - logResponseBodies: true
    // - maxBodySize: 50000 (50KB)
    // - redactAuthHeaders: true
  }
});

// When you make a call, you'll see detailed logs in console:
async function example1() {
  const result = await clientWithLogging.getProducts({
    brief: 'Premium coffee brands',
    promoted_offering: 'Artisan coffee'
  });

  // Console output will show:
  // [MCP Request] {
  //   protocol: 'mcp',
  //   method: 'POST',
  //   url: 'https://sales-agent.example.com',
  //   headers: {
  //     'Authorization': '***REDACTED***',
  //     'x-adcp-auth': '***REDACTED***',
  //     'Content-Type': 'application/json'
  //   },
  //   body: {
  //     jsonrpc: '2.0',
  //     method: 'tools/call',
  //     params: {
  //       name: 'get_products',
  //       arguments: {
  //         brief: 'Premium coffee brands',
  //         promoted_offering: 'Artisan coffee'
  //       }
  //     }
  //   },
  //   timestamp: '2025-01-15T10:30:00.000Z'
  // }
  //
  // [MCP Response] {
  //   protocol: 'mcp',
  //   status: 200,
  //   statusText: 'OK',
  //   headers: { 'content-type': 'application/json' },
  //   body: { ... response data ... },
  //   latency: '245ms',
  //   timestamp: '2025-01-15T10:30:00.245Z'
  // }
}

// ============================================================================
// Example 2: Minimal Logging (Headers Only, No Bodies)
// ============================================================================

const clientMinimalLogging = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    logRequests: true,
    logResponses: true,
    logRequestBodies: false,  // Don't log request bodies
    logResponseBodies: false, // Don't log response bodies
    redactAuthHeaders: true
  }
});

// This will only log method, URL, headers, and status codes
async function example2() {
  await clientMinimalLogging.getProducts({
    brief: 'Tech products'
  });

  // Console output will show:
  // [MCP Request] {
  //   protocol: 'mcp',
  //   method: 'POST',
  //   url: 'https://sales-agent.example.com',
  //   headers: { ... },
  //   body: null,  // Not logged
  //   timestamp: '...'
  // }
}

// ============================================================================
// Example 3: Maximum Verbosity (Show Everything Including Auth Headers)
// ============================================================================

const clientMaxVerbosity = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    logRequests: true,
    logResponses: true,
    logRequestBodies: true,
    logResponseBodies: true,
    maxBodySize: 100000, // Allow larger bodies (100KB)
    redactAuthHeaders: false // CAUTION: Shows actual auth tokens!
  }
});

// WARNING: Only use redactAuthHeaders: false in local development!
// This will expose your actual authentication tokens in logs.
async function example3() {
  await clientMaxVerbosity.getProducts({
    brief: 'Fashion items'
  });

  // Console output will show actual tokens:
  // [MCP Request] {
  //   headers: {
  //     'Authorization': 'Bearer actual_token_here',  // Not redacted!
  //     'x-adcp-auth': 'actual_token_here'           // Not redacted!
  //   },
  //   ...
  // }
}

// ============================================================================
// Example 4: Body Size Limits (Prevent Large Payloads from Filling Logs)
// ============================================================================

const clientWithSizeLimit = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    maxBodySize: 5000 // Only log first 5KB of request/response bodies
  }
});

async function example4() {
  // If response is larger than 5KB, it will be truncated:
  const result = await clientWithSizeLimit.listCreatives({
    media_buy_id: 'mb_123'
  });

  // Console output might show:
  // [MCP Response] {
  //   body: "{ ... first 5000 bytes ... [TRUNCATED: 15000 bytes]",
  //   latency: '350ms'
  // }
}

// ============================================================================
// Example 5: A2A Protocol Logging (Works the Same Way)
// ============================================================================

const a2aAgent: AgentConfig = {
  id: 'my-a2a-agent',
  name: 'A2A Sales Agent',
  agent_uri: 'https://a2a-agent.example.com',
  protocol: 'a2a',
  auth_token_env: 'YOUR_AUTH_TOKEN_HERE'
};

const a2aClient = new ADCPClient(a2aAgent, {
  protocolLogging: {
    enabled: true,
    logRequestBodies: true,
    logResponseBodies: true
  }
});

async function example5() {
  await a2aClient.getProducts({
    brief: 'Luxury watches'
  });

  // Console output will show:
  // [A2A Request] {
  //   protocol: 'a2a',
  //   method: 'POST',
  //   url: 'https://a2a-agent.example.com/.well-known/agent-card.json',
  //   headers: { ... },
  //   body: {
  //     message: {
  //       messageId: 'msg_123',
  //       role: 'user',
  //       kind: 'message',
  //       parts: [{
  //         kind: 'data',
  //         data: {
  //           skill: 'get_products',
  //           input: {
  //             brief: 'Luxury watches'
  //           }
  //         }
  //       }]
  //     }
  //   },
  //   timestamp: '...'
  // }
  //
  // [A2A Response] {
  //   protocol: 'a2a',
  //   status: 200,
  //   statusText: 'OK',
  //   body: { ... A2A message response ... },
  //   latency: '420ms'
  // }
}

// ============================================================================
// Example 6: Custom Log Handler (Integrate with Your Logging System)
// ============================================================================

import { logger, type LoggerConfig } from '../src/lib/utils/logger';

// Configure the logger to use a custom handler
const customLoggerConfig: LoggerConfig = {
  level: 'debug',
  enabled: true,
  handler: {
    debug: (message: string, meta?: any) => {
      // Send to your logging service (e.g., DataDog, Splunk, etc.)
      console.log(JSON.stringify({
        level: 'debug',
        message,
        meta,
        timestamp: new Date().toISOString(),
        service: 'adcp-client'
      }));
    },
    info: (message: string, meta?: any) => {
      console.log(JSON.stringify({ level: 'info', message, meta }));
    },
    warn: (message: string, meta?: any) => {
      console.warn(JSON.stringify({ level: 'warn', message, meta }));
    },
    error: (message: string, meta?: any) => {
      console.error(JSON.stringify({ level: 'error', message, meta }));
    }
  }
};

// Apply custom logger config globally
logger.configure(customLoggerConfig);

// Now all protocol logs will use your custom handler
const clientWithCustomLogger = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true
  }
});

async function example6() {
  await clientWithCustomLogger.getProducts({
    brief: 'Electronics'
  });

  // Your custom handler will receive structured JSON logs:
  // {
  //   "level": "debug",
  //   "message": "[MCP Request]",
  //   "meta": {
  //     "protocol": "mcp",
  //     "method": "POST",
  //     "url": "https://sales-agent.example.com",
  //     ...
  //   },
  //   "timestamp": "2025-01-15T10:30:00.000Z",
  //   "service": "adcp-client"
  // }
}

// ============================================================================
// Example 7: Environment Variable Configuration
// ============================================================================

// You can control logging via environment variables:
// - LOG_LEVEL=debug (enables debug-level logging)
// - LOG_ENABLED=true (enables logging globally)

// Set environment variables (in .env file or shell):
// LOG_LEVEL=debug
// LOG_ENABLED=true

const clientWithEnvConfig = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true
  }
});

// The logger will automatically pick up LOG_LEVEL and LOG_ENABLED

// ============================================================================
// Example 8: Debugging Production Issues
// ============================================================================

// Use protocol logging to debug issues in production:

const productionClient = new ADCPClient(agent, {
  protocolLogging: {
    enabled: process.env.NODE_ENV === 'development', // Only in dev
    logRequestBodies: true,
    logResponseBodies: true,
    redactAuthHeaders: true, // Always redact in production
    maxBodySize: 10000 // Smaller limit for production
  }
});

async function debugProductionIssue() {
  try {
    const result = await productionClient.createMediaBuy({
      // ... parameters
    });

    // If there's an error, the logs will show:
    // - Exact request payload sent
    // - Exact response received
    // - Request/response latency
    // - All headers (with auth redacted)

  } catch (error) {
    console.error('Media buy failed:', error);
    // Check console for detailed protocol logs to diagnose
  }
}

// ============================================================================
// Example 9: Filtering Logs by Protocol
// ============================================================================

// If you only want to see MCP or A2A logs, you can filter in your log handler:

logger.configure({
  handler: {
    debug: (message: string, meta?: any) => {
      // Only log MCP requests
      if (message.includes('[MCP Request]')) {
        console.log(message, meta);
      }
    },
    info: console.log,
    warn: console.warn,
    error: console.error
  }
});

// ============================================================================
// Best Practices
// ============================================================================

/**
 * 1. Development:
 *    - Enable full logging with redactAuthHeaders: true
 *    - Use maxBodySize to prevent log spam
 *
 * 2. Staging:
 *    - Enable logging but with smaller maxBodySize (5-10KB)
 *    - Always redact auth headers
 *
 * 3. Production:
 *    - Disable by default (enabled: false)
 *    - Enable conditionally via feature flag or environment variable
 *    - Use custom log handler to send to logging service
 *    - Keep maxBodySize small (1-5KB)
 *    - Always redact auth headers
 *
 * 4. Debugging:
 *    - Temporarily enable in production for specific users/requests
 *    - Use correlation IDs to trace requests across systems
 *    - Monitor log volume to avoid overwhelming logging service
 *
 * 5. Performance:
 *    - Logging adds minimal overhead (~1-5ms per request)
 *    - Body cloning for response logging may add 1-2ms
 *    - Use logRequestBodies: false / logResponseBodies: false to reduce overhead
 */

// ============================================================================
// Run Examples
// ============================================================================

async function runExamples() {
  console.log('=== Example 1: Basic Protocol Logging ===');
  await example1();

  console.log('\n=== Example 2: Minimal Logging ===');
  await example2();

  console.log('\n=== Example 3: Maximum Verbosity (CAUTION) ===');
  await example3();

  console.log('\n=== Example 4: Body Size Limits ===');
  await example4();

  console.log('\n=== Example 5: A2A Protocol ===');
  await example5();

  console.log('\n=== Example 6: Custom Log Handler ===');
  await example6();
}

// Uncomment to run:
// runExamples().catch(console.error);
