// Regression tests for adcp-client#3689: the projected `adcpError` and the
// failed result's `data` must keep the seller's `mutation_outcome`, on returned
// failures and on thrown transport errors alike. A buyer that cannot read it must
// treat every failed mutation as unknown.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { extractAdcpErrorInfo, extractAdcpErrorFromMcp } = require('../../dist/lib/utils/error-extraction.js');
const { TaskExecutor, ProtocolClient, ADCPMultiAgentClient, AgentClient } = require('../../dist/lib/index.js');
const { callA2ATool, closeA2AConnections } = require('../../dist/lib/protocols/a2a.js');

function validationErrorBody(outcome) {
  const entry = { code: 'VALIDATION_ERROR', message: 'targeting rejected', recovery: 'correctable' };
  return {
    adcp_error: { ...entry, ...(outcome && { mutation_outcome: outcome }) },
    errors: [{ ...entry, ...(outcome && { mutation_outcome: outcome }) }],
  };
}

describe('extractAdcpErrorInfo — mutation_outcome (#3689)', () => {
  test("carries the issue's body: adcp_error + errors[] both 'unknown'", () => {
    const info = extractAdcpErrorInfo(validationErrorBody('unknown'));
    assert.strictEqual(info.code, 'VALIDATION_ERROR');
    assert.strictEqual(info.mutation_outcome, 'unknown');
  });

  for (const outcome of ['applied', 'not_applied', 'unknown']) {
    test(`accepts '${outcome}' on adcp_error`, () => {
      const info = extractAdcpErrorInfo({ adcp_error: { code: 'X', message: 'm', mutation_outcome: outcome } });
      assert.strictEqual(info.mutation_outcome, outcome);
    });
  }

  test('falls back to errors[0] when adcp_error has no outcome', () => {
    const info = extractAdcpErrorInfo({
      adcp_error: { code: 'VALIDATION_ERROR', message: 'm' },
      errors: [{ code: 'VALIDATION_ERROR', message: 'm', mutation_outcome: 'applied' }],
    });
    assert.strictEqual(info.mutation_outcome, 'applied');
  });

  test('adcp_error outcome wins over errors[0]', () => {
    const info = extractAdcpErrorInfo({
      adcp_error: { code: 'X', message: 'm', mutation_outcome: 'not_applied' },
      errors: [{ code: 'X', message: 'm', mutation_outcome: 'applied' }],
    });
    assert.strictEqual(info.mutation_outcome, 'not_applied');
  });

  test('reads errors[0] on a legacy errors[]-only body', () => {
    const info = extractAdcpErrorInfo({ errors: [{ code: 'X', message: 'm', mutation_outcome: 'not_applied' }] });
    assert.strictEqual(info.code, 'X');
    assert.strictEqual(info.mutation_outcome, 'not_applied');
  });

  test('drops an invalid value', () => {
    const info = extractAdcpErrorInfo({ adcp_error: { code: 'X', message: 'm', mutation_outcome: 'maybe' } });
    assert.ok(info);
    assert.ok(!('mutation_outcome' in info));
    const legacy = extractAdcpErrorInfo({ errors: [{ code: 'X', message: 'm', mutation_outcome: 7 }] });
    assert.ok(!('mutation_outcome' in legacy));
  });

  test('absent means no field', () => {
    const info = extractAdcpErrorInfo(validationErrorBody(undefined));
    assert.ok(!('mutation_outcome' in info));
  });
});

describe('extractAdcpErrorFromMcp — mutation_outcome (#3689)', () => {
  test('structuredContent adcp_error carries the outcome', () => {
    const extracted = extractAdcpErrorFromMcp({
      isError: true,
      structuredContent: validationErrorBody('unknown'),
      content: [{ type: 'text', text: 'targeting rejected' }],
    });
    assert.ok(extracted);
    assert.strictEqual(extracted.mutation_outcome, 'unknown');
  });

  test('text JSON adcp_error carries the outcome', () => {
    const extracted = extractAdcpErrorFromMcp({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(validationErrorBody('applied')) }],
    });
    assert.ok(extracted);
    assert.strictEqual(extracted.mutation_outcome, 'applied');
  });

  test('invalid value is dropped; absent has no field', () => {
    const bad = extractAdcpErrorFromMcp({
      isError: true,
      structuredContent: { adcp_error: { code: 'X', message: 'm', mutation_outcome: 'nope' } },
    });
    assert.ok(bad);
    assert.ok(!('mutation_outcome' in bad));
    const none = extractAdcpErrorFromMcp({
      isError: true,
      structuredContent: validationErrorBody(undefined),
    });
    assert.ok(none);
    assert.ok(!('mutation_outcome' in none));
  });
});

