/**
 * Failed results keep the SDK authentication error class on `errorInstance`.
 *
 * `TaskExecutor.createErrorResult` used to keep only a signed-request rejection
 * and a validated `NeedsAuthorizationError`; a rejected static credential
 * (`AuthenticationCredentialsRejectedError`) and the unsigned A2A
 * `AuthenticationRequiredError` left `errorInstance` undefined. Multi-agent
 * collections likewise dropped a thrown `ADCPError` to a message string.
 */

const { describe, test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { AgentCollection } = require('../../dist/lib/core/ADCPMultiAgentClient.js');
const protocols = require('../../dist/lib/protocols/index.js');
const {
  AgentClient,
  AuthenticationRequiredError,
  AuthenticationCredentialsRejectedError,
  NeedsAuthorizationError,
  ADCPError,
} = require('../../dist/lib/index.js');

const BEARER = 'saved-static-token-do-not-leak';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

describe('MCP: rejected static bearer', () => {
  let server;
  let seen;
  let url;
  let issuer;

  before(async () => {
    seen = [];
    server = await listen((req, res) => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
        return;
      }
      if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ authorization_endpoint: `${origin}/oauth/authorize` }));
        return;
      }
      seen.push(req.headers.authorization);
      res.statusCode = 401;
      res.setHeader(
        'www-authenticate',
        `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
      );
      res.end(`rejected credential: ${BEARER}`);
    });
    const { port } = server.address();
    issuer = `http://127.0.0.1:${port}`;
    url = `${issuer}/mcp`;
  });

  after(async () => {
    await protocols.closeConnections('mcp');
    await close(server);
  });

  const agent = () => ({ id: 'mcp-static', name: 'static', agent_uri: url, protocol: 'mcp', auth_token: BEARER });

  test('TaskExecutor keeps AuthenticationCredentialsRejectedError, not NeedsAuthorizationError', async () => {
    const result = await new TaskExecutor().executeTask(agent(), 'get_products', { brief: 'test' });

    assert.equal(result.success, false);
    const err = result.errorInstance;
    assert.ok(err instanceof AuthenticationCredentialsRejectedError, `got ${err?.constructor.name}`);
    assert.ok(err instanceof AuthenticationRequiredError);
    assert.ok(!(err instanceof NeedsAuthorizationError));
    assert.ok(seen.includes(`Bearer ${BEARER}`), 'the configured bearer reached the seller');

    assert.equal(err.agentUrl, url);
    const descriptor = Object.getOwnPropertyDescriptor(err, 'cause');
    assert.ok(descriptor && descriptor.value !== undefined, 'cause is present');
    assert.equal(descriptor.enumerable, false);
    assert.doesNotMatch(JSON.stringify(err), new RegExp(BEARER));
    assert.doesNotMatch(err.message, new RegExp(BEARER));
  });

  test('the sanitized agent URL carries no query or fragment', async () => {
    const dirty = { ...agent(), agent_uri: `${url}?access_token=query-secret#frag` };
    const result = await new TaskExecutor().executeTask(dirty, 'get_products', { brief: 'test' });

    const err = result.errorInstance;
    assert.ok(err instanceof AuthenticationCredentialsRejectedError, `got ${err?.constructor.name}`);
    assert.equal(err.agentUrl, url);
    assert.doesNotMatch(JSON.stringify(err), /query-secret|access_token|frag/);
  });

  // Endpoint discovery runs before the task and throws instead of returning a failed
  // result, so the public client's class is pinned on the throw. Unaffected by this change.
  test('the public client throws the same class on a non-creative task', async () => {
    const client = new AgentClient(agent());
    await assert.rejects(
      client.syncAccounts({ accounts: [{ brand: { domain: 'example.com' }, operator: 'example.com' }] }),
      err => {
        assert.ok(err instanceof AuthenticationCredentialsRejectedError, `got ${err?.constructor.name}`);
        assert.ok(!(err instanceof NeedsAuthorizationError));
        assert.doesNotMatch(JSON.stringify(err), new RegExp(BEARER));
        return true;
      }
    );
  });
});

describe('A2A: unsigned 401 with no discoverable OAuth requirements', () => {
  let server;
  let url;

  before(async () => {
    server = await listen((req, res) => {
      const { port } = server.address();
      if (req.method === 'GET' && req.url.startsWith('/.well-known/agent')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            protocolVersion: '0.3.0',
            name: 'basic-a2a-stub',
            description: 'A2A stub behind Basic auth',
            url: `http://127.0.0.1:${port}/rpc`,
            preferredTransport: 'JSONRPC',
            version: '1.0.0',
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            capabilities: { streaming: false, pushNotifications: false },
            skills: [{ id: 'get_products', name: 'get_products', description: 'AdCP op', tags: ['adcp'] }],
          })
        );
        return;
      }
      req.resume();
      res.statusCode = 401;
      res.setHeader('www-authenticate', 'Basic realm="x"');
      res.end('unauthorized');
    });
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await protocols.closeConnections('a2a');
    await close(server);
  });

  test('TaskExecutor keeps AuthenticationRequiredError with the parsed challenge', async () => {
    const agent = { id: 'a2a-basic', name: 'basic', agent_uri: url, protocol: 'a2a' };
    const result = await new TaskExecutor({ strictSchemaValidation: false }).executeTask(agent, 'get_products', {
      buying_mode: 'wholesale',
    });

    assert.equal(result.success, false);
    const err = result.errorInstance;
    assert.ok(err instanceof AuthenticationRequiredError, `got ${err?.constructor.name}`);
    assert.ok(!(err instanceof NeedsAuthorizationError));
    assert.ok(!err.requestSigned, 'not a signed-request rejection');
    assert.equal(err.challenge?.scheme, 'basic');
    assert.equal(err.challenge?.params.realm, 'x');
  });
});

