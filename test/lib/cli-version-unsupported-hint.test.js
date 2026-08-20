const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILT_IN_VERSION_HINT,
  appendBuiltInVersionUnsupportedHint,
} = require('../../bin/adcp-version-unsupported-hint.js');

const builtIns = { 'test-mcp': { url: 'https://test.example/mcp/' } };

test('built-in agent VERSION_UNSUPPORTED results include an actionable deployment hint', () => {
  const result = {
    overall_status: 'unreachable',
    summary: { headline: 'Agent unreachable — VERSION_UNSUPPORTED: requested "3.2-beta.3"' },
  };

  const hinted = appendBuiltInVersionUnsupportedHint(result, 'test-mcp', builtIns);
  assert.match(hinted.summary.headline, /VERSION_UNSUPPORTED/);
  assert.match(hinted.summary.headline, new RegExp(BUILT_IN_VERSION_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.notStrictEqual(hinted, result);
});

test('version hints are limited to built-in aliases and version failures', () => {
  const versionFailure = {
    summary: { headline: 'Agent unreachable — VERSION_UNSUPPORTED: requested "3.2-beta.3"' },
  };
  const networkFailure = { summary: { headline: 'Agent unreachable — connection refused' } };

  assert.strictEqual(
    appendBuiltInVersionUnsupportedHint(versionFailure, 'https://local.example/mcp', builtIns),
    versionFailure
  );
  assert.strictEqual(appendBuiltInVersionUnsupportedHint(networkFailure, 'test-mcp', builtIns), networkFailure);
});
