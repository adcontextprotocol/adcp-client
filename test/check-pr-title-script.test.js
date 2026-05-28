const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.resolve(__dirname, '..', '.github', 'scripts', 'check-pr-title.cjs');

function runCheck(args = [], env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  });
}

test('check-pr-title allows conventional commit titles', () => {
  const result = runCheck(['fix(ci): block agent PR title prefixes']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('check-pr-title rejects leading bracketed agent prefixes', () => {
  for (const title of ['[codex] fix: test', '[Claude-Code]: fix: test', '[cursor]-fix: test', '[AI]']) {
    const result = runCheck([title]);

    assert.equal(result.status, 1, title);
    assert.match(result.stderr, /Remove the leading agent\/tool prefix/);
  }
});

test('check-pr-title reads PR_TITLE when no title args are provided', () => {
  const result = runCheck([], { PR_TITLE: '[claude] fix: test' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid PR title: \[claude\] fix: test/);
});

test('check-pr-title allows agent names outside the leading ownership prefix', () => {
  const result = runCheck(['fix(ci): document [codex] rejection']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});
