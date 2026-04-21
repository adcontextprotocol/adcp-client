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

describe('runStoryboard: sample_request envelope pass-through with a request builder', () => {
  it('forwards push_notification_config from sample_request into the outbound create_media_buy args', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
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

  it('resolves {{runner.webhook_url:<step_id>}} inside push_notification_config.url against the runner webhook receiver', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
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
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
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
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
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
});