describe('TaskExecutor — failures keep mutation_outcome (#3689)', () => {
  const mcpAgent = { id: 'seller-mcp', name: 'Seller', agent_uri: 'https://seller.test/mcp', protocol: 'mcp' };
  let originalCallTool;

  beforeEach(() => {
    originalCallTool = ProtocolClient.callTool;
  });
  afterEach(() => {
    ProtocolClient.callTool = originalCallTool;
  });

  test('returned failed MCP structuredContent projects mutation_outcome and keeps the body', async () => {
    const body = validationErrorBody('unknown');
    ProtocolClient.callTool = mock.fn(async () => ({
      isError: true,
      structuredContent: body,
      content: [{ type: 'text', text: 'targeting rejected' }],
    }));
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.adcpError?.code, 'VALIDATION_ERROR');
    assert.strictEqual(result.adcpError?.mutation_outcome, 'unknown');
    assert.strictEqual(result.data?.adcp_error?.mutation_outcome, 'unknown');
  });

  test('thrown error carrying data.adcp_error: result.data and adcpError keep the outcome (rollback scenario)', async () => {
    const body = validationErrorBody('unknown');
    ProtocolClient.callTool = mock.fn(async () => {
      const err = new Error('A2A agent returned error: targeting rejected');
      err.data = body;
      throw err;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'A2A agent returned error: targeting rejected');
    assert.strictEqual(result.adcpError?.code, 'VALIDATION_ERROR');
    assert.strictEqual(result.adcpError?.mutation_outcome, 'unknown');
    assert.deepStrictEqual(result.data, body);
    assert.strictEqual(result.data.adcp_error.mutation_outcome, 'unknown');
  });

  test('body on error.response.data is kept too', async () => {
    const body = validationErrorBody('applied');
    ProtocolClient.callTool = mock.fn(async () => {
      const err = new Error('boom');
      err.response = { data: body };
      throw err;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });
    assert.strictEqual(result.adcpError?.mutation_outcome, 'applied');
    assert.deepStrictEqual(result.data, body);
  });

  test('errors[]-only thrown body is kept', async () => {
    const body = { errors: [{ code: 'X', message: 'm', mutation_outcome: 'not_applied' }] };
    ProtocolClient.callTool = mock.fn(async () => {
      const err = new Error('boom');
      err.data = body;
      throw err;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });
    assert.strictEqual(result.adcpError?.mutation_outcome, 'not_applied');
    assert.deepStrictEqual(result.data, body);
  });

  test('thrown error without a structured body has no data and no outcome', async () => {
    ProtocolClient.callTool = mock.fn(async () => {
      throw new Error('socket hang up');
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'socket hang up');
    assert.ok(!('data' in result) || result.data === undefined);
    assert.ok(!result.adcpError?.mutation_outcome);
  });

  test('thrown error with unrelated object data is not promoted to result.data', async () => {
    ProtocolClient.callTool = mock.fn(async () => {
      const err = new Error('boom');
      err.data = { retry_after: 5 };
      throw err;
    });
    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(mcpAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });
    assert.ok(!('data' in result) || result.data === undefined);
  });
});

