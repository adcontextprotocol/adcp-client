const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  normalizeCapturedA2AResult,
  parseLastA2aMessageSendCapture,
  runStoryboard,
  selectLastA2aSkillCapture,
} = require('../../dist/lib/testing/storyboard/runner.js');

function storyboard(auth = 'none') {
  return {
    id: 'a2a_auth_override',
    version: '1.0.0',
    adcp_version: '3.1.1',
    title: 'A2A auth override',
    category: 'security',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'auth',
        title: 'Auth',
        steps: [
          {
            id: 'protected_call',
            title: 'Protected call',
            task: 'list_creatives',
            auth,
            expect_error: true,
            validations: [{ check: 'http_status', value: 401, description: 'agent rejects the probe' }],
          },
        ],
      },
    ],
  };
}

function card(rpcUrl) {
  return {
    protocolVersion: '1.0',
    name: 'A2A auth fixture',
    description: 'Official client auth fixture',
    version: '1.0.0',
    supportedInterfaces: [{ url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {},
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
  };
}

function legacyCard(rpcUrl) {
  return {
    protocolVersion: '0.3.0',
    name: 'A2A 0.3 auth fixture',
    description: 'Official compatibility client auth fixture',
    version: '1.0.0',
    url: rpcUrl,
    capabilities: {},
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
  };
}

function capabilitiesResponse(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      task: {
        id: 'capabilities-task',
        contextId: 'capabilities-context',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [
          {
            artifactId: 'capabilities',
            parts: [
              {
                data: {
                  status: 'completed',
                  adcp_version: '3.1',
                  adcp: { major_versions: [3], supported_versions: ['3.1.1'] },
                  supported_protocols: ['creative'],
                  tools: [{ name: 'list_creatives' }],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

function mixedTransportStoryboard(agent) {
  const value = storyboard();
  value.id = `mixed_transport_${agent}`;
  value.phases[0].steps[0].agent = agent;
  return value;
}

function mixedTransportFetch(calls) {
  const a2aOrigin = 'https://a2a.example';
  const mcpUrl = 'https://mcp.example/mcp';
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(a2aOrigin) && url.includes('/.well-known/')) {
      const agentCard = card(`${a2aOrigin}/rpc`);
      agentCard.skills = ['get_adcp_capabilities', 'list_creatives'].map(name => ({
        id: name,
        name,
        description: `${name} fixture`,
        tags: [],
        examples: [],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      }));
      return new Response(JSON.stringify(agentCard), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const rawBody = init.body ?? (input instanceof Request ? await input.clone().text() : '');
    const body = rawBody ? JSON.parse(rawBody) : {};
    if (url === `${a2aOrigin}/rpc`) {
      const skill = body.params?.message?.parts?.[0]?.data?.skill;
      calls.push({ transport: 'a2a', method: body.method, skill, url });
      if (skill === 'get_adcp_capabilities') {
        return new Response(JSON.stringify(capabilitiesResponse(body.id)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001 } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="a2a"' },
      });
    }

    assert.strictEqual(url, mcpUrl);
    calls.push({ transport: 'mcp', method: body.method, skill: body.params?.name, url });
    if (body.method === 'server/discover') return new Response('not supported', { status: 404 });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result =
      body.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'mixed-routing-mcp', version: '1.0.0' },
            capabilities: { tools: {} },
          }
        : body.method === 'tools/list'
          ? {
              tools: ['get_adcp_capabilities', 'list_creatives'].map(name => ({
                name,
                description: `${name} fixture`,
                inputSchema: { type: 'object' },
              })),
            }
          : body.method === 'tools/call' && body.params?.name === 'get_adcp_capabilities'
            ? {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'completed',
                      adcp_version: '3.1',
                      adcp: { major_versions: [3], supported_versions: ['3.1.1'] },
                      supported_protocols: ['creative'],
                      tools: [{ name: 'list_creatives' }],
                    }),
                  },
                ],
                isError: false,
              }
            : undefined;
    if (result === undefined) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001 } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="mcp"' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'mixed-routing-session' },
    });
  };
}

