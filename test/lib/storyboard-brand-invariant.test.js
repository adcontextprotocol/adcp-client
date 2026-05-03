/**
 * Storyboard runner: brand/account invariant.
 *
 * Issue #579 — sellers that scope session state by brand lost cross-step
 * state when a create step sent `brand: acmeoutdoor.example` but a follow-up
 * get/update/delete step either omitted brand or let it default to
 * `test.example`. The runner now overrides brand on every outgoing request
 * after builder / sample_request resolution so a storyboard run lands in one
 * session, regardless of per-tool authorship.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { applyBrandInvariant, runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const BRAND = { domain: 'acmeoutdoor.example' };

describe('applyBrandInvariant', () => {
  test('injects brand when the request omits it', () => {
    const result = applyBrandInvariant({ list_id: 'pl-1' }, { brand: BRAND });
    assert.deepStrictEqual(result.brand, BRAND);
    assert.strictEqual(result.list_id, 'pl-1');
  });

  test('overrides a conflicting brand so every step shares one session', () => {
    const result = applyBrandInvariant({ brand: { domain: 'other.example' }, list_id: 'pl-1' }, { brand: BRAND });
    assert.deepStrictEqual(result.brand, BRAND);
  });

  test('fills in account.brand when the request carries an account', () => {
    const result = applyBrandInvariant(
      { account: { operator: 'acmeoutdoor.example' }, list_id: 'pl-1' },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account, { operator: 'acmeoutdoor.example', brand: BRAND });
  });

  test('overrides a conflicting account.brand', () => {
    const result = applyBrandInvariant(
      { account: { brand: { domain: 'other.example' }, operator: 'other.example' } },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account.brand, BRAND);
  });

  test('passes through when no brand is configured (e.g. security probes)', () => {
    const input = { list_id: 'pl-1' };
    const result = applyBrandInvariant(input, {});
    assert.strictEqual(result, input);
  });

  test('resolves brand from brand_manifest when brand is not set', () => {
    const result = applyBrandInvariant(
      { list_id: 'pl-1' },
      { brand_manifest: { name: 'Acme', url: 'https://acmeoutdoor.example' } }
    );
    assert.deepStrictEqual(result.brand, { domain: 'acmeoutdoor.example' });
  });

  test('leaves non-object account values alone', () => {
    const result = applyBrandInvariant({ account: null }, { brand: BRAND });
    assert.strictEqual(result.account, null);
  });

  test('leaves array account values alone (malformed but possible)', () => {
    const account = [];
    const result = applyBrandInvariant({ account }, { brand: BRAND });
    assert.strictEqual(result.account, account);
  });

  test('constructs account when the request omits it, so tools whose schema declares account but not top-level brand still carry the run-scoped brand on the wire (get_media_buys, list_creatives, etc.)', () => {
    const result = applyBrandInvariant({ list_id: 'pl-1' }, { brand: BRAND });
    assert.deepStrictEqual(result.account, { brand: BRAND, operator: BRAND.domain, sandbox: undefined });
    assert.deepStrictEqual(result.brand, BRAND);
  });

  test('passes sandbox through into the constructed account when options.sandbox is set', () => {
    const result = applyBrandInvariant({ list_id: 'pl-1' }, { brand: BRAND, sandbox: true });
    assert.deepStrictEqual(result.account, { brand: BRAND, operator: BRAND.domain, sandbox: true });
  });

  test('does not mutate the input request', () => {
    const input = { account: { operator: 'x' }, list_id: 'pl-1' };
    applyBrandInvariant(input, { brand: BRAND });
    assert.deepStrictEqual(input, { account: { operator: 'x' }, list_id: 'pl-1' });
  });

  // ── Schema-aware injection (#940) ──────────────────────────
  // When taskName is omitted, the function fails open (injects as before).
  // When taskName is provided, it consults the request schema to decide
  // which fields to inject. Tests below assert both directions (allowed
  // and forbidden) against tools whose schemas are stable and ship in the
  // package.

  test('fails open (injects brand and account) when taskName is omitted — backwards compat', () => {
    const result = applyBrandInvariant({ plans: [] }, { brand: BRAND });
    assert.deepStrictEqual(result.brand, BRAND, 'brand should be injected when no taskName');
    assert.ok('account' in result, 'synthetic account should be injected when no taskName');
  });

  describe('with synced schemas', () => {
    let schemaAllowsTopLevelField;
    test('preconditions: schema-loader exports schemaAllowsTopLevelField', async () => {
      const mod = await import('../../dist/lib/validation/schema-loader.js');
      schemaAllowsTopLevelField = mod.schemaAllowsTopLevelField;
      assert.strictEqual(typeof schemaAllowsTopLevelField, 'function');
    });

    // Pin the schema invariants this test suite depends on. If a schema
    // drifts (e.g. `sync_plans` adds `brand` or `get_products` removes it),
    // these assertions fail loudly rather than silently disarm the
    // behavior tests below.
    test('preconditions: schema shapes match expectations', () => {
      assert.strictEqual(
        schemaAllowsTopLevelField('sync_plans', 'brand'),
        false,
        'sync_plans must declare additionalProperties:false and exclude brand'
      );
      assert.strictEqual(
        schemaAllowsTopLevelField('sync_plans', 'account'),
        false,
        'sync_plans must declare additionalProperties:false and exclude account'
      );
      assert.strictEqual(
        schemaAllowsTopLevelField('list_property_lists', 'brand'),
        false,
        'list_property_lists must declare additionalProperties:false and exclude brand'
      );
      assert.strictEqual(
        schemaAllowsTopLevelField('list_property_lists', 'account'),
        true,
        'list_property_lists must declare account at the request root'
      );
      assert.strictEqual(
        schemaAllowsTopLevelField('get_products', 'brand'),
        true,
        'get_products must declare brand at the request root (positive control)'
      );
    });

    test('skips top-level brand and synthetic account for sync_plans', () => {
      const result = applyBrandInvariant({ idempotency_key: 'k', plans: [] }, { brand: BRAND }, 'sync_plans');
      assert.strictEqual(result.brand, undefined, 'brand must not be injected for sync_plans');
      assert.strictEqual(result.account, undefined, 'synthetic account must not be injected for sync_plans');
      assert.deepStrictEqual(result.idempotency_key, 'k', 'original fields must be preserved');
      assert.deepStrictEqual(result.plans, [], 'original fields must be preserved');
    });

    test('skips top-level brand but keeps synthetic account for list_property_lists', () => {
      const result = applyBrandInvariant({}, { brand: BRAND }, 'list_property_lists');
      assert.strictEqual(result.brand, undefined, 'brand must not be injected for list_property_lists');
      assert.ok('account' in result, 'synthetic account IS allowed for list_property_lists');
    });

    test('injects top-level brand for get_products (positive control)', () => {
      const result = applyBrandInvariant({}, { brand: BRAND }, 'get_products');
      assert.deepStrictEqual(result.brand, BRAND, 'brand must be injected for get_products');
    });
  });

  // ── AccountReference oneOf safety ──────────────────────────
  // AccountReference is `oneOf` of `{account_id}` (closed) or
  // `{brand, operator, sandbox?}`. Merging brand into an `{account_id}`
  // payload produces an object that matches neither branch under strict
  // AJV validation. Storyboards (e.g. creative-ad-server/list_creatives)
  // legitimately address accounts via `account_id`, so the runner must
  // leave those payloads untouched.

  test('leaves an {account_id}-branch account untouched (no brand merge)', () => {
    const result = applyBrandInvariant(
      { account: { account_id: 'acct_acme_creative' }, include_pricing: true },
      { brand: BRAND }
    );
    assert.deepStrictEqual(
      result.account,
      { account_id: 'acct_acme_creative' },
      'must not inject brand into a closed {account_id} AccountReference'
    );
  });

  test('merges brand into a natural-key account that carries operator only', () => {
    const result = applyBrandInvariant({ account: { operator: 'pinnacle-agency.example' } }, { brand: BRAND });
    assert.deepStrictEqual(result.account, { operator: 'pinnacle-agency.example', brand: BRAND });
  });

  // Issue #1419 — natural-key arm of AccountReference requires `operator`.
  // A fixture or sync_accounts extractor that produced `{brand, sandbox}`
  // without operator would otherwise pass through and be rejected by a
  // strict-validating seller. The merge must default operator to brand.domain.
  test('fills in operator when the natural-key account omits it (#1419)', () => {
    const result = applyBrandInvariant(
      { account: { brand: { domain: 'other.example' }, sandbox: true } },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account, {
      brand: BRAND,
      operator: BRAND.domain,
      sandbox: true,
    });
  });

  test('merges brand into a natural-key account that already carries brand', () => {
    const result = applyBrandInvariant(
      { account: { brand: { domain: 'other.example' }, operator: 'pinnacle-agency.example' } },
      { brand: BRAND }
    );
    assert.deepStrictEqual(result.account.brand, BRAND, 'natural-key brand should be overridden');
    assert.strictEqual(result.account.operator, 'pinnacle-agency.example');
  });
});

// ────────────────────────────────────────────────────────────
// Integration: runner call-site regression
// ────────────────────────────────────────────────────────────

/**
 * Reproduces the wire-level signature of issue #579: three steps in a run
 * that each try to set a different brand (via sample_request, via context,
 * and via omission). Before the fix, the outgoing MCP `tools/call` would
 * carry three different brand domains. After the fix, all three must
 * converge on `options.brand`. This catches regressions that move or drop
 * the `applyBrandInvariant` call in `executeStep` even when the helper
 * itself still behaves correctly.
 */