describe('A2A JSON-RPC error — structured data survives (#3689)', () => {
  const a2aAgent = { id: 'seller-a2a', name: 'Seller', agent_uri: 'https://seller.test/a2a', protocol: 'a2a' };
  let originalFromCardUrl;
  let a2aShim;
  let respond;

  beforeEach(() => {
    closeA2AConnections();
    const stubClient = {
      getAgentCard: async () => ({ skills: [{ id: 'get_adcp_capabilities', name: 'get_adcp_capabilities' }] }),
      sendMessage: async payload => {
        if (payload.message.parts.some(part => part.content?.value?.skill === 'get_adcp_capabilities')) {
          return {
            jsonrpc: '2.0',
            id: 'caps',
            result: {
              kind: 'task',
              id: 'caps-task',
              contextId: 'caps-ctx',
              status: { state: 'completed', timestamp: new Date().toISOString() },
              artifacts: [
                {
                  artifactId: 'caps-art',
                  parts: [
                    {
                      kind: 'data',
                      data: {
                        status: 'completed',
                        adcp_version: '3.2',
                        adcp: { major_versions: [3], idempotency: { supported: false } },
                        supported_protocols: ['media_buy'],
                      },
                    },
                  ],
                },
              ],
            },
          };
        }
        return respond();
      },
    };
    a2aShim = require('../../dist/lib/protocols/a2a').legacyA2AClientTestShim;
    originalFromCardUrl = a2aShim.fromCardUrl;
    a2aShim.fromCardUrl = async () => stubClient;
  });

  afterEach(() => {
    a2aShim.fromCardUrl = originalFromCardUrl;
    closeA2AConnections();
  });

  const rpcError = data => ({
    jsonrpc: '2.0',
    id: 'rpc-1',
    error: { code: -32001, message: 'targeting rejected', ...(data !== undefined && { data }) },
  });

  test("thrown error carries the error's object data; JSON-RPC code is not attached", async () => {
    const body = validationErrorBody('applied');
    respond = async () => rpcError(body);

    await assert.rejects(
      () => callA2ATool(a2aAgent.agent_uri, 'update_media_buy', { media_buy_id: 'mb_1' }),
      err => {
        assert.match(err.message, /A2A agent returned error: targeting rejected/);
        assert.deepStrictEqual(err.data, body);
        assert.ok(!('code' in err), 'JSON-RPC -32001 must not read as a timeout');
        return true;
      }
    );
  });

  test('non-object error data is not attached', async () => {
    respond = async () => rpcError('just a string');
    await assert.rejects(
      () => callA2ATool(a2aAgent.agent_uri, 'update_media_buy', { media_buy_id: 'mb_1' }),
      err => {
        assert.ok(!('data' in err));
        return true;
      }
    );
  });

  test('through TaskExecutor: adcpError.mutation_outcome is applied and result.data holds the body', async () => {
    const body = validationErrorBody('applied');
    respond = async () => rpcError(body);

    const executor = new TaskExecutor({ strictSchemaValidation: false });
    const result = await executor.executeTask(a2aAgent, 'update_media_buy', {
      media_buy_id: 'mb_1',
      idempotency_key: 'idem-1234567890123456',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /targeting rejected/);
    assert.strictEqual(result.adcpError?.mutation_outcome, 'applied');
    assert.deepStrictEqual(result.data, body);
  });
});

describe('ADCPMultiAgentClient fan-out — rejected operations keep the seller body (#3689)', () => {
  const agents = [
    { id: 'a1', name: 'A1', agent_uri: 'https://a1.test/mcp', protocol: 'mcp' },
    { id: 'a2', name: 'A2', agent_uri: 'https://a2.test/mcp', protocol: 'mcp' },
  ];
  let originalGetProducts;
  let originalCreateMediaBuy;

  beforeEach(() => {
    originalGetProducts = AgentClient.prototype.getProducts;
    originalCreateMediaBuy = AgentClient.prototype.createMediaBuy;
  });
  afterEach(() => {
    AgentClient.prototype.getProducts = originalGetProducts;
    AgentClient.prototype.createMediaBuy = originalCreateMediaBuy;
  });

  test('a rejection whose reason carries a seller body gets data and adcpError; others stay plain', async () => {
    const body = validationErrorBody('unknown');
    AgentClient.prototype.getProducts = async function () {
      if (this.getAgentId() === 'a1') {
        const err = new Error('seller refused');
        err.data = body;
        throw err;
      }
      throw new Error('socket hang up');
    };

    const results = await new ADCPMultiAgentClient(agents).allAgents().getProducts({ brief: 'x' });
    assert.strictEqual(results.length, 2);

    const [withBody, plain] = results;
    assert.strictEqual(withBody.success, false);
    assert.strictEqual(withBody.status, 'failed');
    assert.strictEqual(withBody.error, 'seller refused');
    assert.strictEqual(withBody.adcpError?.code, 'VALIDATION_ERROR');
    assert.strictEqual(withBody.adcpError?.mutation_outcome, 'unknown');
    assert.deepStrictEqual(withBody.data, body);

    assert.strictEqual(plain.success, false);
    assert.strictEqual(plain.error, 'socket hang up');
    assert.ok(plain.adcpError === undefined);
    assert.ok(!('data' in plain) || plain.data === undefined);
  });

  test('createMediaBuy rejection with body on response.data keeps mutation_outcome', async () => {
    const body = validationErrorBody('applied');
    AgentClient.prototype.createMediaBuy = async function () {
      const err = new Error('boom');
      err.response = { data: body };
      throw err;
    };

    const [result] = await new ADCPMultiAgentClient([agents[0]]).allAgents().createMediaBuy({});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.adcpError?.mutation_outcome, 'applied');
    assert.deepStrictEqual(result.data, body);
  });
});

