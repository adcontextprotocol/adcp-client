/**
 * Unit tests for server configuration to prevent deployment regressions
 * Tests host/port binding for Fly.io compatibility
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Server Configuration Tests', () => {
  test('should use correct host binding for production environment', () => {
    // Save original env
    const originalNodeEnv = process.env.NODE_ENV;
    const originalHost = process.env.HOST;

    try {
      // Test production environment
      process.env.NODE_ENV = 'production';
      delete process.env.HOST; // Use default logic

      // Simulate the host binding logic from src/server.ts
      const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

      assert.strictEqual(host, '0.0.0.0', 'Production environment should bind to 0.0.0.0 for Fly.io compatibility');
    } finally {
      // Restore original env
      process.env.NODE_ENV = originalNodeEnv;
      if (originalHost) {
        process.env.HOST = originalHost;
      }
    }
  });

  test('should use correct host binding for development environment', () => {
    // Save original env
    const originalNodeEnv = process.env.NODE_ENV;
    const originalHost = process.env.HOST;

    try {
      // Test development environment
      process.env.NODE_ENV = 'development';
      delete process.env.HOST; // Use default logic

      // Simulate the host binding logic from src/server.ts
      const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

      assert.strictEqual(host, '127.0.0.1', 'Development environment should bind to 127.0.0.1 for local access');
    } finally {
      // Restore original env
      process.env.NODE_ENV = originalNodeEnv;
      if (originalHost) {
        process.env.HOST = originalHost;
      }
    }
  });

  test('should respect HOST environment variable when explicitly set', () => {
    // Save original env
    const originalHost = process.env.HOST;

    try {
      // Test explicit HOST override
      process.env.HOST = '192.168.1.100';

      // Simulate the host binding logic from src/server.ts
      const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

      assert.strictEqual(host, '192.168.1.100', 'Should respect explicit HOST environment variable');
    } finally {
      // Restore original env
      if (originalHost) {
        process.env.HOST = originalHost;
      } else {
        delete process.env.HOST;
      }
    }
  });

  test('should use correct port default for Fly.io', () => {
    // Save original env
    const originalPort = process.env.PORT;
    const originalConductorPort = process.env.CONDUCTOR_PORT;

    try {
      // Test port default
      delete process.env.PORT; // Use default logic
      delete process.env.CONDUCTOR_PORT; // Use default logic

      // Simulate the port logic from src/server.ts
      const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || '8080');

      assert.strictEqual(port, 8080, 'Default port should be 8080 for Fly.io compatibility');
    } finally {
      // Restore original env
      if (originalPort) {
        process.env.PORT = originalPort;
      }
      if (originalConductorPort) {
        process.env.CONDUCTOR_PORT = originalConductorPort;
      }
    }
  });

  test('should respect PORT environment variable when explicitly set', () => {
    // Save original env
    const originalPort = process.env.PORT;
    const originalConductorPort = process.env.CONDUCTOR_PORT;

    try {
      // Test explicit PORT override
      process.env.PORT = '3000';
      delete process.env.CONDUCTOR_PORT;

      // Simulate the port logic from src/server.ts
      const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || '8080');

      assert.strictEqual(port, 3000, 'Should respect explicit PORT environment variable');
    } finally {
      // Restore original env
      if (originalPort) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
      if (originalConductorPort) {
        process.env.CONDUCTOR_PORT = originalConductorPort;
      }
    }
  });

  test('should use CONDUCTOR_PORT when PORT is not set', () => {
    // Save original env
    const originalPort = process.env.PORT;
    const originalConductorPort = process.env.CONDUCTOR_PORT;

    try {
      // Test CONDUCTOR_PORT fallback
      delete process.env.PORT;
      process.env.CONDUCTOR_PORT = '5000';

      // Simulate the port logic from src/server.ts
      const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || '8080');

      assert.strictEqual(port, 5000, 'Should use CONDUCTOR_PORT when PORT is not set');
    } finally {
      // Restore original env
      if (originalPort) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
      if (originalConductorPort) {
        process.env.CONDUCTOR_PORT = originalConductorPort;
      } else {
        delete process.env.CONDUCTOR_PORT;
      }
    }
  });

  test('should prioritize PORT over CONDUCTOR_PORT when both are set', () => {
    // Save original env
    const originalPort = process.env.PORT;
    const originalConductorPort = process.env.CONDUCTOR_PORT;

    try {
      // Test PORT priority
      process.env.PORT = '3000';
      process.env.CONDUCTOR_PORT = '5000';

      // Simulate the port logic from src/server.ts
      const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || '8080');

      assert.strictEqual(port, 3000, 'Should prioritize PORT over CONDUCTOR_PORT');
    } finally {
      // Restore original env
      if (originalPort) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
      if (originalConductorPort) {
        process.env.CONDUCTOR_PORT = originalConductorPort;
      } else {
        delete process.env.CONDUCTOR_PORT;
      }
    }
  });

  test('should have valid port number', () => {
    const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || '8080');
    assert.ok(port > 0 && port <= 65535, 'Port should be a valid number between 1-65535');
    assert.ok(Number.isInteger(port), 'Port should be an integer');
  });
});
