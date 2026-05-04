/**
 * The CLI captures stray `console.log` writes when --json is set so that
 * the JSON payload on stdout stays parseable. The end-of-run storyboard
 * summary writes to stderr (process.stderr.write) and must pass through
 * untouched — otherwise `STORYBOARD-FAIL` markers vanish in --json mode
 * and CI authors lose the visibility the always-on summary depends on.
 *
 * Pin the behavior here so a future refactor of bin/adcp-json-stdout.js
 * surfaces the regression as a failing test, not a silent CI drift.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { captureStdoutLogs } = require('../../bin/adcp-json-stdout.js');

describe('captureStdoutLogs', () => {
  test('redirects console.log/info but leaves process.stderr.write alone', () => {
    const stderrChunks = [];
    const stdoutChunks = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stderr.write = chunk => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    process.stdout.write = chunk => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };

    const restore = captureStdoutLogs();
    try {
      console.log('would-corrupt-json');
      console.info('also-corrupts');
      process.stderr.write('STORYBOARD-FAIL summary stays visible\n');
    } finally {
      restore();
      process.stderr.write = origStderrWrite;
      process.stdout.write = origStdoutWrite;
    }

    const stderr = stderrChunks.join('');
    const stdout = stdoutChunks.join('');

    assert.match(stderr, /STORYBOARD-FAIL summary stays visible/, 'process.stderr.write must pass through');
    assert.match(stderr, /would-corrupt-json/, 'console.log must be redirected to stderr');
    assert.match(stderr, /also-corrupts/, 'console.info must be redirected to stderr');
    assert.strictEqual(stdout, '', 'stdout must stay clean while capture is active');
  });
});