describe('storyboard A2A auth overrides', () => {
  test('normalizes native 1.0 task envelopes for transport-neutral validators', () => {
    const result = normalizeCapturedA2AResult({
      task: {
        id: 'native-task',
        contextId: 'native-context',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'result', parts: [{ data: { status: 'submitted', task_id: 'adcp-task' } }] }],
      },
    });

    assert.strictEqual(result.kind, 'task');
    assert.strictEqual(result.contextId, 'native-context');
    assert.strictEqual(result.status.state, 'completed');
    assert.strictEqual(result.artifacts[0].parts[0].kind, 'data');
    assert.strictEqual(result.artifacts[0].parts[0].data.task_id, 'adcp-task');
  });

  test('native 1.0 submitted task envelopes reach A2A wire-shape validators', async () => {
    const agentUrl = 'https://seller.example';
    const rpcUrl = `${agentUrl}/rpc`;
    const fetchFn = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/.well-known/')) {
        const agentCard = card(rpcUrl);
        agentCard.skills = ['get_adcp_capabilities', 'create_media_buy'].map(name => ({
          id: name,
          name,
          description: `${name} fixture`,
          tags: [],
          examples: [],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        }));
        return new Response(JSON.stringify(agentCard), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(init.body);
      const skill = body.params?.message?.parts?.[0]?.data?.skill;
      if (skill === 'get_adcp_capabilities') {
        const response = capabilitiesResponse(body.id);
        response.result.task.artifacts[0].parts[0].data.tools = [{ name: 'create_media_buy' }];
        response.result.task.artifacts[0].parts[0].data.supported_protocols = ['media_buy'];
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: 'native-a2a-task',
              contextId: 'native-a2a-context',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [
                {
                  artifactId: 'native-result',
                  metadata: { adcp_task_id: 'adcp-async-task' },
                  parts: [{ data: { status: 'submitted', task_id: 'adcp-async-task' } }],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const submittedStoryboard = {
      id: 'native_submitted',
      version: '1.0.0',
      adcp_version: '3.1.1',
      title: 'Native submitted envelope',
      category: 'media_buy_seller',
      summary: '',
      narrative: '',
      agent: { interaction_model: 'media_buy_seller', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'create',
          title: 'Create',
          steps: [
            {
              id: 'create_media_buy_async',
              title: 'Create async',
              task: 'create_media_buy',
              stateful: true,
              sample_request: {
                brand: { brand_id: 'b1' },
                account: { account_id: 'a1' },
                start_time: '2026-05-01T00:00:00Z',
                end_time: '2026-07-31T23:59:59Z',
                packages: [{ product_id: 'p1', budget: 1000, pricing_option_id: 'cpm_standard' }],
              },
              validations: [{ check: 'a2a_submitted_artifact', description: 'native envelope is normalized' }],
            },
          ],
        },
      ],
    };

    const result = await runStoryboard(agentUrl, submittedStoryboard, {
      protocol: 'a2a',
      agentTools: ['create_media_buy'],
      transport: { trustedFetchFn: fetchFn },
      _profile: { name: 'fixture', tools: ['create_media_buy'] },
    });
    const validation = result.phases[0].steps[0].validations.find(
      candidate => candidate.check === 'a2a_submitted_artifact'
    );
    assert.ok(validation, JSON.stringify(result));
    assert.strictEqual(validation.passed, true, JSON.stringify(validation));
    assert.strictEqual(validation.observations, undefined, 'native envelope must be captured, not skipped');
  });

  test('selects the last matching POST after an authorization retry', () => {
    const base = {
      url: 'https://seller.example/rpc',
      method: 'POST',
      requestJsonRpcMethod: 'SendMessage',
      requestAdcpSkill: 'list_creatives',
      headers: {},
      body: '{}',
      latencyMs: 1,
      timestamp: new Date(0).toISOString(),
      bodyTruncated: false,
    };
    const selected = selectLastA2aSkillCapture(
      [
        { ...base, status: 401 },
        { ...base, requestAdcpSkill: 'get_adcp_capabilities', status: 200 },
        { ...base, status: 403, body: '{"retry":true}' },
      ],
      'list_creatives'
    );
    assert.strictEqual(selected.status, 403);
    assert.strictEqual(selected.body, '{"retry":true}');
  });

  test('keeps the last SendMessage response when later task polling is captured', () => {
    const base = {
      url: 'https://seller.example/rpc',
      method: 'POST',
      headers: {},
      status: 200,
      latencyMs: 1,
      timestamp: new Date(0).toISOString(),
      bodyTruncated: false,
    };
    const taskBody = id =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { task: { id, contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' } } },
      });
    const parsed = parseLastA2aMessageSendCapture([
      { ...base, requestJsonRpcMethod: 'SendMessage', body: taskBody('send-response') },
      { ...base, requestJsonRpcMethod: 'GetTask', body: taskBody('poll-response') },
    ]);

    assert.strictEqual(parsed.result.id, 'send-response');
  });

  test('refuses to parse an incomplete SendMessage capture', () => {
    const parsed = parseLastA2aMessageSendCapture([
      {
        url: 'https://seller.example/rpc',
        method: 'POST',
        requestJsonRpcMethod: 'SendMessage',
        status: 200,
        headers: {},
        body: '{"jsonrpc":"2.0",',
        latencyMs: 10_001,
        timestamp: new Date(0).toISOString(),
        bodyTruncated: true,
        bodyCaptureError: 'Raw response capture timed out after 10000 ms before the response body completed',
      },
    ]);

    assert.strictEqual(parsed, undefined);
  });

  test('dispatches official SendMessage and never MCP tools/call while isolating credentials', async () => {
    const agentUrl = 'https://seller.example';
    const rpcUrl = `${agentUrl}/rpc`;
    const rpcCalls = [];
    const fetchFn = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/.well-known/')) {
        return new Response(JSON.stringify(card(rpcUrl)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(init.body);
      const headers = Object.fromEntries(new Headers(init.headers));
      const skill = body.params?.message?.parts?.[0]?.data?.skill;
      rpcCalls.push({ body, headers, skill, url });
      if (skill === 'get_adcp_capabilities') {
        return new Response(JSON.stringify(capabilitiesResponse(body.id)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001 } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="agent"' },
      });
    };

    const result = await runStoryboard(agentUrl, storyboard(), {
      protocol: 'a2a',
      agentTools: ['list_creatives'],
      headers: {
        'x-tenant': 'buyer-7',
        'x-auth-token': 'must-not-survive',
        Signature: 'must-not-survive',
      },
      test_kit: { auth: { api_key: 'must-not-survive', probe_task: 'list_creatives' } },
      transport: { trustedFetchFn: fetchFn },
      _profile: { name: 'fixture', tools: ['list_creatives'] },
    });

    const probe = rpcCalls.find(call => call.skill === 'list_creatives');
    assert.ok(probe, 'protected task reached the card-selected endpoint');
    assert.strictEqual(probe.url, rpcUrl);
    assert.strictEqual(probe.body.method, 'SendMessage');
    assert.notStrictEqual(probe.body.method, 'tools/call');
    assert.strictEqual(probe.headers.authorization, undefined);
    assert.strictEqual(probe.headers['x-adcp-auth'], undefined);
    assert.strictEqual(probe.headers['x-auth-token'], undefined);
    assert.strictEqual(probe.headers.signature, undefined);
    assert.strictEqual(probe.headers['x-tenant'], 'buyer-7');
    assert.strictEqual(result.overall_passed, true, JSON.stringify(result));
    assert.strictEqual(result.phases[0].steps[0].request.transport, 'a2a');
    assert.strictEqual(result.phases[0].steps[0].request.url, rpcUrl);
  });

  test('0.3 compatibility auth override uses official message/send and never MCP tools/call', async () => {
    const agentUrl = 'https://seller.example';
    const rpcUrl = `${agentUrl}/legacy-rpc`;
    const rpcCalls = [];
    const fetchFn = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/.well-known/')) {
        return new Response(JSON.stringify(legacyCard(rpcUrl)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(init.body);
      const skill = body.params?.message?.parts?.[0]?.data?.skill;
      rpcCalls.push({ body, headers: Object.fromEntries(new Headers(init.headers)), skill, url });
      if (skill === 'get_adcp_capabilities') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              id: 'capabilities-task',
              contextId: 'capabilities-context',
              status: { state: 'completed' },
              artifacts: [
                {
                  artifactId: 'capabilities',
                  parts: [
                    {
                      kind: 'data',
                      data: {
                        status: 'completed',
                        adcp_version: '3.1',
                        adcp: { major_versions: [3], supported_versions: ['3.1.1'] },
                        supported_protocols: ['creative'],
                        tools: [{ name: 'list_creatives' }],
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001 } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="agent"' },
      });
    };

    const result = await runStoryboard(agentUrl, storyboard(), {
      protocol: 'a2a',
      agentTools: ['list_creatives'],
      headers: { 'x-tenant': 'buyer-legacy', 'x-auth-token': 'must-not-survive' },
      test_kit: { auth: { api_key: 'must-not-survive', probe_task: 'list_creatives' } },
      transport: { trustedFetchFn: fetchFn, legacyCompat: { enabled: true } },
      _profile: { name: 'fixture', tools: ['list_creatives'] },
    });

    const probe = rpcCalls.find(call => call.skill === 'list_creatives');
    assert.ok(probe);
    assert.strictEqual(probe.body.method, 'message/send');
    assert.notStrictEqual(probe.body.method, 'tools/call');
    assert.strictEqual(probe.headers.authorization, undefined);
    assert.strictEqual(probe.headers['x-adcp-auth'], undefined);
    assert.strictEqual(probe.headers['x-auth-token'], undefined);
    assert.strictEqual(probe.headers['x-tenant'], 'buyer-legacy');
    assert.strictEqual(result.overall_passed, true, JSON.stringify(result));
  });

  test('never forwards override credentials to a cross-origin card endpoint or grades its response', async () => {
    const agentUrl = 'https://seller.example';
    const rpcUrl = 'https://rpc.seller.example/rpc';
    let rpcCalls = 0;
    const fetchFn = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/.well-known/')) {
        return new Response(JSON.stringify(card(rpcUrl)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      rpcCalls++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001 } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="agent"' },
      });
    };

    const result = await runStoryboard(agentUrl, storyboard({ type: 'api_key', value_strategy: 'random_invalid' }), {
      protocol: 'a2a',
      agentTools: ['list_creatives'],
      transport: { trustedFetchFn: fetchFn },
      _profile: { name: 'fixture', tools: ['list_creatives'] },
    });
    const step = result.phases[0].steps[0];
    assert.strictEqual(rpcCalls, 0, 'credentialed cross-origin endpoint must not receive a POST');
    assert.strictEqual(result.overall_passed, false);
    assert.strictEqual(step.request.url, new URL(agentUrl).href);
    assert.strictEqual(step.response_record.status, 0);
    const statusValidation = step.validations.find(validation => validation.check === 'http_status');
    assert.match(statusValidation.error, /refused credentialed cross-origin endpoint/);
  });

  for (const scenario of [
    { runProtocol: 'a2a', selectedAgent: 'mcp', expectedMethod: 'tools/call' },
    { runProtocol: 'mcp', selectedAgent: 'a2a', expectedMethod: 'SendMessage' },
  ]) {
    test(`auth:none uses routed ${scenario.selectedAgent.toUpperCase()} transport under a ${scenario.runProtocol.toUpperCase()} run default`, async () => {
      const calls = [];
      const result = await runStoryboard('', mixedTransportStoryboard(scenario.selectedAgent), {
        protocol: scenario.runProtocol,
        agents: {
          mcp: { url: 'https://mcp.example/mcp', transport: 'mcp' },
          a2a: { url: 'https://a2a.example', transport: 'a2a' },
        },
        transport: { trustedFetchFn: mixedTransportFetch(calls) },
      });

      const protectedCalls = calls.filter(call => call.skill === 'list_creatives');
      assert.strictEqual(protectedCalls.length, 1, JSON.stringify(calls));
      assert.strictEqual(protectedCalls[0].transport, scenario.selectedAgent);
      assert.strictEqual(protectedCalls[0].method, scenario.expectedMethod);
      assert.strictEqual(result.phases[0].steps[0].request.transport, scenario.selectedAgent);
      assert.strictEqual(result.overall_passed, true, JSON.stringify(result));
    });
  }
});
