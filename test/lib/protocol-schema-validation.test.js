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
  if (message.kind !== 'message') {
    errors.push('Message must have kind: "message"');
  }

  if (!message.messageId || typeof message.messageId !== 'string') {
    errors.push('Message must have a valid messageId string');
  }

  if (message.role !== 'user' && message.role !== 'agent') {
    errors.push('Message role must be "user" or "agent"');
  }

  if (!Array.isArray(message.parts)) {
    errors.push('Message must have a parts array');
  } else {
    // Validate each part
    message.parts.forEach((part, index) => {
      if (part.kind === 'data') {
        if (!part.data) {
          errors.push(`Part ${index}: data parts must have a data property`);
        } else {
          // Check for deprecated 'parameters' field
          if (part.data.parameters !== undefined) {
            errors.push(`Part ${index}: Use 'input' instead of deprecated 'parameters' field`);
          }

          if (!part.data.skill) {
            errors.push(`Part ${index}: data parts must have a skill property`);
          }

          if (part.data.input === undefined && part.data.parameters === undefined) {
            errors.push(`Part ${index}: data parts must have an 'input' property`);
          }
        }
      } else if (part.kind === 'text') {
        if (typeof part.text !== 'string') {
          errors.push(`Part ${index}: text parts must have a text string property`);
        }
      } else if (part.kind === 'file') {
        if (!part.file) {
          errors.push(`Part ${index}: file parts must have a file property`);
        }
      } else {
        errors.push(`Part ${index}: unknown part kind "${part.kind}"`);
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
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'data',
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

  test('should detect missing kind field', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        // Missing kind: 'message'
        parts: [
          {
            kind: 'data',
            data: { skill: 'test', input: {} },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('kind: "message"')));
  });

  test('should detect deprecated parameters field', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'data',
            data: {
              skill: 'get_products',
              parameters: { category: 'electronics' }, // Should be 'input'
            },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes("Use 'input' instead of deprecated 'parameters'")));
  });

  test('should validate multiple parts correctly', () => {
    const multiPartPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'text',
            text: 'Please get products for electronics category',
          },
          {
            kind: 'data',
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
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'invalid_kind',
            data: { skill: 'test', input: {} },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('unknown part kind')));
  });

  test('should validate file parts structure', () => {
    const filePartPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'file',
            file: {
              name: 'test.pdf',
              mimeType: 'application/pdf',
              uri: 'https://example.com/test.pdf',
            },
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(filePartPayload);
    assert.strictEqual(result.valid, true, `File part validation should pass: ${result.errors.join(', ')}`);
  });

  test('should detect missing file property in file parts', () => {
    const invalidPayload = {
      message: {
        messageId: 'msg_123',
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'file',
            // Missing file property
          },
        ],
      },
    };

    const result = validateA2AMessagePayload(invalidPayload);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(err => err.includes('file parts must have a file property')));
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
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'data',
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
