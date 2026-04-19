const { test } = require('node:test');
const assert = require('node:assert');
const { captureStdoutLogs, writeJsonOutput } = require('../../bin/adcp-json-stdout.js');

function withWritePatch(stream, fn) {
  const original = stream.write;
  const captured = [];
  stream.write = chunk => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn(captured);
  } finally {
    stream.write = original;
  }
  return captured.join('');
}

test('captureStdoutLogs forwards console.log to stderr', () => {
  const stdoutText = withWritePatch(process.stdout, () => {
    const stderrText = withWritePatch(process.stderr, () => {
      const restore = captureStdoutLogs();
      console.log('hello from log');
      console.info('hello from info');
      restore();
    });
    assert.ok(stderrText.includes('hello from log'), `stderr should have log message, got: ${stderrText}`);
    assert.ok(stderrText.includes('hello from info'), `stderr should have info message, got: ${stderrText}`);
  });
  assert.strictEqual(stdoutText, '', `stdout should be empty, got: ${JSON.stringify(stdoutText)}`);
});

test('captureStdoutLogs restores original console methods', () => {
  const origLog = console.log;
  const origInfo = console.info;
  const restore = captureStdoutLogs();
  assert.notStrictEqual(console.log, origLog);
  assert.notStrictEqual(console.info, origInfo);
  restore();
  assert.strictEqual(console.log, origLog);
  assert.strictEqual(console.info, origInfo);
});

test('writeJsonOutput writes stringified JSON plus newline to stdout', async () => {
  const stdoutText = await new Promise(resolve => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = chunk => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    writeJsonOutput({ a: 1, b: 'x' }).finally(() => {
      process.stdout.write = original;
      resolve(chunks.join(''));
    });
  });
  assert.ok(stdoutText.endsWith('\n'), 'output should end with newline');
  const parsed = JSON.parse(stdoutText);
  assert.deepStrictEqual(parsed, { a: 1, b: 'x' });
});

test('writeJsonOutput passes strings through unchanged (already formatted)', async () => {
  const preformatted = '{\n  "already": "stringified"\n}';
  const stdoutText = await new Promise(resolve => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = chunk => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    };
    writeJsonOutput(preformatted).finally(() => {
      process.stdout.write = original;
      resolve(chunks.join(''));
    });
  });
  assert.strictEqual(stdoutText, preformatted + '\n');
});

test('stdout stays clean when libraries log during a captured region', () => {
  const stdoutText = withWritePatch(process.stdout, () => {
    withWritePatch(process.stderr, () => {
      const restore = captureStdoutLogs();
      // Simulate a library that logs progress to stdout while the CLI is
      // about to emit its JSON result — the exact pattern #588 reports.
      console.log('[lib] progress: step 1 of 10');
      console.info('some info line');
      restore();
    });
  });
  assert.strictEqual(stdoutText, '', 'stdout must be empty under capture');
});

test('callers must restore on throw via try/finally to avoid permanent patch', () => {
  // The helper itself is intentionally minimal — callers are responsible for
  // restore. Document that contract: a thrown exception inside the captured
  // region leaves the patch active until restore() runs, so every call site
  // must use try/finally.
  const origLog = console.log;
  const restore = captureStdoutLogs();
  try {
    assert.notStrictEqual(console.log, origLog, 'patch is active inside region');
    throw new Error('simulated runStoryboard failure');
  } catch (err) {
    assert.strictEqual(err.message, 'simulated runStoryboard failure');
  } finally {
    restore();
  }
  assert.strictEqual(console.log, origLog, 'restore() returns console.log to original after throw');
});
