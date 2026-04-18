const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const {
  fetchProbe,
  isPrivateIp,
  PROBE_TASKS,
  generateRandomInvalidApiKey,
  generateRandomInvalidJwt,
  rawMcpProbe,
} = require('../../dist/lib/testing/storyboard/probes');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { comply } = require('../../dist/lib/testing/compliance/comply');

// ────────────────────────────────────────────────────────────
// isPrivateIp
// ────────────────────────────────────────────────────────────

describe('isPrivateIp', () => {
  it('flags loopback, link-local, and RFC 1918 ranges', () => {
    for (const addr of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.0.1',
    ]) {
      assert.strictEqual(isPrivateIp(addr), true, `${addr} should be private`);
    }
  });

  it('flags IPv6 loopback, link-local, and ULA', () => {
    for (const addr of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      assert.strictEqual(isPrivateIp(addr), true, `${addr} should be private`);
    }
  });

  it('allows public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1']) {
      assert.strictEqual(isPrivateIp(addr), false, `${addr} should be public`);
    }
  });

  it('returns false for non-IP strings', () => {
    assert.strictEqual(isPrivateIp('example.com'), false);
  });
});

// ────────────────────────────────────────────────────────────
// fetchProbe SSRF guardrails
// ────────────────────────────────────────────────────────────

