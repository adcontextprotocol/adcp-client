const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { captureStdoutLogs, writeJsonOutput } = require('../../bin/adcp-json-stdout.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

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

async function collectSlowCliOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => (stderr += chunk));
  const slowConsumer = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      stdout += chunk.toString('utf8');
      setTimeout(callback, 10);
    },
  });
  child.stdout.pipe(slowConsumer);

  const exitCodePromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const outputFinished = new Promise((resolve, reject) => {
    slowConsumer.on('finish', resolve);
    slowConsumer.on('error', reject);
  });
  const [exitCode] = await Promise.all([exitCodePromise, outputFinished]);
  return { exitCode, stdout, stderr };
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
    process.stdout.write = (chunk, callback) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback?.();
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
    process.stdout.write = (chunk, callback) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback?.();
      return true;
    };
    writeJsonOutput(preformatted).finally(() => {
      process.stdout.write = original;
      resolve(chunks.join(''));
    });
  });
  assert.strictEqual(stdoutText, preformatted + '\n');
});

test('writeJsonOutput waits for the stream callback when write reports success', async () => {
  const original = process.stdout.write;
  let finishWrite;
  let settled = false;

  process.stdout.write = (_chunk, callback) => {
    finishWrite = callback;
    return true;
  };

  try {
    const writing = writeJsonOutput({ buffered: true }).then(() => {
      settled = true;
    });
    assert.strictEqual(settled, false, 'a true return value must not be treated as a completed write');
    finishWrite();
    await writing;
    assert.strictEqual(settled, true);
  } finally {
    process.stdout.write = original;
  }
});

test('CLI tools-list --json drains a large schema document before exiting', { timeout: 60_000 }, async t => {
  const largeDescription = 'schema-description-'.repeat(24_000);
  const createMcpServer = () => {
    const server = new McpServer({ name: 'large-schema-test', version: '1.0.0' });
    server.registerTool(
      'large_schema_tool',
      {
        description: 'Tool with a generated-size input schema',
        inputSchema: {
          payload: z.string().describe(largeDescription),
        },
      },
      async () => ({ content: [{ type: 'text', text: '{}' }] })
    );
    server.registerTool(
      'large_result_tool',
      {
        description: 'Tool with a generated-size result',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'completed', payload: largeDescription }) }],
      })
    );
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  });

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-json-'));
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  const listChild = spawn('node', [CLI, url, '--protocol', 'mcp', '--json', '--allow-http'], {
    env: { ...process.env, HOME: tempHome, ADCP_SKIP_VERSION_CHECK: '1' },
  });
  const listOutput = await collectSlowCliOutput(listChild);

  assert.strictEqual(listOutput.exitCode, 0, `CLI should exit successfully. stderr:\n${listOutput.stderr}`);
  assert.ok(
    Buffer.byteLength(listOutput.stdout) > 128 * 1024,
    'fixture must exceed the historical truncation boundary'
  );
  const listed = JSON.parse(listOutput.stdout);
  assert.strictEqual(listed.tools[0].name, 'large_schema_tool');
  assert.strictEqual(listed.tools[0].inputSchema.properties.payload.description, largeDescription);

  const resultChild = spawn(
    'node',
    [CLI, url, 'large_result_tool', '{}', '--protocol', 'mcp', '--json', '--allow-http'],
    {
      env: { ...process.env, HOME: tempHome, ADCP_SKIP_VERSION_CHECK: '1' },
    }
  );
  const resultOutput = await collectSlowCliOutput(resultChild);

  assert.strictEqual(resultOutput.exitCode, 0, `CLI should exit successfully. stderr:\n${resultOutput.stderr}`);
  assert.ok(
    Buffer.byteLength(resultOutput.stdout) > 128 * 1024,
    'result fixture must exceed the historical truncation boundary'
  );
  const result = JSON.parse(resultOutput.stdout);
  assert.strictEqual(result.data.payload, largeDescription);
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
