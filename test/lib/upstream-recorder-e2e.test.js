/**
 * End-to-end round-trip test for `@adcp/sdk/upstream-recorder` (issue
 * adcp-client#1290) and the runner-output-contract v2.0.0 `upstream_traffic`
 * storyboard check (PR #1289 / spec adcp#3816).
 *
 * The two halves of the contract are unit-tested independently:
 *   - `test/lib/upstream-recorder.test.js` exercises the recorder.
 *   - `test/lib/storyboard-runner-output-contract-v2-runner.test.js`
 *     exercises the runner with a stub controller.
 *
 * Neither catches a wire-shape drift between recorder output and runner
 * input. This file pins the contract: a real recorder, a real fixture
 * storyboard with a real `upstream_traffic` validation, a stub MCP client
 * whose `comply_test_controller` handler routes through the recorder's
 * `query()` + `toQueryUpstreamTrafficResponse()` adapter — exactly what
 * an adopter wires.
 *
 * Four cases pin the meaningful behaviors:
 *   1. Happy path: adapter wraps fetch, records under principal, runner passes.
 *   2. Façade: adapter never wraps fetch, controller returns empty, runner fails.
 *   3. Principal mismatch: record under A, query under B, runner fails.
 *   4. identifier_paths: missing vector → runner reports missing_identifier_values.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { createUpstreamRecorder, toQueryUpstreamTrafficResponse } = require('../../dist/lib/upstream-recorder');
const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'storyboards', 'upstream-traffic-fixture.yaml');
const fixtureYaml = readFileSync(FIXTURE_PATH, 'utf-8');
const storyboard = parseStoryboard(fixtureYaml);

const stubProfile = {
  name: 'stub',
  tools: ['comply_test_controller', 'sync_audiences'],
};

/**
 * Build the stub MCP client an adopter would expose. The
 * `comply_test_controller` handler routes through the real recorder
 * via `toQueryUpstreamTrafficResponse(recorder.query(...))` — exactly
 * the snippet adopters paste from the SKILL.
 *
 * `principalForController` is the principal the controller handler will
 * use to scope its query. Tests vary this independently of the
 * record-time principal to verify cross-principal isolation.
 */
function buildClient({ recorder, principalForController, fakeFetch, recordPrincipal }) {
  const wrapped = recorder.wrapFetch(fakeFetch);

  return {
    getAgentInfo: async () => ({ name: 'stub', tools: stubProfile.tools }),
    executeTask: async (name, params) => {
      if (name === 'comply_test_controller') {
        const scenario = params?.scenario;
        if (scenario === 'list_scenarios') {
          return wrapMcpResponse({
            success: true,
            scenarios: ['query_upstream_traffic'],
          });
        }
        if (scenario === 'query_upstream_traffic') {
          const queryParams = params?.params ?? {};
          const result = recorder.query({
            principal: principalForController,
            sinceTimestamp: queryParams.since_timestamp,
            endpointPattern: queryParams.endpoint_pattern,
            limit: queryParams.limit,
          });
          return wrapMcpResponse(toQueryUpstreamTrafficResponse(result));
        }
        return wrapMcpResponse({ success: false, error: `unsupported scenario: ${scenario}` });
      }
      if (name === 'sync_audiences') {
        // Adopter handler — fires the upstream call inside `runWithPrincipal`.
        // The recorder records under `recordPrincipal`; tests vary this to
        // verify isolation. When `wrapped` is the unwrapped fakeFetch (façade
        // case), the call still fires but isn't captured.
        await recorder.runWithPrincipal(recordPrincipal, async () => {
          await wrapped('https://platform.example/v1/audience/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              users: (params?.audiences?.[0]?.add ?? []).map(a => ({ hashed_email: a.hashed_email })),
            }),
          });
        });
        return wrapMcpResponse({
          audiences: [{ audience_id: 'aud_test_1', status: 'active', uploaded_count: 2, matched_count: 2 }],
        });
      }
      return { success: false, error: `no handler for ${name}` };
    },
  };
}

/**
 * Wrap a JSON object as the MCP `{ data: { content: [{ type: 'text', text: ... }] } }`
 * envelope the runner unwraps on the way out of `executeTask`.
 */
function wrapMcpResponse(body) {
  return {
    success: true,
    data: { content: [{ type: 'text', text: JSON.stringify(body) }] },
  };
}

// ────────────────────────────────────────────────────────────
// Case 1: Happy path
// ────────────────────────────────────────────────────────────

describe('upstream-recorder ↔ runner e2e — happy path', () => {
  test('adapter wraps fetch, records under principal, runner upstream_traffic passes', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const principal = 'tenant-acme';
    const fakeFetch = async () =>
      new Response(JSON.stringify({ uploaded: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = buildClient({
      recorder,
      principalForController: principal,
      fakeFetch,
      recordPrincipal: principal,
    });

    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync_audiences', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
      agentTools: stubProfile.tools,
    });

    const upstream = result.validations.find(v => v.check === 'upstream_traffic');
    assert.ok(upstream, 'upstream_traffic validation present');
    assert.equal(upstream.passed, true, `expected passed=true, got: ${JSON.stringify(upstream)}`);
    assert.equal(upstream.actual.matched_count, 1);
    assert.deepEqual(upstream.actual.missing_payload_paths, []);
    assert.deepEqual(upstream.actual.missing_identifier_values, []);
  });
});

