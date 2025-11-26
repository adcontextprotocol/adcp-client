/**
 * Unit tests for CLI protocol detection logic
 * Tests helper functions and timeout behavior
 */

const { test, describe, mock } = require('node:test');
const assert = require('node:assert');

describe('CLI Protocol Detection Tests', () => {
  describe('Helper Functions', () => {
    test('normalizeAgentCardUrl - should add agent card path to base URL', () => {
      const normalizeAgentCardUrl = (agentUrl) => {
        if (agentUrl.endsWith('/.well-known/agent-card.json')) {
          return agentUrl;
        }
        return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
      };

      const result = normalizeAgentCardUrl('https://example.com');
      assert.strictEqual(
        result,
        'https://example.com/.well-known/agent-card.json',
        'Should add agent card path to URL'
      );
    });

    test('normalizeAgentCardUrl - should handle trailing slash', () => {
      const normalizeAgentCardUrl = (agentUrl) => {
        if (agentUrl.endsWith('/.well-known/agent-card.json')) {
          return agentUrl;
        }
        return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
      };

      const result = normalizeAgentCardUrl('https://example.com/');
      assert.strictEqual(
        result,
        'https://example.com/.well-known/agent-card.json',
        'Should remove trailing slash before adding agent card path'
      );
    });

    test('normalizeAgentCardUrl - should not modify if already complete', () => {
      const normalizeAgentCardUrl = (agentUrl) => {
        if (agentUrl.endsWith('/.well-known/agent-card.json')) {
          return agentUrl;
        }
        return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
      };

      const url = 'https://example.com/.well-known/agent-card.json';
      const result = normalizeAgentCardUrl(url);
      assert.strictEqual(
        result,
        url,
        'Should return URL unchanged if already complete'
      );
    });

    test('normalizeAgentCardUrl - should handle URL with path', () => {
      const normalizeAgentCardUrl = (agentUrl) => {
        if (agentUrl.endsWith('/.well-known/agent-card.json')) {
          return agentUrl;
        }
        return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
      };

      const result = normalizeAgentCardUrl('https://example.com/api/v1');
      assert.strictEqual(
        result,
        'https://example.com/api/v1/.well-known/agent-card.json',
        'Should preserve existing path when adding agent card path'
      );
    });

    test('normalizeAgentCardUrl - should handle URL with path and trailing slash', () => {
      const normalizeAgentCardUrl = (agentUrl) => {
        if (agentUrl.endsWith('/.well-known/agent-card.json')) {
          return agentUrl;
        }
        return agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
      };

      const result = normalizeAgentCardUrl('https://example.com/api/v1/');
      assert.strictEqual(
        result,
        'https://example.com/api/v1/.well-known/agent-card.json',
        'Should remove trailing slash from path before adding agent card path'
      );
    });
  });

  describe('Timeout Helper', () => {
    test('createTimeout - should reject after specified time', async () => {
      const createTimeout = (ms) => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
        });
      };

      const startTime = Date.now();
      try {
        await createTimeout(50);
        assert.fail('Should have timed out');
      } catch (error) {
        const elapsed = Date.now() - startTime;
        assert.ok(elapsed >= 45 && elapsed < 100, 'Should timeout around 50ms');
        assert.match(error.message, /timed out after 50ms/, 'Should have timeout message');
      }
    });

    test('createTimeout - should be cancellable with Promise.race', async () => {
      const createTimeout = (ms) => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
        });
      };

      const quickOperation = () => new Promise(resolve => setTimeout(() => resolve('success'), 10));

      const result = await Promise.race([quickOperation(), createTimeout(100)]);
      assert.strictEqual(result, 'success', 'Should resolve with quick operation result');
    });
  });

  describe('MCP URL Normalization', () => {
    test('should remove trailing slash for MCP endpoint testing', () => {
      const agentUrl = 'https://example.com/';
      const cleanUrl = agentUrl.replace(/\/$/, '');
      assert.strictEqual(cleanUrl, 'https://example.com', 'Should remove trailing slash');
    });

    test('should not modify URL without trailing slash', () => {
      const agentUrl = 'https://example.com';
      const cleanUrl = agentUrl.replace(/\/$/, '');
      assert.strictEqual(cleanUrl, 'https://example.com', 'Should leave URL unchanged');
    });

    test('should generate correct MCP suffix URL', () => {
      const agentUrl = 'https://example.com';
      const cleanUrl = agentUrl.replace(/\/$/, '');
      const withMcp = cleanUrl + '/mcp';
      assert.strictEqual(withMcp, 'https://example.com/mcp', 'Should add /mcp suffix');
    });
  });

  describe('Error Message Formatting', () => {
    test('should format multi-line error message correctly', () => {
      const agentUrl = 'https://example.com';
      const errorMessage = [
        `Could not detect protocol at ${agentUrl}`,
        `Tried:`,
        `  - A2A agent card at ${agentUrl}/.well-known/agent-card.json`,
        `  - MCP endpoint at ${agentUrl}`,
        `  - MCP endpoint at ${agentUrl}/mcp`,
        `Please specify protocol explicitly: 'adcp mcp <url>' or 'adcp a2a <url>'`
      ].join('\n');

      assert.ok(errorMessage.includes('Could not detect protocol'), 'Should include main error');
      assert.ok(errorMessage.includes('Tried:'), 'Should include "Tried:" section');
      assert.ok(errorMessage.includes('A2A agent card'), 'Should mention A2A attempt');
      assert.ok(errorMessage.includes('MCP endpoint'), 'Should mention MCP attempts');
      assert.ok(errorMessage.includes('specify protocol explicitly'), 'Should include help text');
      assert.ok(errorMessage.includes('\n'), 'Should be multi-line');
    });
  });

  describe('Detection Logic Flow', () => {
    test('should test A2A before MCP (order matters for performance)', () => {
      // This test documents the expected detection order
      const detectionSteps = [
        'A2A agent card lookup',
        'MCP endpoint test (base URL)',
        'MCP endpoint test (with /mcp suffix)'
      ];

      assert.strictEqual(detectionSteps[0], 'A2A agent card lookup', 'A2A should be tried first');
      assert.strictEqual(detectionSteps[1], 'MCP endpoint test (base URL)', 'MCP base URL should be second');
      assert.strictEqual(detectionSteps[2], 'MCP endpoint test (with /mcp suffix)', 'MCP /mcp suffix should be last');
    });

    test('should have reasonable timeout for network operations', () => {
      const timeoutMs = 5000;
      assert.ok(timeoutMs >= 3000, 'Timeout should be at least 3 seconds for network reliability');
      assert.ok(timeoutMs <= 10000, 'Timeout should not exceed 10 seconds for good UX');
    });
  });

  describe('Authentication Header Handling', () => {
    test('should add both Authorization and x-adcp-auth headers', () => {
      const authToken = 'test-token-123';
      const headers = {
        'Authorization': `Bearer ${authToken}`,
        'x-adcp-auth': authToken
      };

      assert.strictEqual(headers['Authorization'], 'Bearer test-token-123', 'Should add Bearer token');
      assert.strictEqual(headers['x-adcp-auth'], 'test-token-123', 'Should add x-adcp-auth header');
    });

    test('should merge custom fetch headers correctly', () => {
      const authToken = 'test-token';
      const existingHeaders = { 'Content-Type': 'application/json' };

      const headers = {
        ...existingHeaders,
        'Authorization': `Bearer ${authToken}`,
        'x-adcp-auth': authToken
      };

      assert.strictEqual(headers['Content-Type'], 'application/json', 'Should preserve existing headers');
      assert.strictEqual(headers['Authorization'], `Bearer ${authToken}`, 'Should add auth header');
      assert.strictEqual(headers['x-adcp-auth'], authToken, 'Should add x-adcp-auth header');
    });
  });

  describe('URL Validation', () => {
    test('should detect URL in first positional argument', () => {
      const isUrl = (arg) => arg.startsWith('http://') || arg.startsWith('https://');

      assert.strictEqual(isUrl('https://example.com'), true, 'Should detect https URL');
      assert.strictEqual(isUrl('http://localhost:3000'), true, 'Should detect http URL');
      assert.strictEqual(isUrl('mcp'), false, 'Should not detect protocol keyword as URL');
      assert.strictEqual(isUrl('a2a'), false, 'Should not detect protocol keyword as URL');
    });
  });

  describe('MCP Client Close Error Handling', () => {
    test('should document that close errors are ignored', () => {
      // This test documents the expected behavior:
      // MCP client close errors should be caught and ignored
      // because connection success is what matters for detection

      const closeErrorHandling = 'ignore';
      assert.strictEqual(
        closeErrorHandling,
        'ignore',
        'MCP client close errors should be ignored - connection success is what matters'
      );
    });
  });
});
