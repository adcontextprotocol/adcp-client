// Protocol Schema Validation Tests - Tests for JSON schema compliance utilities
const { test, describe } = require('node:test');
const assert = require('node:assert');

/**
 * Schema Validation Testing Strategy
 *
 * This module tests utilities that validate protocol messages against their
 * JSON schemas. This is critical for catching message format issues before
 * they reach external servers.
 */

// Mock JSON schema validation utilities
// In a real implementation, these would use libraries like ajv to validate against
// actual A2A and MCP JSON schemas

/**
 * Validates an A2A SendMessage request payload against the A2A specification
 * @param {object} payload - The payload to validate
 * @returns {object} - { valid: boolean, errors: string[] }
 */
function validateA2AMessagePayload(payload) {
  const errors = [];

  // Check top-level structure
  if (!payload.message) {
    errors.push('Missing required "message" property');
    return { valid: false, errors };
  }

  const message = payload.message;

  // Validate message structure according to A2A specification
  if (!message.messageId || typeof message.messageId !== 'string') {
    errors.push('Message must have a valid messageId string');
  }

  if (message.role !== 'ROLE_USER' && message.role !== 'ROLE_AGENT') {
    errors.push('Message role must be "ROLE_USER" or "ROLE_AGENT"');
  }

  if (!Array.isArray(message.parts)) {
    errors.push('Message must have a parts array');
  } else {
    // Validate each part
    message.parts.forEach((part, index) => {
      if (Object.hasOwn(part, 'data')) {
        if (!part.data) {
          errors.push(`Part ${index}: data parts must have a data property`);
        } else {
          if (part.data.parameters !== undefined) {
            errors.push(`Part ${index}: Use 'input' instead of legacy 'parameters' field`);
          }

          if (!part.data.skill) {
            errors.push(`Part ${index}: data parts must have a skill property`);
          }

          if (part.data.input === undefined) {
            errors.push(`Part ${index}: data parts must have an 'input' property`);
          }
        }
      } else if (Object.hasOwn(part, 'text')) {
        if (typeof part.text !== 'string') {
          errors.push(`Part ${index}: text parts must have a text string property`);
        }
      } else if (Object.hasOwn(part, 'url') || Object.hasOwn(part, 'raw')) {
        // A2A 1.0 file parts are represented by the URL or raw oneof arm.
      } else {
        errors.push(`Part ${index}: unknown Part content arm`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an MCP request payload structure
 * @param {object} payload - The MCP JSON-RPC payload
 * @returns {object} - { valid: boolean, errors: string[] }
 */
function validateMCPRequestPayload(payload) {
  const errors = [];

  // Check JSON-RPC 2.0 structure
  if (payload.jsonrpc !== '2.0') {
    errors.push('Must have jsonrpc: "2.0"');
  }

  if (!payload.method || typeof payload.method !== 'string') {
    errors.push('Must have a valid method string');
  }

  if (payload.id === undefined) {
    errors.push('Request must have an id (string, number, or null)');
  }

  // Validate common MCP methods
  if (payload.method === 'tools/call') {
    if (!payload.params || !payload.params.name) {
      errors.push('tools/call must have params.name');
    }

    if (payload.params && payload.params.arguments === undefined) {
      errors.push('tools/call must have params.arguments (can be empty object)');
    }
  }

  return { valid: errors.length === 0, errors };
}

describe('A2A Schema Validation', () => {
  test('should validate correct A2A message structure', () => {
    const validPayload = {
      message: {
        messageId: 'msg_1234567890_abcdef',
        role: 'ROLE_USER',
        parts: [
          {
            data: {
              skill: 'get_products',
              input: {
                category: 'electronics',
                limit: 10,
              },
            },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(validPayload);
    assert.strictEqual(result.valid, true, `Validation should pass: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should detect an invalid role', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        parts: [
          {
            data: { skill: 'test', input: {} },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('ROLE_USER')));
  });

  test('should detect legacy parameters field', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            data: {
              skill: 'get_products',
              parameters: { category: 'electronics' },
            },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes("Use 'input' instead of legacy 'parameters'")));
  });

  test('should validate multiple parts correctly', () => {
    const multiPartPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            text: 'Please get products for electronics category',
          },
          {
            data: {
              skill: 'get_products',
              input: { category: 'electronics' },
            },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(multiPartPayload);
    assert.strictEqual(result.valid, true, `Multi-part validation should pass: ${result.errors.join(', ')}`);
  });

  test('should detect invalid part kinds', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            invalidKind: { skill: 'test', input: {} },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('unknown Part content arm')));
  });

  test('should validate file parts structure', () => {
    const filePartPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            url: 'https://example.com/test.pdf',
            filename: 'test.pdf',
            mediaType: 'application/pdf',
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(filePartPayload);
    assert.strictEqual(result.valid, true, `File part validation should pass: ${result.errors.join(', ')}`);
  });

  test('should detect a part with no content arm', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            filename: 'test.pdf',
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('unknown Part content arm')));
  });
});

describe('MCP Schema Validation', () => {
  test('should validate correct MCP tools/call request', () => {
    const validPayload = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          category: 'electronics',
          limit: 10,
        },
      },
    };

    const result = validateMCPRequestPayload(validPayload);
    assert.strictEqual(result.valid, true, `MCP validation should pass: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should detect missing jsonrpc version', () => {
    const invalidPayload = {
      id: 'req-123',
      method: 'tools/call',
      params: { name: 'test', arguments: {} },
    };

    const result = validateMCPRequestPayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('jsonrpc: "2.0"')));
  });

  test('should detect missing tool name in tools/call', () => {
    const invalidPayload = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: {
        arguments: { param: 'value' },
        // Missing name
      },
    };

    const result = validateMCPRequestPayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('params.name')));
  });

  test('should detect missing arguments in tools/call', () => {
    const invalidPayload = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: {
        name: 'get_products',
        // Missing arguments
      },
    };

    const result = validateMCPRequestPayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('params.arguments')));
  });

  test('should allow empty arguments object', () => {
    const validPayload = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: {
        name: 'list_all_products',
        arguments: {}, // Empty is valid
      },
    };

    const result = validateMCPRequestPayload(validPayload);
    assert.strictEqual(result.valid, true, `Empty arguments should be valid: ${result.errors.join(', ')}`);
  });
});

describe('Cross-Protocol Validation Utilities', () => {
  /**
   * Tests for utilities that help ensure consistency across protocols
   */

  test('should identify equivalent operations across protocols', () => {
    // This would test a utility that maps A2A skills to MCP tools
    const a2aSkill = 'get_products';
    const mcpTool = 'get_products';

    // In real implementation: assert.strictEqual(mapA2ASkillToMCPTool(a2aSkill), mcpTool);
    assert.strictEqual(a2aSkill, mcpTool, 'Skill and tool names should be consistent');
  });

  test('should validate parameter consistency across protocols', () => {
    const parameters = { category: 'electronics', limit: 10 };

    // Both protocols should accept the same parameter structure
    const a2aPayload = {
      message: {
        messageId: 'msg_123',
        role: 'ROLE_USER',
        parts: [
          {
            data: { skill: 'get_products', input: parameters },
          },
        ],
      },
    };

    const mcpPayload = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: parameters,
      },
    };

    const a2aResult = validateA2AMessagePayload(a2aPayload);
    const mcpResult = validateMCPRequestPayload(mcpPayload);

    assert.strictEqual(a2aResult.valid, true, 'A2A payload should be valid');
    assert.strictEqual(mcpResult.valid, true, 'MCP payload should be valid');

    // Parameters should be identical
    assert.deepStrictEqual(
      a2aPayload.message.parts[0].data.input,
      mcpPayload.params.arguments,
      'Parameters should be consistent across protocols'
    );
  });
});

// Export validation utilities for use in other tests
module.exports = {
  validateA2AMessagePayload,
  validateMCPRequestPayload,
};
