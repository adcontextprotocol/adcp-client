/**
 * Well-Known URL Detection Tests
 *
 * Tests for detecting .well-known/agent-card.json URLs and switching to A2A protocol
 * See: https://github.com/adcontextprotocol/adcp-client/issues/175
 */

const test = require('node:test');
const assert = require('node:assert');

/**
 * Direct test of the detection logic (same as in SingleAgentClient)
 */
function isWellKnownAgentCardUrl(url) {
  // Match: https://example.com/.well-known/agent-card.json
  // Don't match: https://example.com/api/.well-known/agent-card.json
  return /^https?:\/\/[^/]+\/\.well-known\/agent-card\.json$/i.test(url);
}

test('Well-Known URL Detection', async (t) => {
  await t.test('detects .well-known/agent-card.json URLs', async () => {
    const wellKnownUrls = [
      'https://example.com/.well-known/agent-card.json',
      'https://agentic-sales.pbs.yahoo.com/.well-known/agent-card.json',
      'http://localhost:3000/.well-known/agent-card.json',
      'https://example.com:8080/.well-known/agent-card.json',
    ];

    for (const url of wellKnownUrls) {
      assert.strictEqual(
        isWellKnownAgentCardUrl(url),
        true,
        `Should detect as well-known URL: ${url}`
      );
    }
  });

  await t.test('does not match non-agent-card well-known URLs', async () => {
    // Only agent-card.json should trigger the A2A switch
    const otherWellKnown = [
      'https://example.com/.well-known/openid-configuration',
      'https://example.com/.well-known/security.txt',
      'https://example.com/.well-known/adagents.json',
    ];

    for (const url of otherWellKnown) {
      assert.strictEqual(
        isWellKnownAgentCardUrl(url),
        false,
        `Should NOT detect as agent-card URL: ${url}`
      );
    }
  });

  await t.test('does not match regular URLs', async () => {
    const regularUrls = [
      'https://example.com',
      'https://example.com/',
      'https://example.com/mcp',
      'https://example.com/mcp/',
      'https://example.com/api/v1/mcp/',
      'http://localhost:3000/mcp/',
    ];

    for (const url of regularUrls) {
      assert.strictEqual(
        isWellKnownAgentCardUrl(url),
        false,
        `Should NOT detect as well-known URL: ${url}`
      );
    }
  });

  await t.test('does not match .well-known in subdirectory', async () => {
    // Edge case: .well-known not at root - should not match
    const input = 'https://example.com/api/.well-known/agent-card.json';
    assert.strictEqual(isWellKnownAgentCardUrl(input), false);
  });

  await t.test('case insensitive matching', async () => {
    const caseVariants = [
      'https://example.com/.well-known/agent-card.json',
      'https://example.com/.WELL-KNOWN/AGENT-CARD.JSON',
      'https://example.com/.Well-Known/Agent-Card.Json',
    ];

    for (const url of caseVariants) {
      assert.strictEqual(
        isWellKnownAgentCardUrl(url),
        true,
        `Should detect case-insensitively: ${url}`
      );
    }
  });
});