// ────────────────────────────────────────────────────────────
// Case 2: Façade (no upstream call)
// ────────────────────────────────────────────────────────────

describe('upstream-recorder ↔ runner e2e — façade detection', () => {
  test('adapter returns AdCP-shaped response without calling upstream → runner grades failed', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const principal = 'tenant-facade';

    // Façade: adapter routes `sync_audiences` directly to a fabricated
    // response without ever calling upstream. The recorder is wired
    // (controller advertises query_upstream_traffic) but observes nothing.
    const client = {
      getAgentInfo: async () => ({ name: 'stub', tools: stubProfile.tools }),
      executeTask: async (name, params) => {
        if (name === 'comply_test_controller') {
          if (params?.scenario === 'query_upstream_traffic') {
            const result = recorder.query({
              principal,
              sinceTimestamp: params?.params?.since_timestamp,
              endpointPattern: params?.params?.endpoint_pattern,
              limit: params?.params?.limit,
            });
            return wrapMcpResponse(toQueryUpstreamTrafficResponse(result));
          }
          return wrapMcpResponse({ success: false, error: 'unsupported' });
        }
        if (name === 'sync_audiences') {
          // No upstream call; just fabricate a shape-valid response.
          return wrapMcpResponse({
            audiences: [{ audience_id: 'aud_test_1', status: 'active', uploaded_count: 2, matched_count: 2 }],
          });
        }
        return { success: false, error: 'no handler' };
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync_audiences', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
      agentTools: stubProfile.tools,
    });

    const upstream = result.validations.find(v => v.check === 'upstream_traffic');
    assert.equal(upstream.passed, false);
    assert.equal(upstream.actual.matched_count, 0);
    assert.equal(upstream.actual.total_calls, 0);
    assert.match(upstream.error, /at least 1 matching call/);
  });
});

// ────────────────────────────────────────────────────────────
// Case 3: Principal mismatch (record-time / query-time disagree)
// ────────────────────────────────────────────────────────────

describe('upstream-recorder ↔ runner e2e — principal mismatch', () => {
  test('adapter records under principal A, controller queries with principal B → runner fails (cross-tenant isolation)', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const fakeFetch = async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

    // Adapter records under 'tenant-alice' but controller handler resolves
    // principal as 'tenant-bob' (e.g. typo in the auth-context resolver).
    // Runner sees zero calls — the contract's security floor catches it.
    const client = buildClient({
      recorder,
      principalForController: 'tenant-bob',
      fakeFetch,
      recordPrincipal: 'tenant-alice',
    });

    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync_audiences', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
      agentTools: stubProfile.tools,
    });

    const upstream = result.validations.find(v => v.check === 'upstream_traffic');
    assert.equal(upstream.passed, false);
    assert.equal(upstream.actual.matched_count, 0, 'cross-tenant query MUST return zero — security HIGH');
  });
});

// ────────────────────────────────────────────────────────────
// Case 4: identifier_paths — missing vector
// ────────────────────────────────────────────────────────────

describe('upstream-recorder ↔ runner e2e — identifier_paths missing vector', () => {
  test('adapter forwards only one of two storyboard identifiers → runner reports missing_identifier_values', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const principal = 'tenant-partial';
    const fakeFetch = async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    const wrapped = recorder.wrapFetch(fakeFetch);

    const client = {
      getAgentInfo: async () => ({ name: 'stub', tools: stubProfile.tools }),
      executeTask: async (name, params) => {
        if (name === 'comply_test_controller') {
          if (params?.scenario === 'query_upstream_traffic') {
            const result = recorder.query({
              principal,
              sinceTimestamp: params?.params?.since_timestamp,
              endpointPattern: params?.params?.endpoint_pattern,
              limit: params?.params?.limit,
            });
            return wrapMcpResponse(toQueryUpstreamTrafficResponse(result));
          }
          return wrapMcpResponse({ success: false, error: 'unsupported' });
        }
        if (name === 'sync_audiences') {
          // Adapter forwards ONLY the first identifier upstream — vec-real-2
          // is fabricated locally without actually being sent.
          await recorder.runWithPrincipal(principal, async () => {
            await wrapped('https://platform.example/v1/audience/upload', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                users: [{ hashed_email: 'vec-real-1' }], // missing vec-real-2
              }),
            });
          });
          return wrapMcpResponse({
            audiences: [{ audience_id: 'aud_test_1', status: 'active', uploaded_count: 2, matched_count: 2 }],
          });
        }
        return { success: false, error: 'no handler' };
      },
    };

    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync_audiences', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
      agentTools: stubProfile.tools,
    });

    const upstream = result.validations.find(v => v.check === 'upstream_traffic');
    assert.equal(upstream.passed, false);
    assert.equal(upstream.actual.matched_count, 1);
    assert.deepEqual(upstream.actual.missing_identifier_values, ['vec-real-2']);
  });
});