describe('fetchProbe SSRF guardrails', () => {
  it('refuses non-HTTPS URLs by default', async () => {
    const result = await fetchProbe('http://example.com/metadata');
    assert.match(result.error, /non-HTTPS/);
    assert.strictEqual(result.status, 0);
  });

  it('refuses loopback addresses by default', async () => {
    // 127.0.0.1 → short-circuit via DNS lookup, same guard
    const result = await fetchProbe('https://127.0.0.1/metadata');
    assert.match(result.error, /private\/loopback/);
  });

  it('allows localhost when allowPrivateIp is set', async () => {
    // Start a throwaway HTTP server to verify the happy path works when the guard is off.
    const server = http.createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    try {
      const result = await fetchProbe(`http://127.0.0.1:${port}/metadata`, { allowPrivateIp: true });
      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(result.body, { ok: true });
    } finally {
      server.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// PROBE_TASKS registry
// ────────────────────────────────────────────────────────────

describe('PROBE_TASKS', () => {
  it('includes the three synthetic security tasks', () => {
    assert.ok(PROBE_TASKS.has('protected_resource_metadata'));
    assert.ok(PROBE_TASKS.has('oauth_auth_server_metadata'));
    assert.ok(PROBE_TASKS.has('assert_contribution'));
  });
});

// ────────────────────────────────────────────────────────────
// New validation checks
// ────────────────────────────────────────────────────────────

function runOne(validations, ctx) {
  return runValidations(validations, {
    taskName: ctx.taskName ?? 'test',
    agentUrl: ctx.agentUrl ?? 'https://example.com/mcp',
    contributions: ctx.contributions ?? new Set(),
    httpResult: ctx.httpResult,
    taskResult: ctx.taskResult,
  });
}

describe('http_status / http_status_in', () => {
  it('http_status matches exact code', () => {
    const [ok] = runOne([{ check: 'http_status', value: 401, description: 'is 401' }], {
      httpResult: { url: '', status: 401, headers: {}, body: null },
    });
    assert.strictEqual(ok.passed, true);

    const [fail] = runOne([{ check: 'http_status', value: 401, description: 'is 401' }], {
      httpResult: { url: '', status: 200, headers: {}, body: null },
    });
    assert.strictEqual(fail.passed, false);
  });

  it('http_status_in matches any listed code', () => {
    const [ok] = runOne([{ check: 'http_status_in', allowed_values: [401, 403], description: 'unauthorized' }], {
      httpResult: { url: '', status: 403, headers: {}, body: null },
    });
    assert.strictEqual(ok.passed, true);

    const [fail] = runOne([{ check: 'http_status_in', allowed_values: [401, 403], description: 'unauthorized' }], {
      httpResult: { url: '', status: 500, headers: {}, body: null },
    });
    assert.strictEqual(fail.passed, false);
  });
});

describe('on_401_require_header', () => {
  it('passes when 401 includes the required header', () => {
    const [r] = runOne([{ check: 'on_401_require_header', value: 'www-authenticate', description: 'RFC 6750 §3' }], {
      httpResult: { url: '', status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' }, body: null },
    });
    assert.strictEqual(r.passed, true);
  });

  it('fails when 401 is missing the header', () => {
    const [r] = runOne([{ check: 'on_401_require_header', value: 'www-authenticate', description: 'RFC 6750 §3' }], {
      httpResult: { url: '', status: 401, headers: {}, body: null },
    });
    assert.strictEqual(r.passed, false);
    assert.match(r.error, /missing required header/);
  });

  it('silently passes on non-401 responses (conditional check)', () => {
    const [r] = runOne([{ check: 'on_401_require_header', value: 'www-authenticate', description: 'RFC 6750 §3' }], {
      httpResult: { url: '', status: 200, headers: {}, body: null },
    });
    assert.strictEqual(r.passed, true);
  });
});

describe('resource_equals_agent_url', () => {
  const agentUrl = 'https://agent.example.com/mcp';

  it('passes when resource matches agent URL exactly', () => {
    const [r] = runOne([{ check: 'resource_equals_agent_url', description: 'RFC 9728 resource' }], {
      agentUrl,
      httpResult: { url: '', status: 200, headers: {}, body: { resource: 'https://agent.example.com/mcp' } },
    });
    assert.strictEqual(r.passed, true);
  });

  it('passes after normalization (trailing slash, case)', () => {
    const [r] = runOne([{ check: 'resource_equals_agent_url', description: 'RFC 9728 resource' }], {
      agentUrl,
      httpResult: {
        url: '',
        status: 200,
        headers: {},
        body: { resource: 'HTTPS://Agent.Example.com/mcp/' },
      },
    });
    assert.strictEqual(r.passed, true);
  });

  it('fails on mismatch and does NOT echo the advertised value verbatim', () => {
    const [r] = runOne([{ check: 'resource_equals_agent_url', description: 'RFC 9728 resource' }], {
      agentUrl,
      httpResult: {
        url: '',
        status: 200,
        headers: {},
        body: { resource: 'https://auth.mismatch.example/mcp' },
      },
    });
    assert.strictEqual(r.passed, false);
    // Redacted error message — do not leak the advertised value into shareable reports.
    assert.doesNotMatch(r.error ?? '', /auth\.mismatch/);
  });

  it('fails when resource field missing', () => {
    const [r] = runOne([{ check: 'resource_equals_agent_url', description: 'RFC 9728 resource' }], {
      agentUrl,
      httpResult: { url: '', status: 200, headers: {}, body: {} },
    });
    assert.strictEqual(r.passed, false);
  });
});

describe('any_of (contribution accumulator)', () => {
  it('passes when any listed flag was contributed', () => {
    const [r] = runOne([{ check: 'any_of', allowed_values: ['api_key', 'oauth'], description: 'one auth path' }], {
      contributions: new Set(['oauth']),
    });
    assert.strictEqual(r.passed, true);
  });

  it('fails when no listed flag was contributed', () => {
    const [r] = runOne([{ check: 'any_of', allowed_values: ['api_key', 'oauth'], description: 'one auth path' }], {
      contributions: new Set(['something_else']),
    });
    assert.strictEqual(r.passed, false);
  });
});

// ────────────────────────────────────────────────────────────
// Validation context discrimination
// ────────────────────────────────────────────────────────────

describe('validation context discrimination', () => {
  it('fails clearly when an HTTP-only check runs against an MCP task result', () => {
    const [r] = runOne([{ check: 'http_status', value: 401, description: 'x' }], {
      taskResult: { success: true, data: {} },
    });
    assert.strictEqual(r.passed, false);
    assert.match(r.error, /HTTP probe/);
  });

  it('fails clearly when an MCP-only check runs against an HTTP probe result', () => {
    const [r] = runOne([{ check: 'field_present', path: 'foo', description: 'x' }], {
      httpResult: { url: '', status: 200, headers: {}, body: {} },
    });
    assert.strictEqual(r.passed, false);
    assert.match(r.error, /MCP task result/);
  });
});

// ────────────────────────────────────────────────────────────
// comply() HTTPS enforcement
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Credential generators
// ────────────────────────────────────────────────────────────

describe('generateRandomInvalidApiKey', () => {
  it('emits invalid-<32 hex bytes>', () => {
    const a = generateRandomInvalidApiKey();
    const b = generateRandomInvalidApiKey();
    assert.match(a, /^invalid-[0-9a-f]{64}$/);
    assert.notStrictEqual(a, b, 'values are random per call');
  });
});

describe('generateRandomInvalidJwt', () => {
  it('emits three base64url segments with valid JSON header/payload and random signature', () => {
    const token = generateRandomInvalidJwt();
    const parts = token.split('.');
    assert.strictEqual(parts.length, 3);
    // All three segments must be base64url-decodable.
    const b64urlToBuf = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    assert.strictEqual(header.alg, 'RS256');
    assert.strictEqual(header.typ, 'JWT');
    assert.match(payload.sub, /^invalid-/);
    assert.ok(b64urlToBuf(parts[2]).length >= 16, 'signature segment has bytes');
  });

  it('values are random per call', () => {
    assert.notStrictEqual(generateRandomInvalidJwt(), generateRandomInvalidJwt());
  });
});

// ────────────────────────────────────────────────────────────
// rawMcpProbe end-to-end
// ────────────────────────────────────────────────────────────

describe('rawMcpProbe', () => {
  it('sends JSON-RPC tools/call and surfaces HTTP status + body', async () => {
    let seenBody, seenAuth;
    const server = http.createServer(async (req, res) => {
      seenAuth = req.headers.authorization ?? null;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: seenBody.id,
          result: { structuredContent: { context: { correlation_id: 'abc' } } },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    try {
      const { httpResult, taskResult } = await rawMcpProbe({
        agentUrl: `http://127.0.0.1:${server.address().port}/mcp`,
        toolName: 'list_creatives',
        args: { page: 1 },
        headers: { authorization: 'Bearer sk_test' },
      });
      assert.strictEqual(httpResult.status, 200);
      assert.strictEqual(seenAuth, 'Bearer sk_test');
      assert.strictEqual(seenBody.method, 'tools/call');
      assert.strictEqual(seenBody.params.name, 'list_creatives');
      assert.deepStrictEqual(taskResult.data, { context: { correlation_id: 'abc' } });
    } finally {
      server.close();
    }
  });

  it('surfaces 401 + WWW-Authenticate from the agent', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="x", error="invalid_token"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise(r => server.listen(0, r));
    try {
      const { httpResult } = await rawMcpProbe({
        agentUrl: `http://127.0.0.1:${server.address().port}/mcp`,
        toolName: 'list_creatives',
        args: {},
      });
      assert.strictEqual(httpResult.status, 401);
      assert.match(httpResult.headers['www-authenticate'], /Bearer realm/);
    } finally {
      server.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// Runner: $test_kit.* substitution + auth override + optional phases
// ────────────────────────────────────────────────────────────

describe('storyboard runner: auth-override dispatch', () => {
  it('resolves $test_kit.auth.probe_task → task_default when kit lacks the field', async () => {
    // Build a throwaway MCP-like endpoint that records the tool name seen.
    let seenTool;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenTool = rpc.params.name;
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'test_sb',
        version: '1.0.0',
        title: 'Probe',
        category: 'security',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'probe',
            steps: [
              {
                id: 's1',
                title: 'unauth probe',
                task: '$test_kit.auth.probe_task',
                task_default: 'list_creatives',
                auth: 'none',
                expect_error: true,
                validations: [
                  { check: 'http_status_in', allowed_values: [401, 403], description: 'rejects unauth' },
                  { check: 'on_401_require_header', value: 'www-authenticate', description: 'RFC 6750 §3' },
                ],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['list_creatives'],
        _profile: { name: 'Test', tools: ['list_creatives'] },
        _client: { getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'list_creatives' }] }) },
      });
      assert.strictEqual(seenTool, 'list_creatives');
      assert.strictEqual(result.phases[0].steps[0].passed, true, JSON.stringify(result.phases[0].steps[0]));
      assert.strictEqual(result.overall_passed, true);
    } finally {
      server.close();
    }
  });

  it('auth: none sends no Authorization header; value_strategy: random_invalid sends a random key', async () => {
    const observed = [];
    const server = http.createServer((req, res) => {
      observed.push(req.headers.authorization ?? null);
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const { rawMcpProbe: probe } = require('../../dist/lib/testing/storyboard/probes');
      await probe({ agentUrl, toolName: 'list_creatives', args: {} }); // no headers
      await probe({
        agentUrl,
        toolName: 'list_creatives',
        args: {},
        headers: { authorization: `Bearer ${generateRandomInvalidApiKey()}` },
      });
      // req.headers.authorization is undefined when absent; the server logs ?? null.
      assert.strictEqual(observed[0], null, 'first call has no Authorization');
      assert.match(observed[1], /^Bearer invalid-[0-9a-f]{64}$/);
    } finally {
      server.close();
    }
  });

  it('phase optional: true failures do not fail overall pass', async () => {
    // Three-step storyboard:
    //   Phase A (optional): one step that passes and contributes a flag,
    //                       one step that fails (auth probe against a 500 server).
    //   Phase B (required): assert_contribution checks the flag contributed in A.
    // Overall must pass despite Phase A's failing step.
    const server = http.createServer((_, res) => {
      res.writeHead(500);
      res.end('{}');
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'opt_sb',
        version: '1.0.0',
        title: 'Optional',
        category: 'security',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'opt',
            title: 'opt',
            optional: true,
            steps: [
              {
                id: 'contributes',
                title: 'marker',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                contributes_to: 'flagged',
                validations: [
                  {
                    check: 'http_status',
                    value: 500,
                    description: 'server is a 500 stub; we just need this step to pass so it contributes the flag',
                  },
                ],
              },
              {
                id: 'doomed',
                title: 'doomed',
                task: 'list_creatives',
                auth: 'none',
                validations: [
                  { check: 'http_status', value: 200, description: 'stub returns 500 — this fails on purpose' },
                ],
              },
            ],
          },
          {
            id: 'req',
            title: 'req',
            steps: [
              {
                id: 'gate',
                title: 'gate',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['flagged'], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['list_creatives'],
        _profile: { name: 'T', tools: ['list_creatives'] },
        _client: { getAgentInfo: async () => ({ name: 'T', tools: [{ name: 'list_creatives' }] }) },
      });
      assert.strictEqual(result.phases[0].passed, false, 'optional phase has a failing step');
      assert.strictEqual(result.phases[1].passed, true, 'required phase passes via accumulated flag');
      assert.strictEqual(
        result.overall_passed,
        true,
        'overall still passes because optional phase failures do not gate'
      );
    } finally {
      server.close();
    }
  });
});

describe('comply() HTTPS enforcement', () => {
  it('refuses http:// agent URLs by default', async () => {
    await assert.rejects(
      () => comply('http://agent.example.com/mcp', {}),
      /Refusing to run compliance against a non-HTTPS URL/
    );
  });

  it('allows http:// when allow_http: true is set', async () => {
    // We don't care about the downstream failure (no agent is listening); we
    // just need to prove we got past the HTTPS gate.
    try {
      await comply('http://127.0.0.1:1/mcp', { allow_http: true });
    } catch (err) {
      assert.doesNotMatch(err.message, /Refusing to run compliance against a non-HTTPS URL/);
    }
  });
});
