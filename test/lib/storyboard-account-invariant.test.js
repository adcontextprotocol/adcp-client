/**
 * Storyboard runner: account invariant and omit_account escape hatch.
 *
 * Issue #1696 — PR #1683 removed the account_from_brand fabrication shim so
 * create_media_buy calls that omit `account` now throw ValidationError at the
 * client boundary before any wire call. This breaks schema_validation storyboard
 * steps that deliberately test seller-side missing-account rejection: the
 * client-side throw short-circuits before the wire call so the conformance
 * grader can't observe the seller's response.
 *
 * `omit_account: true` on a StoryboardStep suppresses both layers:
 * - `applyBrandInvariant` in the runner (account synthesis / natural-key merge)
 * - `normalizeRequestParams` + `validateRequest` in the SDK client
 * - The raw-probe defense-in-depth path (for non-A2A) so no SDK layer can
 *   silently re-inject an account before the wire call.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  applyBrandInvariant,
  runStoryboard,
} = require('../../dist/lib/testing/storyboard/runner.js');

// ────────────────────────────────────────────────────────────
// Unit: applyBrandInvariant omit_account flag
// ────────────────────────────────────────────────────────────

describe('applyBrandInvariant: omit_account step flag', () => {
  const options = {
    brand: { name: 'Acme', domain: 'acme.com' },
  };

  test('when omit_account=true, skips synthetic account construction (else-branch)', () => {
    const result = applyBrandInvariant({ packages: [] }, options, 'create_media_buy', {
      omit_account: true,
    });
    assert.strictEqual(result.account, undefined, 'account must not be synthesised when omit_account=true');
    assert.deepStrictEqual(result.brand, options.brand, 'brand injection must still occur');
  });

  test('when omit_account=true, skips natural-key merge (if-branch with existing account)', () => {
    const request = {
      account: { brand: { name: 'Acme', domain: 'acme.com' }, operator: 'agency.com' },
      packages: [],
    };
    const result = applyBrandInvariant(request, options, 'create_media_buy', { omit_account: true });
    // Natural-key merge would overwrite account with {brand, operator, ...merged}.
    // With omit_account=true the account must be unchanged.
    assert.deepStrictEqual(
      result.account,
      request.account,
      'existing account must not be merged when omit_account=true'
    );
  });

  test('when omit_account=false (default), synthesises account as normal', () => {
    const result = applyBrandInvariant({ packages: [] }, options, 'create_media_buy');
    assert.ok(result.account, 'account should be synthesised when omit_account is unset');
  });

  test('when omit_account=false, performs natural-key merge as normal', () => {
    const request = {
      account: { brand: { name: 'Acme', domain: 'acme.com' }, operator: 'agency.com' },
      packages: [],
    };
    const result = applyBrandInvariant(request, options, 'create_media_buy', { omit_account: false });
    assert.ok(result.account, 'account should be present after merge');
    // The merged account should carry brand from options
    assert.deepStrictEqual(result.account.brand, options.brand, 'brand should be merged into natural-key account');
  });

  test('does not mutate the input request', () => {
    const request = { packages: [] };
    applyBrandInvariant(request, options, 'create_media_buy', { omit_account: true });
    assert.strictEqual(request.account, undefined, 'input must not be mutated');
  });
});

// ────────────────────────────────────────────────────────────
// Integration: wire-level omit_account behavior
// ────────────────────────────────────────────────────────────

describe('runStoryboard: omit_account wire-level behavior', () => {
  it('leaves account absent on the wire when step.omit_account=true so the seller sees the missing-account request', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: 'INVALID_REQUEST: account is required' },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'missing_account_sb',
        version: '1.0.0',
        title: 'Missing account',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'schema_validation',
            steps: [
              {
                id: 's1_missing_account',
                title: 'compliance step: missing account must be rejected by seller',
                task: 'create_media_buy',
                auth: 'none',
                expect_error: true,
                omit_account: true,
                sample_request: {
                  brand: { name: 'Acme', domain: 'acme.com' },
                  packages: [],
                },
                validations: [],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        brand: { name: 'Acme', domain: 'acme.com' },
        agentTools: ['create_media_buy'],
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.strictEqual(
        seen[0].args.account,
        undefined,
        'omit_account step must not receive auto-injected account — seller must see the missing-account request'
      );
    } finally {
      server.close();
    }
  });

  it('auto-injects account via applyBrandInvariant on normal create_media_buy steps (omit_account absent)', async () => {
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
        id: 'normal_account_sb',
        version: '1.0.0',
        title: 'Normal account injection',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'buy',
            steps: [
              {
                id: 's1_create_buy',
                title: 'create_media_buy without omit_account must carry account',
                task: 'create_media_buy',
                auth: 'none',
                sample_request: {
                  brand: { name: 'Acme', domain: 'acme.com' },
                  packages: [],
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
        brand: { name: 'Acme', domain: 'acme.com' },
        agentTools: ['create_media_buy'],
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.ok(seen[0].args.account, 'normal create_media_buy step must carry an auto-injected account');
    } finally {
      server.close();
    }
  });

  it('bypasses the SDK via raw probe when omit_account=true (defense-in-depth for SDK account injection)', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({
        name: rpc.params.name,
        args: rpc.params.arguments,
        authorization: req.headers['authorization'],
      });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: 'INVALID_REQUEST: account is required' },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'raw_probe_account_sb',
        version: '1.0.0',
        title: 'Raw probe: missing account (bearer auth)',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'error',
            steps: [
              {
                id: 's1_bearer_missing_account',
                title: 'bearer-authenticated missing-account vector must reach the server',
                task: 'create_media_buy',
                expect_error: true,
                omit_account: true,
                sample_request: {
                  brand: { name: 'Acme', domain: 'acme.com' },
                  packages: [],
                },
                validations: [],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        auth: { type: 'bearer', token: 'tok-1696' },
        brand: { name: 'Acme', domain: 'acme.com' },
        agentTools: ['create_media_buy'],
        _profile: { name: 'Test', tools: ['create_media_buy'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_media_buy' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.strictEqual(
        seen[0].args.account,
        undefined,
        'SDK-layer normalization must not inject account when omit_account=true'
      );
      assert.strictEqual(
        seen[0].authorization,
        'Bearer tok-1696',
        'raw probe must forward the bearer token'
      );
    } finally {
      server.close();
    }
  });
});
