// The legacy `Agent` class emits a one-time `DeprecationWarning` at construction
// (Stage 3 — Agent does not honor per-instance adcpVersion pins). The flag that
// gates the warning is module-scoped, so each assertion runs in its own
// child_process to get fresh module state.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function runIsolated(script) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, NODE_NO_WARNINGS: undefined }, // ensure warnings surface
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('Agent class deprecation warning', () => {
  test('first construction emits exactly one DeprecationWarning', () => {
    const script = `
      const warnings = [];
      process.on('warning', w => {
        if (w.name === 'DeprecationWarning' && /Agent class is deprecated/.test(w.message)) {
          warnings.push(w.message);
        }
      });
      const { Agent } = require('./dist/lib');
      new Agent({ id: 'a', name: 'a', agent_uri: 'https://x', protocol: 'mcp' }, null);
      new Agent({ id: 'b', name: 'b', agent_uri: 'https://x', protocol: 'mcp' }, null);
      new Agent({ id: 'c', name: 'c', agent_uri: 'https://x', protocol: 'mcp' }, null);
      // 'warning' is emitted async; wait one tick before reporting.
      setImmediate(() => {
        console.log(JSON.stringify({ count: warnings.length }));
      });
    `;
    const { stdout, status } = runIsolated(script);
    assert.strictEqual(status, 0, `script exited non-zero. stdout=${stdout}`);
    const { count } = JSON.parse(stdout.trim());
    assert.strictEqual(count, 1, 'exactly one warning across three constructions');
  });

  test('retries when emitWarning throws (flag set only after success)', () => {
    // Monkey-patch process.emitWarning to throw on the first call. The flag
    // ordering fix means a thrown emit leaves the flag false, so the next
    // construction tries again. Without the fix, the flag would already be
    // true and the deprecation would be silently lost forever.
    const script = `
      let calls = 0;
      const original = process.emitWarning;
      process.emitWarning = function () {
        calls++;
        if (calls === 1) throw new Error('synthetic emit failure');
        return original.apply(this, arguments);
      };
      const { Agent } = require('./dist/lib');
      new Agent({ id: 'a', name: 'a', agent_uri: 'https://x', protocol: 'mcp' }, null);
      new Agent({ id: 'b', name: 'b', agent_uri: 'https://x', protocol: 'mcp' }, null);
      console.log(JSON.stringify({ calls }));
    `;
    const { stdout, status } = runIsolated(script);
    assert.strictEqual(status, 0, `script exited non-zero. stdout=${stdout}`);
    const { calls } = JSON.parse(stdout.trim());
    assert.strictEqual(calls, 2, 'second construction retries after first throw');
  });
});
