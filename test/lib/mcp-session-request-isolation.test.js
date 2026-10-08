const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');

const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');
const { callMCPToolWithOAuth, closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { withMCPConnectionScope } = require('../../dist/lib/client/index.js');
const { withTransportDiagnostics } = require('../../dist/lib/protocols/index.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const mode of ['static', 'oauth']) {
  test(`concurrent ${mode} MCP calls retain their own headers and cancellation on one scoped session`, async t => {
    const slowReceived = deferred();
    const abortReceived = deferred();
    const abortHeaders = deferred();
    const releaseSlow = deferred();
    const abortClosed = deferred();
    const timeoutClosed = deferred();
    const calls = [];
    const events = [];
    let initializes = 0;
    let deletes = 0;
    let resumptions = 0;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') {
        deletes++;
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET' && req.headers['last-event-id']) resumptions++;
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === 'initialize') {
        initializes++;
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'request-isolation', version: '1.0.0' },
        };
      } else if (message.method === 'tools/list') {
        result = { tools: [] };
      } else if (message.method === 'tools/call') {
        calls.push({ name: message.params.name, headers: { ...req.headers } });
        if (message.params.name === 'slow') {
          slowReceived.resolve();
          await releaseSlow.promise;
        }
        if (message.params.name === 'abort' || message.params.name === 'timeout') {
          res.once('close', () => (message.params.name === 'abort' ? abortClosed : timeoutClosed).resolve());
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
          res.write(
            'id: first-event\ndata: ' +
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: 'unused', progress: 1 },
              }) +
              '\n\n'
          );
          abortReceived.resolve();
          return;
        }
        result = { content: [{ type: 'text', text: message.params.name }] };
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'shared-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    t.after(async () => {
      releaseSlow.resolve();
      await closeMCPConnections();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });

    const traceparent = number => `00-${String(number).padStart(32, '0')}-${String(number).padStart(16, '0')}-01`;
    const provider = {
      redirectUrl: undefined,
      clientMetadata: { client_name: 'request-isolation', redirect_uris: [] },
      async clientInformation() {
        return { client_id: 'request-isolation' };
      },
      async tokens() {
        return { access_token: 'same-auth-token', token_type: 'Bearer' };
      },
      async saveTokens() {},
      async redirectToAuthorization() {
        throw new Error('Unexpected authorization flow');
      },
      async saveCodeVerifier() {},
      async codeVerifier() {
        return 'verifier';
      },
    };
    const call = (name, timeout, controller) => {
      const headers = {
        'x-request-id': name,
        traceparent: traceparent({ warm: 1, slow: 2, abort: 3, after: 4, timeout: 5 }[name]),
      };
      if (mode === 'oauth')
        return callMCPToolWithOAuth({
          agentUrl: url,
          toolName: name,
          args: {},
          authProvider: provider,
          customHeaders: headers,
          signal: controller.signal,
          requestTimeoutMs: timeout,
          allowPrivateIp: true,
        });
      return callMCPToolWithTasks(url, name, {}, 'same-auth-token', [], headers, {
        signal: controller.signal,
        requestTimeoutMs: timeout,
        allowPrivateIp: true,
      });
    };
    const expectDisconnect = promise =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Cancelled POST remained open')), 1000);
          timer.unref();
          promise.finally(() => clearTimeout(timer));
        }),
      ]);
    let deletesAfterWarm;
    await withTransportDiagnostics(
      {
        agentId: 'seller',
        protocol: 'mcp',
        onTransportActivity(event) {
          events.push(event);
          if (
            event.type === 'response_received' &&
            event.streaming &&
            JSON.parse(event.requestBody ?? '{}').params?.name === 'abort'
          ) {
            abortHeaders.resolve();
          }
        },
      },
      () =>
        withMCPConnectionScope(async () => {
          await call('warm', 1000, new AbortController());
          // The Tasks compatibility route may perform a cold v2-to-v1 handshake.
          // After negotiation, all requests must use the same live session.
          const initializesAfterWarm = initializes;
          deletesAfterWarm = deletes;
          const slow = call('slow', 4000, new AbortController());
          await slowReceived.promise;
          const controller = new AbortController();
          const aborted = call('abort', 1500, controller);
          const abortAssertion = assert.rejects(aborted, /abort/i);
          await abortReceived.promise;
          await abortHeaders.promise; // Wait until the client has observed headers, not merely the server write.
          controller.abort();
          await abortAssertion;
          await expectDisconnect(abortClosed.promise);
          await assert.rejects(call('timeout', 200, new AbortController()), /timeout|timed out/i);
          await expectDisconnect(timeoutClosed.promise);
          // A longer call must outlive the timeout used to create the connection.
          await new Promise(resolve => setTimeout(resolve, 1100));
          releaseSlow.resolve();
          assert.equal((await slow).content[0].text, 'slow');
          assert.equal((await call('after', 1000, new AbortController())).content[0].text, 'after');
          assert.equal(initializes, initializesAfterWarm);
          assert.equal(deletes, deletesAfterWarm, 'aborting one request must leave the shared session alive');
          for (const call of calls) {
            assert.equal(call.headers['x-request-id'], call.name);
            assert.equal(
              call.headers.traceparent,
              traceparent({ warm: 1, slow: 2, abort: 3, after: 4, timeout: 5 }[call.name])
            );
            assert.equal(call.headers.authorization, 'Bearer same-auth-token');
            assert.equal(call.headers['mcp-session-id'], 'shared-session');
          }
        })
    );
    await new Promise(resolve => setImmediate(resolve));
    const completions = events.filter(event => event.type === 'response_completed' && event.outcome === 'aborted');
    assert.equal(
      completions.length,
      2,
      `both caller abort and SDK timeout report stream termination; outcomes: ${events
        .filter(event => event.type === 'response_completed')
        .map(event => event.outcome)
        .join(', ')}`
    );
    for (const event of completions) {
      const headers = events.find(
        item => item.type === 'response_received' && item.transportRequestId === event.transportRequestId
      );
      assert.equal(headers.streaming, true);
      assert.ok(events.indexOf(headers) < events.indexOf(event));
    }
    assert.equal(deletes, deletesAfterWarm + 1, 'scope exit terminates the session once');
    assert.equal(resumptions, 0, 'aborted call streams must not reconnect with Last-Event-ID');
  });
}
