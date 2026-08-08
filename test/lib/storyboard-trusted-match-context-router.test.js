const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/index.js');

const VECTOR = JSON.parse(`{
  "profile": "adcp/trusted-match/context-targeting-merge/v1",
  "registrations": [
    { "provider_id": "provider_a" },
    { "provider_id": "provider_b" },
    { "provider_id": "provider_spoof" },
    { "provider_id": "provider_absent" },
    { "provider_id": "provider_empty" },
    { "provider_id": "__proto__" },
    { "provider_id": "constructor" }
  ],
  "provider_responses": [
    {
      "registration_provider_id": "provider_a",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [{ "package_id": "pkg-a" }],
        "signals": {
          "segments": ["outdoor"],
          "targeting_kvs": [
            { "key": "shared_key", "value": "alpha" },
            { "key": "unmapped_key", "value": "drop-me" }
          ]
        }
      }
    },
    {
      "registration_provider_id": "provider_b",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [{ "package_id": "pkg-b" }],
        "signals": {
          "segments": ["travel"],
          "targeting_kvs": [{ "key": "shared_key", "value": "bravo" }]
        }
      }
    },
    {
      "registration_provider_id": "provider_spoof",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [],
        "signals_by_provider": {
          "provider_a": { "targeting_kvs": [{ "key": "shared_key", "value": "spoofed" }] }
        }
      }
    },
    {
      "registration_provider_id": "provider_absent",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": []
      }
    },
    {
      "registration_provider_id": "provider_empty",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [],
        "signals": { "targeting_kvs": [] }
      }
    },
    {
      "registration_provider_id": "__proto__",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [],
        "signals": { "targeting_kvs": [{ "key": "edge_key", "value": "proto-value" }] }
      }
    },
    {
      "registration_provider_id": "constructor",
      "response": {
        "status": "completed",
        "type": "context_match_response",
        "request_id": "ctx-provider-attribution-1",
        "offers": [],
        "signals": { "targeting_kvs": [{ "key": "name", "value": "constructor-value" }] }
      }
    }
  ]
}`);

const REQUEST = {
  type: 'context_match_request',
  request_id: 'ctx-provider-attribution-1',
  property_rid: '00000000-0000-7000-8000-000000000001',
  property_type: 'website',
  placement_id: 'tmp-context-merge',
  seller_agent_url: 'https://seller.example/mcp',
};

const EXPECTED_BUCKETS = JSON.parse(`{
  "provider_a": {
    "targeting_kvs": [
      { "key": "shared_key", "value": "alpha" },
      { "key": "unmapped_key", "value": "drop-me" }
    ]
  },
  "provider_b": {
    "targeting_kvs": [{ "key": "shared_key", "value": "bravo" }]
  },
  "__proto__": {
    "targeting_kvs": [{ "key": "edge_key", "value": "proto-value" }]
  },
  "constructor": {
    "targeting_kvs": [{ "key": "name", "value": "constructor-value" }]
  }
}`);

function storyboard() {
  return {
    id: 'trusted_match_context_router_replay',
    version: '1.0.0',
    title: 'Trusted Match Context router replay',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'compliance_runner' },
    phases: [
      {
        id: 'router_merge',
        title: 'Router merge',
        steps: [
          {
            id: 'replay_context_merge',
            title: 'Replay provider-attribution vector',
            task: 'replay_trusted_match_context_vector',
            vector_ref: 'vectors.json',
            sample_request: REQUEST,
            validations: [
              { check: 'http_status', value: 200, description: 'Router accepts the Context Match request.' },
              {
                check: 'field_value',
                path: 'signals_by_provider',
                value: EXPECTED_BUCKETS,
                description: 'Provider-local KVs remain unchanged in registration-authored buckets.',
              },
              {
                check: 'field_absent',
                path: 'signals.targeting_kvs',
                description: 'Router output omits flattened targeting KVs.',
              },
            ],
          },
        ],
      },
    ],
  };
}

const PROFILE = { name: 'raw router', tools: [], raw_capabilities: {} };
let router;

afterEach(async () => {
  if (router) await closeServer(router.server);
  router = undefined;
});

describe('replay_trusted_match_context_vector', () => {
  test('hosts canonical provider fixtures and grades the raw router response through normal validations', async () => {
    const vectorRoot = mkdtempSync(join(tmpdir(), 'adcp-context-vector-'));
    writeFileSync(join(vectorRoot, 'vectors.json'), JSON.stringify(VECTOR));
    router = await startRouter();
    let registered;
    let cleanupCalled = false;

    const result = await runStoryboard(router.url, storyboard(), {
      _profile: PROFILE,
      agentTools: [],
      allow_http: true,
      trusted_match_context_router_runner: {
        router_url: router.url,
        vectorsRoot: vectorRoot,
        registerProviders: context => {
          registered = context;
          router.setProviders(context.providers);
          return () => {
            cleanupCalled = true;
          };
        },
      },
    });

    const step = result.phases[0].steps[0];
    assert.equal(step.passed, true, JSON.stringify(step.validations));
    assert.equal(step.request.transport, 'http');
    assert.equal(step.request.url, `${router.url}/context`);
    assert.deepEqual(step.request.payload, REQUEST);
    assert.equal(registered.profile, VECTOR.profile);
    assert.deepEqual(
      registered.providers.map(provider => provider.provider_id),
      VECTOR.registrations.map(registration => registration.provider_id)
    );
    assert.ok(registered.providers.every(provider => provider.context_url.endsWith('/context')));
    assert.equal(cleanupCalled, true);
    assert.deepEqual(step.response.body.signals_by_provider, EXPECTED_BUCKETS);
    assert.equal(step.response.body.signals?.targeting_kvs, undefined);
    assert.equal(step.response.body.signals_by_provider.provider_spoof, undefined);
    assert.equal(step.response.body.signals_by_provider.provider_a.targeting_kvs[1].key, 'unmapped_key');
    assert.equal(Object.hasOwn(step.response.body.signals_by_provider, '__proto__'), true);
  });

  test('grades the whole storyboard not_applicable when the registration seam is unavailable', async () => {
    const result = await runStoryboard('http://127.0.0.1:1', storyboard(), {
      _profile: PROFILE,
      agentTools: [],
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip.reason, 'not_applicable');
    assert.equal(step.skip.requirement, 'trusted_match_context_router_runner');
    assert.match(step.skip.detail, /registerProviders/);
  });
});

async function startRouter() {
  let providers = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/context') {
        res.writeHead(404).end();
        return;
      }
      const request = await readJson(req);
      const providerResponses = await Promise.all(
        providers.map(async provider => {
          const response = await fetch(provider.context_url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          return { provider_id: provider.provider_id, body: await response.json() };
        })
      );

      const offers = [];
      const segments = [];
      const buckets = new Map();
      for (const { provider_id: providerId, body } of providerResponses) {
        offers.push(...body.offers);
        segments.push(...(body.signals?.segments ?? []));
        if (body.signals?.targeting_kvs?.length) {
          buckets.set(providerId, { targeting_kvs: body.signals.targeting_kvs });
        }
      }
      const responseBody = {
        status: 'completed',
        type: 'context_match_response',
        request_id: request.request_id,
        offers,
        ...(segments.length && { signals: { segments } }),
        ...(buckets.size && { signals_by_provider: Object.fromEntries(buckets) }),
      };
      const encoded = JSON.stringify(responseBody);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
      res.end(encoded);
    })().catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await listen(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, setProviders: value => (providers = value) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
