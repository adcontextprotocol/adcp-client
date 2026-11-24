/**
 * End to end: an unsigned A2A 401 plus RFC 8414 metadata with extra seller
 * fields surfaces an AuthenticationRequiredError carrying only the declared
 * OAuthMetadataInfo / AuthChallengeInfo fields, thrown and in a task result.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ProtocolClient, closeConnections } = require('../../dist/lib/protocols/index.js');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor');
const { AuthenticationRequiredError } = require('../../dist/lib/errors');

const LEAK = 'seller-extra-value-do-not-leak';
let server;
let agent;

before(async () => {
  server = http.createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: [LEAK],
          'x-vendor-extension': LEAK,
        })
      );
      return;
    }
    res.writeHead(401, {
      'www-authenticate': `Bearer realm="api", scope="adcp", vendor_param="${LEAK}", resource_metadata="${origin}/${LEAK}"`,
    });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  agent = {
    id: 'a2a-401-agent',
    name: 'A2A 401 agent',
    agent_uri: `http://127.0.0.1:${server.address().port}/a2a`,
    protocol: 'a2a',
  };
});

beforeEach(() => closeConnections('a2a'));

after(async () => {
  await closeConnections('a2a');
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

function assertDeclaredFieldsOnly(err) {
  assert.ok(err instanceof AuthenticationRequiredError);
  assert.strictEqual(err.challenge.scheme, 'bearer');
  assert.strictEqual(err.challenge.realm, 'api');
  assert.strictEqual(err.challenge.scope, 'adcp');
  assert.deepStrictEqual(Object.keys(err.challenge).sort(), ['realm', 'scheme', 'scope']);
  assert.deepStrictEqual(Object.keys(err.oauthMetadata).sort(), ['authorization_endpoint', 'issuer', 'token_endpoint']);
  assert.match(err.oauthMetadata.authorization_endpoint, /\/authorize$/);
}

test('ProtocolClient.callTool throws an error with only declared auth fields', async () => {
  await assert.rejects(ProtocolClient.callTool(agent, 'get_products', { buying_mode: 'wholesale' }), err => {
    assertDeclaredFieldsOnly(err);
    assert.doesNotMatch(JSON.stringify(err), new RegExp(LEAK));
    assert.doesNotMatch(err.message, new RegExp(LEAK));
    return true;
  });
});

test('TaskExecutor failed result serializes none of the extra seller fields', async () => {
  const executor = new TaskExecutor({ strictSchemaValidation: false });
  const result = await executor.executeTask(agent, 'get_products', { buying_mode: 'wholesale' });
  assert.strictEqual(result.success, false);
  assert.match(result.error, /Authentication required/);
  if (result.errorInstance) assertDeclaredFieldsOnly(result.errorInstance);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(LEAK));
});