describe('NeedsAuthorizationError gate (passes before and after the change)', () => {
  const agentUrl = 'https://seller.example/mcp';
  const agent = { id: 'stubbed', name: 'stubbed', agent_uri: agentUrl, protocol: 'mcp' };
  const requirements = (overrides = {}) => ({
    agentUrl,
    resource: agentUrl,
    authorizationServers: ['https://issuer.example'],
    authorizationEndpoint: 'https://issuer.example/authorize',
    challenge: { scheme: 'bearer', params: {} },
    ...overrides,
  });

  let original;
  afterEach(() => {
    if (original) protocols.ProtocolClient.callTool = original;
    original = undefined;
  });

  function throwFromTransport(error) {
    original = protocols.ProtocolClient.callTool;
    protocols.ProtocolClient.callTool = async () => {
      throw error;
    };
  }

  test('a validated NeedsAuthorizationError is kept', async () => {
    const error = new NeedsAuthorizationError(requirements());
    throwFromTransport(error);
    const result = await new TaskExecutor().executeTask(agent, 'get_products', { brief: 'test' });
    assert.equal(result.success, false);
    assert.equal(result.errorInstance, error);
  });

  for (const [label, overrides] of [
    ['resource mismatch', { resource: 'https://other.example/mcp' }],
    ['no authorization servers', { authorizationServers: [] }],
    ['no resource', { resource: undefined }],
  ]) {
    test(`an unvalidated NeedsAuthorizationError (${label}) is not kept or demoted to AuthenticationRequiredError`, async () => {
      throwFromTransport(new NeedsAuthorizationError(requirements(overrides)));
      const result = await new TaskExecutor().executeTask(agent, 'get_products', { brief: 'test' });
      assert.equal(result.success, false);
      assert.equal(result.errorInstance, undefined);
    });
  }
});

describe('AgentCollection keeps a thrown ADCPError on errorInstance', () => {
  const configs = ['a', 'b', 'c', 'd'].map(id => ({
    id,
    name: id,
    agent_uri: `https://${id}.example.com`,
    protocol: 'mcp',
  }));
  const success = { success: true, status: 'completed', data: { products: [] }, metadata: {} };

  test('same instance for an ADCPError; undefined for Error and non-Error; fulfilled untouched', async () => {
    const collection = new AgentCollection(configs);
    const [a, b, c, d] = collection.getAllAgents();
    const authError = new AuthenticationRequiredError('https://a.example.com');
    a.getProducts = async () => {
      throw authError;
    };
    b.getProducts = async () => {
      throw new Error('boom');
    };
    c.getProducts = async () => {
      throw 'plain string';
    };
    d.getProducts = async () => success;

    const results = await collection.getProducts({ brief: 'x' });

    assert.equal(results[0].success, false);
    assert.equal(results[0].errorInstance, authError);
    assert.ok(results[0].errorInstance instanceof ADCPError);
    assert.equal(results[0].error, authError.message);

    assert.equal(results[1].success, false);
    assert.equal(results[1].error, 'boom');
    assert.equal(results[1].errorInstance, undefined);
    assert.ok(!('errorInstance' in results[1]));

    assert.equal(results[2].success, false);
    assert.equal(results[2].error, 'plain string');
    assert.equal(results[2].errorInstance, undefined);

    assert.equal(results[3], success);
    assert.ok(!('errorInstance' in results[3]));
  });

  const needsAuthorization = (agentUrl, resource) =>
    new NeedsAuthorizationError({
      agentUrl,
      resource,
      authorizationServers: ['https://issuer.example'],
      challenge: { scheme: 'bearer', params: {} },
    });

  test('an unvalidated NeedsAuthorizationError is not kept; error keeps the message', async () => {
    const collection = new AgentCollection([configs[0]]);
    const [a] = collection.getAllAgents();
    const unvalidated = needsAuthorization(configs[0].agent_uri, 'https://other.example.com');
    a.getProducts = async () => {
      throw unvalidated;
    };

    const [result] = await collection.getProducts({ brief: 'x' });

    assert.equal(result.success, false);
    assert.equal(result.error, unvalidated.message);
    assert.ok(!('errorInstance' in result));
  });

  test('a validated NeedsAuthorizationError is kept', async () => {
    const collection = new AgentCollection([configs[0]]);
    const [a] = collection.getAllAgents();
    const validated = needsAuthorization(configs[0].agent_uri, configs[0].agent_uri);
    a.getProducts = async () => {
      throw validated;
    };

    const [result] = await collection.getProducts({ brief: 'x' });

    assert.equal(result.success, false);
    assert.equal(result.errorInstance, validated);
  });
});
