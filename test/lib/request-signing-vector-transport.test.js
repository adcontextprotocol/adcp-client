const test = require('node:test');
const assert = require('node:assert');

const { resolveVectorTransport } = require('../../dist/lib/testing/storyboard/request-signing/probe-dispatch.js');

test("vector transport defaults to 'mcp' — the runner reaches agents via tools/call, so raw REST replay 404s on MCP agents by construction (adcp#6548)", () => {
  assert.strictEqual(resolveVectorTransport({}), 'mcp');
});

test("explicit 'raw' opt-in for REST-binding agents is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'raw' }), 'raw');
});

test("explicit 'mcp' setting is respected", () => {
  assert.strictEqual(resolveVectorTransport({ transport: 'mcp' }), 'mcp');
});