describe('runStoryboard: brand invariant on the wire', () => {
  it('sends options.brand on every step regardless of sample_request authorship', async () => {
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
        id: 'brand_invariant_sb',
        version: '1.0.0',
        title: 'Brand invariant',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'crud',
            steps: [
              {
                id: 's1_sample_with_different_brand',
                title: 'sample_request carries a different brand',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                sample_request: {
                  account: { brand: { domain: 'other.example' }, operator: 'other.example' },
                },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
              {
                id: 's2_sample_omits_brand',
                title: 'sample_request omits brand entirely',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                sample_request: { list_id: 'pl-1' },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
              {
                id: 's3_builder_path',
                title: 'builder constructs account from options',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        brand: BRAND,
        agentTools: ['list_creatives'],
        _profile: { name: 'Test', tools: ['list_creatives'] },
        _client: { getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'list_creatives' }] }) },
      });

      assert.strictEqual(seen.length, 3, `expected 3 tool calls, got ${seen.length}`);
      for (const call of seen) {
        assert.deepStrictEqual(call.args.brand, BRAND, `step ${call.name} brand diverged`);
        if (call.args.account && typeof call.args.account === 'object' && !Array.isArray(call.args.account)) {
          assert.deepStrictEqual(call.args.account.brand, BRAND, 'account.brand diverged');
        }
      }
    } finally {
      server.close();
    }
  });
});
