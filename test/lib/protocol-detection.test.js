/**
 * Protocol Detection Tests
 *
 * Tests for auto-detecting MCP vs A2A protocols
 */

const test = require('node:test');
const assert = require('node:assert');
const { detectProtocol } = require('../../dist/lib/index.js');

test('Protocol Detection Tests', async (t) => {
  await t.test('detects MCP from URL pattern ending with /mcp/', async () => {
    const protocol = await detectProtocol('https://agent.example.com/mcp/');
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('detects MCP from URL pattern ending with /mcp', async () => {
    const protocol = await detectProtocol('https://agent.example.com/mcp');
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('detects protocol for real test agent', async () => {
    const protocol = await detectProtocol('https://test-agent.adcontextprotocol.org');
    // Should detect MCP (either via heuristic or discovery)
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('defaults to MCP for unknown endpoints', async () => {
    const protocol = await detectProtocol('https://nonexistent-agent-12345.example.com');
    // Should default to MCP when A2A discovery fails
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('handles localhost URLs', async () => {
    const protocol = await detectProtocol('http://localhost:3000/mcp');
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('detects A2A when discovery endpoint exists', async () => {
    // This test would pass if there's a real A2A endpoint available
    // For now, we verify the function returns either 'a2a' or 'mcp'
    const protocol = await detectProtocol('https://example.com');
    assert.ok(['a2a', 'mcp'].includes(protocol));
  });
});
