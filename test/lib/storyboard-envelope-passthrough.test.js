/**
 * Storyboard runner: sample_request envelope pass-through when a builder is used.
 *
 * Issue #747 — when a storyboard step declares a tool that has a programmatic
 * request builder (create_media_buy, update_media_buy, etc.), the builder
 * constructs the request from scratch and the runner selectively merges
 * envelope-level fields (`context`, `ext`, `idempotency_key`,
 * `push_notification_config`) from the hand-authored sample_request on top.
 *
 * Before the fix, push_notification_config fell off the wagon — the webhook
 * URL declared in the YAML never reached the outbound MCP request, so every
 * webhook-emission conformance storyboard failed vacuously.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRecordingMcpServer(seen) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
        })
      );
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    seen.push({ name: rpc.params.name, args: rpc.params.arguments });
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'unauthorized' } }));
  });
}

describe('runStoryboard: sample_request envelope pass-through with a request builder', () => {
  it('forwards push_notification_config from sample_request into the outbound create_media_buy args', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'envelope_passthrough_sb',
        version: '1.0.0',
        title: 'Envelope pass-through',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'create',
            steps: [
              {
                id: 'create_buy',
                title: 'storyboard sample_request declares push_notification_config; builder path must not drop it',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  start_time: '2099-10-01T00:00:00Z',
                  end_time: '2099-12-31T23:59:59Z',
                  push_notification_config: {
                    url: 'https://buyer.example/webhooks/create_media_buy',
                    authentication: {
                      schemes: ['HMAC-SHA256'],
                      credentials: 'test-secret-min-32-characters-required',
                    },
                  },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        brand: { domain: 'novamotors.example' },
        agentTools: ['create_media_buy'],
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      const call = seen[0];
      assert.strictEqual(call.name, 'create_media_buy');
      assert.ok(call.args.push_notification_config, 'push_notification_config was dropped from outbound args');
      assert.strictEqual(
        call.args.push_notification_config.url,
        'https://buyer.example/webhooks/create_media_buy',
        'push_notification_config.url must flow through verbatim'
      );
      assert.deepStrictEqual(call.args.push_notification_config.authentication, {
        schemes: ['HMAC-SHA256'],
        credentials: 'test-secret-min-32-characters-required',
      });
    } finally {
      server.close();
    }
  });

  it('preserves the signal_owned activate_on_agent sample_request through runner dispatch (ADCP-4009)', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'signal_owned_activate_agent_passthrough_sb',
        version: '1.0.0',
        title: 'Signal owned activate_on_agent pass-through',
        category: 'signal_owned',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'agent_activation',
            title: 'Activate on a sales agent',
            steps: [
              {
                id: 'activate_on_agent',
                title: 'Activate owned signal on a sales agent',
                task: 'activate_signal',
                auth: 'none',
                sample_request: {
                  account: {
                    brand: { domain: 'novamotors.example' },
                    operator: 'pinnacle-agency.example',
                  },
                  signal_agent_segment_id: 'prism_cart_abandoner',
                  pricing_option_id: 'po_prism_abandoner_cpm',
                  destinations: [{ type: 'agent', agent_url: 'https://wonderstruck.salesagents.example' }],
                  idempotency_key: '$generate:uuid_v4#signal_owned_activate_agent',
                  context: { correlation_id: 'signal_owned--activate_on_agent' },
                  ext: { test_platform: { test_run: true } },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };

      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        brand: { domain: 'novamotors.example' },
        agentTools: ['activate_signal'],
        _profile: { name: 'Test', tools: ['activate_signal'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'activate_signal' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      const call = seen[0];
      assert.strictEqual(call.name, 'activate_signal');
      assert.deepStrictEqual(call.args.account, {
        brand: { domain: 'novamotors.example' },
        operator: 'pinnacle-agency.example',
      });
      assert.strictEqual(call.args.signal_agent_segment_id, 'prism_cart_abandoner');
      assert.strictEqual(call.args.pricing_option_id, 'po_prism_abandoner_cpm');
      assert.deepStrictEqual(call.args.destinations, [
        { type: 'agent', agent_url: 'https://wonderstruck.salesagents.example' },
      ]);
      assert.match(
        call.args.idempotency_key,
        UUID_V4,
        `idempotency_key must be resolved before dispatch, got: ${call.args.idempotency_key}`
      );
      assert.notStrictEqual(call.args.idempotency_key, '$generate:uuid_v4#signal_owned_activate_agent');
      assert.deepStrictEqual(call.args.context, { correlation_id: 'signal_owned--activate_on_agent' });
      assert.deepStrictEqual(call.args.ext, { test_platform: { test_run: true } });
    } finally {
      server.close();
    }
  });

  it('resolves {{runner.webhook_url:<step_id>}} inside push_notification_config.url against the runner webhook receiver', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'envelope_passthrough_webhook_url_sb',
        version: '1.0.0',
        title: 'Runner webhook URL substitution',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'create',
            steps: [
              {
                id: 'create_buy',
                title: 'runner webhook URL token must be expanded before the request lands at the server',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  start_time: '2099-10-01T00:00:00Z',
                  end_time: '2099-12-31T23:59:59Z',
                  push_notification_config: {
                    url: '{{runner.webhook_url:create_buy}}',
                    authentication: { schemes: ['HMAC-SHA256'], credentials: 'test-secret-min-32-characters-required' },
                  },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        brand: { domain: 'novamotors.example' },
        agentTools: ['create_media_buy'],
        webhook_receiver: { mode: 'ephemeral' },
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1);
      const url = seen[0].args.push_notification_config?.url;
      assert.ok(typeof url === 'string', 'push_notification_config.url must be forwarded');
      assert.ok(
        /\/step\/create_buy\/[0-9a-f-]{36}$/i.test(url),
        `expected runner.webhook_url to expand to "{base}/step/create_buy/<uuid>"; got ${url}`
      );
      assert.ok(!url.includes('{{runner.'), 'mustache token must be fully expanded before the request is sent');
    } finally {
      server.close();
    }
  });

  it('still forwards push_notification_config on the non-builder path (acquire_rights) so no future "simplification" of the merge block breaks one path undetected', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'envelope_passthrough_no_builder_sb',
        version: '1.0.0',
        title: 'No-builder path pass-through',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'acquire',
            steps: [
              {
                id: 'acquire',
                title:
                  'task without a builder: sample_request is spread wholesale, push_notification_config rides along',
                task: 'acquire_rights',
                auth: 'none',
                sample_request: {
                  campaign: { id: 'c1' },
                  push_notification_config: {
                    url: 'https://buyer.example/webhooks/acquire_rights',
                    authentication: { schemes: ['HMAC-SHA256'], credentials: 'test-secret-min-32-characters-required' },
                  },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['acquire_rights'],
        _profile: { name: 'Test', tools: ['acquire_rights'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'acquire_rights' }] }),
        },
      });

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(
        seen[0].args.push_notification_config?.url,
        'https://buyer.example/webhooks/acquire_rights',
        'non-builder path must still forward push_notification_config'
      );
    } finally {
      server.close();
    }
  });

  it('does not let sample_request overwrite a push_notification_config already on the request (e.g. supplied via options.request) — the `=== undefined` guard is load-bearing', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'envelope_passthrough_options_request_sb',
        version: '1.0.0',
        title: 'options.request wins over sample_request',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'acquire',
            steps: [
              {
                id: 'acquire',
                title: 'caller-provided request wins; sample_request.push_notification_config must not overwrite',
                task: 'acquire_rights',
                auth: 'none',
                sample_request: {
                  campaign: { id: 'c1' },
                  push_notification_config: {
                    url: 'https://buyer.example/FROM_SAMPLE_REQUEST',
                    authentication: { schemes: ['HMAC-SHA256'], credentials: 'test-secret-min-32-characters-required' },
                  },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      // `options.request` short-circuits sample_request merging at runner.ts:1023-1024.
      // The request body becomes exactly what the caller sent — sample_request is ignored.
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['acquire_rights'],
        request: {
          campaign: { id: 'c-override' },
          push_notification_config: {
            url: 'https://buyer.example/FROM_CALLER',
            authentication: { schemes: ['HMAC-SHA256'], credentials: 'test-secret-min-32-characters-required' },
          },
        },
        _profile: { name: 'Test', tools: ['acquire_rights'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'acquire_rights' }] }),
        },
      });

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(
        seen[0].args.push_notification_config?.url,
        'https://buyer.example/FROM_CALLER',
        'caller-provided push_notification_config must win — sample_request only fills missing fields'
      );
    } finally {
      server.close();
    }
  });

  it('resolves runner webhook placeholders supplied through options.request before dispatch', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'options_request_webhook_url_sb',
        version: '1.0.0',
        title: 'Options request webhook substitution',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'create',
            steps: [
              {
                id: 'create_buy',
                title: 'caller-provided request still gets runner substitutions',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  start_time: '2099-10-01T00:00:00Z',
                  end_time: '2099-12-31T23:59:59Z',
                  packages: [{ buyer_ref: 'pkg-1', product_id: 'prod-1', pricing_option_id: 'cpm-1', budget: 100 }],
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['create_media_buy'],
        webhook_receiver: { mode: 'ephemeral' },
        request: {
          start_time: '2099-10-01T00:00:00Z',
          end_time: '2099-12-31T23:59:59Z',
          push_notification_config: { url: '{{runner.webhook_url:create_buy}}' },
        },
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1);
      const url = seen[0].args.push_notification_config?.url;
      assert.ok(typeof url === 'string', 'push_notification_config.url must be forwarded');
      assert.ok(/\/step\/create_buy\/[0-9a-f-]{36}$/i.test(url), `expected expanded runner webhook URL; got ${url}`);
      assert.ok(!url.includes('{{runner.'), 'options.request webhook token must not reach the agent');
    } finally {
      server.close();
    }
  });

  it('skips instead of dispatching when options.request contains an unresolved runner webhook placeholder', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'options_request_webhook_url_no_receiver_sb',
        version: '1.0.0',
        title: 'Options request webhook substitution without receiver',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'create',
            steps: [
              {
                id: 'create_buy',
                title: 'unresolved runner webhook token must not be sent',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  start_time: '2099-10-01T00:00:00Z',
                  end_time: '2099-12-31T23:59:59Z',
                  packages: [{ buyer_ref: 'pkg-1', product_id: 'prod-1', pricing_option_id: 'cpm-1', budget: 100 }],
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['create_media_buy'],
        request: {
          start_time: '2099-10-01T00:00:00Z',
          end_time: '2099-12-31T23:59:59Z',
          push_notification_config: { url: '{{runner.webhook_url:create_buy}}' },
        },
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 0, 'unresolved runner webhook token must not be dispatched');
      const step = result.phases[0].steps[0];
      assert.strictEqual(step.skipped, true);
      assert.strictEqual(step.skip_reason, 'not_applicable');
      assert.match(step.skip.detail, /unresolved runner placeholders/);
    } finally {
      server.close();
    }
  });

  it('skips instead of dispatching when options.request contains an unresolved prior_step operation placeholder', async () => {
    const seen = [];
    const server = createRecordingMcpServer(seen);
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'options_request_prior_step_unresolved_sb',
        version: '1.0.0',
        title: 'Options request prior step substitution without operation id',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'create',
            steps: [
              {
                id: 'create_buy',
                title: 'unresolved prior step token must not be sent',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  start_time: '2099-10-01T00:00:00Z',
                  end_time: '2099-12-31T23:59:59Z',
                  packages: [{ buyer_ref: 'pkg-1', product_id: 'prod-1', pricing_option_id: 'cpm-1', budget: 100 }],
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['create_media_buy'],
        request: {
          start_time: '2099-10-01T00:00:00Z',
          end_time: '2099-12-31T23:59:59Z',
          push_notification_config: { url: 'https://hooks.example/{{prior_step.missing.operation_id}}' },
        },
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 0, 'unresolved prior_step token must not be dispatched');
      const step = result.phases[0].steps[0];
      assert.strictEqual(step.skipped, true);
      assert.strictEqual(step.passed, false);
      assert.strictEqual(step.skip_reason, 'prerequisite_failed');
      assert.match(step.skip.detail, /prior_step\.missing\.operation_id/);
    } finally {
      server.close();
    }
  });
});