describe('malformed errors[] does not sink the fan-out (#3689)', () => {
  test('extractAdcpErrorInfo ignores non-object errors[] entries without throwing', () => {
    assert.strictEqual(extractAdcpErrorInfo({ errors: [null] }), undefined);
    assert.strictEqual(extractAdcpErrorInfo({ errors: ['x'] }), undefined);
  });

  test('one agent rejecting with errors:[null] leaves the healthy agent result intact', async () => {
    const agents = [
      { id: 'bad', name: 'Bad', agent_uri: 'https://bad.test/mcp', protocol: 'mcp' },
      { id: 'good', name: 'Good', agent_uri: 'https://good.test/mcp', protocol: 'mcp' },
    ];
    const original = AgentClient.prototype.getProducts;
    const healthy = { success: true, status: 'completed', data: { products: [] }, metadata: {} };
    AgentClient.prototype.getProducts = async function () {
      if (this.getAgentId() === 'bad') {
        const err = new Error('seller refused');
        err.data = { errors: [null] };
        throw err;
      }
      return healthy;
    };
    try {
      const results = await new ADCPMultiAgentClient(agents).allAgents().getProducts({ brief: 'x' });
      assert.strictEqual(results.length, 2);
      const failed = results.find(r => r.success === false);
      assert.ok(failed);
      assert.strictEqual(failed.status, 'failed');
      assert.strictEqual(failed.error, 'seller refused');
      assert.strictEqual(
        results.find(r => r.success === true),
        healthy
      );
    } finally {
      AgentClient.prototype.getProducts = original;
    }
  });
});

describe('is401Error ignores message text when a structured AdCP body is present (#3689)', () => {
  const { is401Error } = require('../../dist/lib/index.js');
  const body = { adcp_error: { code: 'ADAPTER_ERROR', message: 'x', mutation_outcome: 'applied' } };
  const message = 'A2A agent returned error: Unauthorized upstream after commit';

  test('Unauthorized in the message + structured body is not a 401', () => {
    assert.strictEqual(is401Error(Object.assign(new Error(message), { data: body })), false);
  });

  test('the same message without data is still a 401', () => {
    assert.strictEqual(is401Error(new Error(message)), true);
  });

  test('a real status 401 with data is still a 401', () => {
    assert.strictEqual(is401Error({ status: 401, data: body }), true);
  });

  test('through the A2A harness: HTTP 200 JSON-RPC error saying Unauthorized keeps the outcome and body', async () => {
    const a2aShim = require('../../dist/lib/protocols/a2a').legacyA2AClientTestShim;
    const original = a2aShim.fromCardUrl;
    closeA2AConnections();
    const stubClient = {
      getAgentCard: async () => ({ skills: [{ id: 'get_adcp_capabilities', name: 'get_adcp_capabilities' }] }),
      sendMessage: async payload => {
        if (payload.message.parts.some(part => part.content?.value?.skill === 'get_adcp_capabilities')) {
          return {
            jsonrpc: '2.0',
            id: 'caps',
            result: {
              kind: 'task',
              id: 'caps-task',
              contextId: 'caps-ctx',
              status: { state: 'completed', timestamp: new Date().toISOString() },
              artifacts: [
                {
                  artifactId: 'caps-art',
                  parts: [
                    {
                      kind: 'data',
                      data: {
                        status: 'completed',
                        adcp_version: '3.2',
                        adcp: { major_versions: [3], idempotency: { supported: false } },
                        supported_protocols: ['media_buy'],
                      },
                    },
                  ],
                },
              ],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id: 'rpc-1',
          error: { code: -32000, message: 'Unauthorized upstream after commit', data: body },
        };
      },
    };
    a2aShim.fromCardUrl = async () => stubClient;
    try {
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(
        { id: 'seller-a2a', name: 'Seller', agent_uri: 'https://seller.test/a2a', protocol: 'a2a' },
        'update_media_buy',
        { media_buy_id: 'mb_1', idempotency_key: 'idem-1234567890123456' }
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.adcpError?.mutation_outcome, 'applied');
      assert.deepStrictEqual(result.data, body);
      assert.notStrictEqual(result.errorInstance?.constructor?.name, 'AuthenticationRequiredError');
      assert.notStrictEqual(result.status, 'auth_required');
    } finally {
      a2aShim.fromCardUrl = original;
      closeA2AConnections();
    }
  });
});

describe('exported extractor parity on errors[0].mutation_outcome (#3689)', () => {
  const { extractAdcpErrorFromTransport } = require('../../dist/lib/index.js');
  const body = {
    adcp_error: { code: 'VALIDATION_ERROR', message: 'targeting rejected' },
    errors: [{ code: 'VALIDATION_ERROR', message: 'targeting rejected', mutation_outcome: 'unknown' }],
  };

  test('extractAdcpErrorFromMcp via structuredContent', () => {
    const extracted = extractAdcpErrorFromMcp({ isError: true, structuredContent: body, content: [] });
    assert.strictEqual(extracted?.mutation_outcome, 'unknown');
  });

  test('extractAdcpErrorFromMcp via text JSON', () => {
    const extracted = extractAdcpErrorFromMcp({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    });
    assert.strictEqual(extracted?.mutation_outcome, 'unknown');
  });

  test('extractAdcpErrorFromTransport', () => {
    const extracted = extractAdcpErrorFromTransport({ data: body });
    assert.strictEqual(extracted?.mutation_outcome, 'unknown');
  });
});
