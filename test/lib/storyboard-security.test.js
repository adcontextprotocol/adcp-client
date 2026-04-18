const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { fetchProbe, isPrivateIp, PROBE_TASKS } = require('../../dist/lib/testing/storyboard/probes');
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
