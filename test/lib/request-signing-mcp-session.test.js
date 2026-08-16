// Tests for MCP session initialization and Mcp-Session-Id header injection.
// Validates that (1) the grader auto-initializes a session when transport='mcp',
// (2) the session ID is injected AFTER signing so it is not a covered component,
// and (3) passing '' opts out of auto-init for stateless servers.

const test = require('node:test');
const assert = require('node:assert');

test('MCP session injection preserves the already-computed signature headers byte-for-byte', () => {
  const { attachMcpSessionHeader } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const signedHeaders = {
    'Content-Type': 'application/json',
    'Content-Digest': 'sha-256=:signed-digest:',
    'Signature-Input': 'sig1=("@method" "@target-uri" "content-digest");created=1',
    Signature: 'sig1=:signed-bytes:',
  };

  const withSession = attachMcpSessionHeader(signedHeaders, 'session-123');

  assert.strictEqual(withSession['Signature-Input'], signedHeaders['Signature-Input']);
  assert.strictEqual(withSession.Signature, signedHeaders.Signature);
  assert.strictEqual(withSession['Content-Digest'], signedHeaders['Content-Digest']);
  assert.strictEqual(withSession['Mcp-Session-Id'], 'session-123');
  assert.strictEqual(signedHeaders['Mcp-Session-Id'], undefined, 'the signed header object is not mutated');
});

test('initializeMcpSession is exported from the request-signing barrel', () => {
  const mod = require('../../dist/lib/testing/storyboard/request-signing/index.js');
  assert.strictEqual(typeof mod.initializeMcpSession, 'function');
});

test('empty MCP session sentinel leaves the signed header object unchanged', () => {
  const { attachMcpSessionHeader } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const signedHeaders = { Signature: 'sig1=:signed-bytes:' };
  assert.strictEqual(attachMcpSessionHeader(signedHeaders, ''), signedHeaders);
});
