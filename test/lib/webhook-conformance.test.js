const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { runWebhookConformance } = require('../../dist/lib/conformance');

test('runWebhookConformance classifies buyer receiver envelope cases', async () => {
  const seenIdempotencyKeys = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const required = ['idempotency_key', 'operation_id', 'task_id', 'task_type', 'status', 'timestamp'];
    const validStatus = [
      'submitted',
      'working',
      'input-required',
      'completed',
      'canceled',
      'failed',
      'rejected',
      'auth-required',
      'unknown',
    ];
    const isValidEnvelope =
      required.every(field => typeof body[field] === 'string' && body[field].length > 0) &&
      validStatus.includes(body.status) &&
      body.result &&
      typeof body.result === 'object';

    if (!isValidEnvelope) {
      res.writeHead(400).end('bad envelope');
      return;
    }

    seenIdempotencyKeys.push(body.idempotency_key);
    res.writeHead(202).end('accepted');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const report = await runWebhookConformance(`http://127.0.0.1:${port}/webhooks/adcp`, {
      signing: { mode: 'none' },
    });

    assert.strictEqual(report.totalFailures, 0);
    assert.strictEqual(report.totalCases, 5);
    assert.deepStrictEqual(seenIdempotencyKeys.slice(0, 2), [
      'whk_conformance_retry_000001',
      'whk_conformance_retry_000001',
    ]);
    assert.ok(report.cases.some(c => c.name === 'reject_bare_delivery_result' && c.verdict === 'rejected_correctly'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
