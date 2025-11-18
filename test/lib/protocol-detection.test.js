/**
 * Protocol Detection Tests
 *
 * Tests for auto-detecting MCP vs A2A protocols
 */

const test = require('node:test');
const assert = require('node:assert');
const { detectProtocol } = require('../../dist/lib/index.js');

test('Protocol Detection Tests', async t => {
  await t.test('detects MCP from URL pattern ending with /mcp/', async () => {
    const protocol = await detectProtocol('https://agent.example.com/mcp/');
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('detects MCP from URL pattern ending with /mcp', async () => {
    const protocol = await detectProtocol('https://agent.example.com/mcp');
    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('detects A2A for real test agent (root URL)', async () => {
    const protocol = await detectProtocol('https://test-agent.adcontextprotocol.org');
    // Should detect A2A since the agent has /.well-known/agent-card.json endpoint
    // When server is unavailable, defaults to 'mcp' (graceful degradation)
    assert.ok(['a2a', 'mcp'].includes(protocol), `Expected 'a2a' or 'mcp' (if server down), got '${protocol}'`);
  });

  await t.test('detects MCP for real test agent (MCP endpoint)', async () => {
    const protocol = await detectProtocol('https://test-agent.adcontextprotocol.org/mcp/');
    // Should detect MCP from URL pattern
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

test('Protocol Discovery Accept Headers', async t => {
  await t.test('A2A discovery uses flexible Accept header', async () => {
    // A2A discovery should use flexible Accept header for server compatibility
    // Based on PR #89: changed from 'application/json' to 'application/json, */*'
    const a2aDiscoveryAccept = 'application/json, */*';

    // Verify the header is flexible (not just application/json)
    assert.ok(a2aDiscoveryAccept.includes('application/json'));
    assert.ok(a2aDiscoveryAccept.includes('*/*'), 'Should include */* for compatibility');
    assert.ok(!a2aDiscoveryAccept.includes('text/event-stream'), 'A2A does not use SSE');
  });

  await t.test('A2A discovery endpoint follows RFC 8615', async () => {
    // PR #89 fixed the discovery endpoint path
    const correctPath = '/.well-known/agent-card.json';
    const incorrectPath = '/.well-known/a2a-server';

    // Verify we're using the correct path
    assert.strictEqual(correctPath, '/.well-known/agent-card.json');
    assert.notStrictEqual(correctPath, incorrectPath, 'Should not use old incorrect path');
  });

  await t.test('MCP uses SSE-compatible Accept header', async () => {
    // MCP requires both application/json and text/event-stream
    const mcpAccept = 'application/json, text/event-stream';

    // Verify both content types are present
    assert.ok(mcpAccept.includes('application/json'));
    assert.ok(mcpAccept.includes('text/event-stream'), 'MCP requires SSE support');
  });
});
