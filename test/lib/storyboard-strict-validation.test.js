/**
 * Strict/lenient response-schema validation + run-level aggregation (issue
 * #820, fourth proposal). `runValidations` must attach an AJV-based strict
 * verdict to every `response_schema` ValidationResult. Storyboard runs grade
 * the strict verdict by default; direct validation callers can keep it
 * informational, while an explicit external schema root is always
 * authoritative for current-source validation.
 *
 * Most tests hit the storyboard validation layer directly with a synthetic
 * `ValidationContext`; one runner-level regression locks the public default.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProtocolClient } = require('../../dist/lib/index.js');
const { createTestClient } = require('../../dist/lib/testing/client.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const {
  runStoryboardStep,
  summarizeStrictValidation,
  listStrictOnlyFailures,
} = require('../../dist/lib/testing/storyboard/runner.js');
const { _resetValidationLoader, withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader.js');

const EXTERNAL_VERSION = '9.9.0-beta.1';

function writeExternalResponseSchema(root, toolName, schema) {
  const bundled = path.join(root, 'bundled');
  fs.mkdirSync(bundled, { recursive: true });
  fs.writeFileSync(
    path.join(bundled, `${toolName.replaceAll('_', '-')}-response.json`),
    JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `/schemas/${EXTERNAL_VERSION}/test/${toolName.replaceAll('_', '-')}-response.json`,
      ...schema,
    })
  );
}

function ctx(taskName, data, responseSchemaRef) {
  return {
    taskName,
    taskResult: { data },
    agentUrl: 'http://agent.example/mcp',
    contributions: new Set(),
    responseSchemaRef,
  };
}

function ctxWith(taskName, data, responseSchemaRef, extra) {
  return { ...ctx(taskName, data, responseSchemaRef), ...extra };
}

function strictDeltaCapabilitiesStoryboard() {
  return {
    id: 'strict_response_default',
    version: '1.0.0',
    title: 'Strict response default',
    category: 'test',
    summary: 'Verifies strict response-schema grading defaults.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'capabilities',
        title: 'Capabilities',
        steps: [
          {
            id: 'discover',
            title: 'Discover capabilities',
            task: 'get_adcp_capabilities',
            response_schema_ref: 'protocol/get-adcp-capabilities-response.json',
            validations: [{ check: 'response_schema', description: 'response conforms' }],
          },
        ],
      },
    ],
  };
}

function withoutAuthoredValidations(storyboard) {
  const copy = structuredClone(storyboard);
  delete copy.phases[0].steps[0].validations;
  return copy;
}

describe('storyboard validations: strict/lenient response_schema delta', () => {
  test('external schemaRoot accepts current-source responses rejected by packaged Zod', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-authority-'));
    try {
      writeExternalResponseSchema(root, 'list_creative_formats', {
        type: 'object',
        required: ['current_source_marker'],
        properties: { current_source_marker: { const: true } },
        additionalProperties: false,
      });

      const [result] = withExternalSchemaRoot(EXTERNAL_VERSION, root, () =>
        runValidations(
          [{ check: 'response_schema', description: 'response conforms to current source' }],
          ctxWith('list_creative_formats', { current_source_marker: true }, 'test/list-response.json', {
            adcpVersion: EXTERNAL_VERSION,
          })
        )
      );

      assert.strictEqual(result.passed, true, result.error);
      assert.strictEqual(result.strict.valid, true);
      assert.strictEqual(result.strict.lenient_valid, false);
      assert.match(result.schema_id, new RegExp(`/schemas/${EXTERNAL_VERSION.replaceAll('.', '\\.')}/`));
    } finally {
      _resetValidationLoader(EXTERNAL_VERSION);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('external schemaRoot rejects packaged-Zod responses that current source disallows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-authority-'));
    try {
      writeExternalResponseSchema(root, 'list_creative_formats', {
        type: 'object',
        required: ['current_source_marker'],
        properties: { current_source_marker: { const: true } },
        additionalProperties: false,
      });

      const [result] = withExternalSchemaRoot(EXTERNAL_VERSION, root, () =>
        runValidations(
          [{ check: 'response_schema', description: 'response conforms to current source' }],
          ctxWith('list_creative_formats', { formats: [] }, 'test/list-response.json', {
            adcpVersion: EXTERNAL_VERSION,
          })
        )
      );

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.strict.valid, false);
      assert.strictEqual(result.strict.lenient_valid, true);
      assert.ok(result.actual.some(issue => issue.keyword === 'required'));

      const summary = summarizeStrictValidation([
        { phase_id: 'external', steps: [{ step_id: 'reject', task: 'list_creative_formats', validations: [result] }] },
      ]);
      assert.strictEqual(summary.strict_only_failures, 1);
      assert.strictEqual(summary.lenient_also_failed, 0);
    } finally {
      _resetValidationLoader(EXTERNAL_VERSION);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('external schemaRoot validates tools absent from the packaged Zod map', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-authority-'));
    try {
      writeExternalResponseSchema(root, 'future_protocol_tool', {
        type: 'object',
        required: ['future_value'],
        properties: { future_value: { type: 'string' } },
        additionalProperties: false,
      });

      const [result] = withExternalSchemaRoot(EXTERNAL_VERSION, root, () =>
        runValidations(
          [{ check: 'response_schema', description: 'future tool response conforms' }],
          ctxWith('future_protocol_tool', { future_value: 'same-change' }, 'test/future-tool-response.json', {
            adcpVersion: EXTERNAL_VERSION,
          })
        )
      );

      assert.strictEqual(result.passed, true, result.error);
      assert.strictEqual(result.strict.valid, true);
      assert.strictEqual(result.strict.lenient_valid, null);

      const [rejected] = withExternalSchemaRoot(EXTERNAL_VERSION, root, () =>
        runValidations(
          [{ check: 'response_schema', description: 'future tool response conforms' }],
          ctxWith('future_protocol_tool', { future_value: 42 }, 'test/future-tool-response.json', {
            adcpVersion: EXTERNAL_VERSION,
          })
        )
      );
      const summary = summarizeStrictValidation([
        { phase_id: 'external', steps: [{ step_id: 'future', task: 'future_protocol_tool', validations: [rejected] }] },
      ]);
      assert.strictEqual(summary.strict_only_failures, 0);
      assert.strictEqual(summary.lenient_also_failed, 0);
      assert.strictEqual(summary.lenient_unobserved, 1);
    } finally {
      _resetValidationLoader(EXTERNAL_VERSION);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('clean response: strict.valid=true, passed=true, no issues emitted', () => {
    // Minimal valid list_creative_formats response — `formats` is the only
    // required field at the root; an empty array satisfies both Zod and AJV.
    const response = { formats: [] };
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', response, 'creative/list-creative-formats-response.json')
    );
    assert.strictEqual(results.length, 1);
    const v = results[0];
    assert.strictEqual(v.passed, true, 'Zod path accepts');
    assert.ok(v.strict, 'strict verdict attached');
    assert.strictEqual(v.strict.valid, true, 'AJV path accepts');
    assert.strictEqual(v.strict.issues, undefined, 'no issues on a valid response');
  });

  test('strict grading fails a packaged-schema violation that lenient Zod accepts', () => {
    const response = {
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['media_buy'],
      // The JSON Schema requires at least one advertised scenario. The
      // generated Zod projection intentionally remains more permissive.
      compliance_testing: { scenarios: [] },
    };
    const [graded] = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctxWith('get_adcp_capabilities', response, 'protocol/get-adcp-capabilities-response.json', {
        adcpVersion: '3.1.18',
        strictResponseSchemaValidation: true,
      })
    );

    assert.strictEqual(graded.strict.lenient_valid, true);
    assert.strictEqual(graded.strict.valid, false);
    assert.strictEqual(graded.passed, false);
    assert.match(graded.error, /compliance_testing\/scenarios/);

    const [diagnostic] = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctxWith('get_adcp_capabilities', response, 'protocol/get-adcp-capabilities-response.json', {
        strictResponseSchemaValidation: false,
      })
    );
    assert.strictEqual(diagnostic.passed, true, 'explicit opt-out preserves the diagnostic-only grade');
    assert.match(diagnostic.warning, /strict JSON-schema rejected/);
  });

  test('storyboard runner grades strict response schemas by default and honors the opt-out', async () => {
    const response = {
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['media_buy'],
      compliance_testing: { scenarios: [] },
    };
    const client = {
      async getAdcpCapabilities() {
        return { status: 'completed', data: response };
      },
    };
    const profile = {
      name: 'Strict response stub',
      tools: ['get_adcp_capabilities'],
      raw_capabilities: response,
    };
    const options = { protocol: 'mcp', _client: client, _profile: profile };

    const graded = await runStoryboardStep(
      'https://stub.example/mcp',
      strictDeltaCapabilitiesStoryboard(),
      'discover',
      options
    );
    const gradedSchema = graded.validations.find(v => v.check === 'response_schema');
    assert.strictEqual(gradedSchema.strict.lenient_valid, true);
    assert.strictEqual(gradedSchema.strict.valid, false);
    assert.strictEqual(gradedSchema.passed, false);
    assert.strictEqual(graded.passed, false);

    const diagnostic = await runStoryboardStep(
      'https://stub.example/mcp',
      strictDeltaCapabilitiesStoryboard(),
      'discover',
      { ...options, strictResponseSchemaValidation: false }
    );
    const diagnosticSchema = diagnostic.validations.find(v => v.check === 'response_schema');
    assert.strictEqual(diagnosticSchema.passed, true);
    assert.strictEqual(diagnostic.passed, true);
  });

  test('test client enforces strict responses when a step has no authored response_schema check', async () => {
    const response = {
      status: 'completed',
      // Missing required idempotency proves transport-level strict validation
      // protects steps that do not author a response_schema validation.
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      compliance_testing: { scenarios: ['seller_custom_fixture_reset'] },
    };
    const profile = {
      name: 'Strict response stub',
      tools: ['get_adcp_capabilities'],
      raw_capabilities: response,
    };
    const storyboard = withoutAuthoredValidations(strictDeltaCapabilitiesStoryboard());
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async () => response;

    try {
      const strictClient = createTestClient('https://stub.example/mcp');
      strictClient.client.discoveredEndpoint = 'https://stub.example/mcp';
      const graded = await runStoryboardStep('https://stub.example/mcp', storyboard, 'discover', {
        protocol: 'mcp',
        _client: strictClient,
        _profile: profile,
      });
      assert.strictEqual(graded.passed, false);
      assert.match(graded.error, /Schema validation failed.*idempotency/);

      const diagnosticClient = createTestClient('https://stub.example/mcp', 'mcp', {
        strictResponseSchemaValidation: false,
      });
      diagnosticClient.client.discoveredEndpoint = 'https://stub.example/mcp';
      const diagnostic = await runStoryboardStep('https://stub.example/mcp', storyboard, 'discover', {
        protocol: 'mcp',
        strictResponseSchemaValidation: false,
        _client: diagnosticClient,
        _profile: profile,
      });
      assert.strictEqual(diagnostic.passed, true);
      assert.strictEqual(
        diagnostic.validations.some(v => v.check === 'response_schema'),
        false
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('implementation-specific compliance scenario strings pass strict validation', () => {
    const response = {
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['media_buy'],
      compliance_testing: { scenarios: ['seller_custom_fixture_reset'] },
    };
    const [result] = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctxWith('get_adcp_capabilities', response, 'protocol/get-adcp-capabilities-response.json', {
        adcpVersion: '3.1.18',
        strictResponseSchemaValidation: true,
      })
    );

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.strict.valid, true);
    assert.strictEqual(result.strict.lenient_valid, true);
  });

  test('response missing a required field: Zod and AJV both fail; strict.valid=false', () => {
    // list_creative_formats requires `formats` per the response schema.
    // Emitting `{}` fails both Zod and AJV.
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', {}, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, false, 'Zod rejects — step fails');
    assert.ok(v.strict, 'strict verdict attached on failed step too');
    assert.strictEqual(v.strict.valid, false);
    assert.ok(Array.isArray(v.strict.issues), 'strict issues list present');
    assert.ok(v.strict.issues.length > 0, 'at least one AJV issue');
    for (const issue of v.strict.issues) {
      assert.ok(issue.keyword, 'every AJV issue carries a keyword');
      assert.ok(typeof issue.message === 'string', 'every AJV issue has a message');
    }
  });

  test('server-declared 3.0 get_products response may omit 3.1 cache_scope without echoing version', () => {
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctxWith('get_products', { products: [] }, 'media-buy/get-products-response.json', {
        responseAdcpVersion: '3.0',
      })
    );
    const v = results[0];
    assert.strictEqual(v.passed, true, v.error);
    if (v.strict) assert.strictEqual(v.strict.valid, true, 'strict validation must not apply 3.1 cache_scope');
  });

  test('current 3.1 get_products response still requires cache_scope', () => {
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('get_products', { products: [] }, 'media-buy/get-products-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, false);
    assert.match(v.error, /cache_scope/);
  });

  test('generated Zod and strict AJV both reject a bad URI', () => {
    // URI formats are now enforced in generated Zod schemas as well as the
    // strict AJV pass. This used to be the canonical strictness-delta fixture;
    // retaining it as a parity regression guard prevents the lenient path
    // from silently accepting malformed portable identifiers again.
    const response = {
      formats: [
        {
          // agent_url is declared `format: uri` per core/format-id.json.
          // "not-a-uri" fails both generated Zod and AJV URI validation.
          format_id: { agent_url: 'not-a-uri', id: 'display_static' },
          name: 'Display Static',
          description: 'Static display format',
          assets: [],
        },
      ],
    };
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', response, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, false, 'generated Zod rejects the bare string');
    assert.match(v.error, /agent_url|URL|url|uri/i);
    assert.ok(v.strict);
    assert.strictEqual(v.strict.valid, false, 'AJV rejects bare string where format: uri is required');
    assert.ok(v.strict.issues);
    const hasFormat = v.strict.issues.some(i => i.keyword === 'format');
    assert.ok(hasFormat, `expected a format issue, got: ${JSON.stringify(v.strict.issues)}`);
    assert.strictEqual(v.warning, undefined, 'the primary Zod failure already carries the diagnostic');
  });

  test('URI parity failure preserves authored validation id', () => {
    const response = {
      formats: [
        {
          format_id: { agent_url: 'not-a-uri', id: 'display_static' },
          name: 'Display Static',
          description: 'Static display format',
          assets: [],
        },
      ],
    };
    const results = runValidations(
      [{ id: 'check_format_agent_url_uri', check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', response, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, false);
    assert.strictEqual(v.warning, undefined);
    assert.strictEqual(v.id, 'check_format_agent_url_uri');
  });

  test('warning absent when both Zod and AJV pass cleanly', () => {
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', { formats: [] }, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, true);
    assert.ok(v.strict && v.strict.valid);
    assert.strictEqual(v.warning, undefined, 'no warning on a clean pass');
  });

  test('warning absent when Zod rejects (failure already carries error)', () => {
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', {}, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.passed, false);
    assert.ok(typeof v.error === 'string', 'error message populated by the Zod failure path');
    assert.strictEqual(v.warning, undefined, 'warning reserved for the strict-only case');
  });

  test('variant fallback surfaces as a warning when the tool has no async schema', () => {
    // `list_creative_formats` has no async-response-working schema, so an
    // agent advertising `status: "working"` triggers the sync-fallback
    // validation path. AJV may still accept, but the conformance signal
    // — "agent advertised an async shape the tool hasn't schema'd" — is
    // otherwise invisible. Warning surfaces it with the requested variant
    // named so the author knows what to author.
    const response = { status: 'working', formats: [] };
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', response, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.ok(v.strict, 'strict verdict attached');
    assert.strictEqual(v.strict.variant_fallback_applied, true, 'fallback flag set');
    assert.strictEqual(v.strict.requested_variant, 'working', 'requested variant recorded');
    assert.strictEqual(v.strict.variant, 'sync', 'AJV validated against sync after fallback');
    assert.ok(typeof v.warning === 'string', 'warning surfaces the fallback');
    assert.match(v.warning, /status="working"/);
    assert.match(v.warning, /sync fallback/);
  });

  test('no AJV schema registered: strict verdict absent (not a failure)', () => {
    // Schemas outside both `bundled/` and the flat per-domain trees — e.g.
    // a custom tool the consumer registered through their own storyboard
    // without shipping a JSON schema — don't get an AJV validator. The
    // runner must NOT emit a strict verdict in that case; there's no
    // signal to report. The lenient Zod path is also absent for such
    // tasks (no Zod schema), so the validation falls through with
    // passed=false and no strict field.
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('custom_consumer_tool_without_schema', { any: 'payload' }, 'custom/custom-tool-response.json')
    );
    const v = results[0];
    assert.strictEqual(v.strict, undefined, 'no strict verdict when AJV has no schema for this task');
  });

  test('warning groups `required` keyword issues under their parent path', () => {
    // A handler that returns multiple incomplete reporting_capabilities
    // objects (missing several required fields each). Without grouping a
    // seller iterates once per missing field — the classic N-round onramp
    // cliff. The warning should list all missing fields under their
    // instance_path in a single pass.
    const response = {
      products: [
        {
          product_id: 'prod_1',
          name: 'Test',
          description: 'Test product',
          publisher_properties: [{ publisher_domain: 'x.example', selection_type: 'all' }],
          channels: ['display'],
          format_ids: [{ agent_url: 'https://creatives.adcontextprotocol.org', id: 'display_static' }],
          delivery_type: 'non_guaranteed',
          pricing_options: [
            {
              pricing_option_id: 'po_cpm',
              pricing_model: 'cpm',
              fixed_price: 5,
              currency: 'USD',
              min_spend_per_package: 500,
            },
          ],
          // reporting_capabilities is missing multiple required fields
          reporting_capabilities: {
            available_metrics: ['impressions'],
          },
        },
      ],
    };
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('get_products', response, 'media-buy/get-products-response.json')
    );
    const v = results[0];
    if (v.strict && v.strict.valid === false && typeof v.warning === 'string') {
      // When AJV reports missing required fields, the warning groups them by
      // instance_path so the seller sees all missing fields in one pass.
      // Expected shape: `strict JSON-schema missing required at <path>: a, b, c`
      assert.match(
        v.warning,
        /missing required at \/products\/0\/reporting_capabilities: [a-z_]+(, [a-z_]+)+/,
        `expected grouped required-fields in warning, got: ${v.warning}`
      );
    }
  });

  test('strict verdict caps issues at 10 (diagnostic stability)', () => {
    // A pathological response with many simultaneously-invalid siblings
    // exercises AJV's cascade mode — every bad format_id.agent_url surfaces
    // as its own issue. Without the cap the result object would bloat
    // proportionally to the payload size; with it, consumers get the first
    // 10 signals and a predictable size. Fifteen entries ensures the cap
    // trips even if AJV dedupes in some future version.
    const response = {
      formats: Array.from({ length: 15 }, (_, i) => ({
        format_id: { agent_url: `not-a-uri-${i}`, id: `fmt_${i}` },
        name: `Format ${i}`,
        description: 'bad URI on every entry',
        assets: [],
      })),
    };
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('list_creative_formats', response, 'creative/list-creative-formats-response.json')
    );
    const v = results[0];
    assert.ok(v.strict, 'strict verdict attached');
    assert.strictEqual(v.strict.valid, false);
    assert.ok(v.strict.issues, 'issues list present');
    assert.ok(v.strict.issues.length <= 10, `expected ≤ 10 issues, got ${v.strict.issues.length}`);
    assert.strictEqual(v.strict.issues.length, 10, 'cap should trip with 15 violations on the wire');
  });
});

// ─────────────────────────────────────────────────────────────
// Run-level strict_validation_summary aggregation (issue #820)
// ─────────────────────────────────────────────────────────────

function makePhase(steps) {
  return { phase_id: 'p1', phase_title: 't', passed: true, steps, duration_ms: 0 };
}

function makeStep(validations) {
  return {
    step_id: 's',
    phase_id: 'p1',
    title: 't',
    task: 'list_creative_formats',
    passed: true,
    duration_ms: 0,
    validations,
    context: {},
    extraction: { path: 'none' },
  };
}

describe('summarizeStrictValidation: run-level aggregation', () => {
  test('observable: false when no response_schema validation has a strict verdict', () => {
    // A run that only exercises non-schema checks (field_present, etc.)
    // emits no strict signal; the summary is still present with
    // `observable: false` so dashboards can distinguish "unobservable"
    // from "strict-clean with zero findings".
    const phases = [makePhase([makeStep([{ check: 'field_present', passed: true, description: 'x' }])])];
    assert.deepStrictEqual(summarizeStrictValidation(phases), {
      observable: false,
      checked: 0,
      passed: 0,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    });
  });

  test('counts a run with all-clean strict verdicts', () => {
    const phases = [
      makePhase([
        makeStep([
          { check: 'response_schema', passed: true, description: 'x', strict: { valid: true, variant: 'sync' } },
        ]),
        makeStep([
          { check: 'response_schema', passed: true, description: 'y', strict: { valid: true, variant: 'sync' } },
        ]),
      ]),
    ];
    assert.deepStrictEqual(summarizeStrictValidation(phases), {
      observable: true,
      checked: 2,
      passed: 2,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    });
  });

  test('counts strict_only_failures (lenient-pass ∧ strict-fail) — the #820 signal', () => {
    // Canonical #820 case: agent passes Zod but slips past AJV (format or
    // pattern violation). `strict_only_failures` counts exactly these.
    const phases = [
      makePhase([
        makeStep([
          {
            check: 'response_schema',
            passed: true,
            description: 'lenient accepts format violation',
            strict: {
              valid: false,
              variant: 'sync',
              issues: [
                {
                  instance_path: '/x/agent_url',
                  schema_path: '#',
                  keyword: 'format',
                  message: 'must match format uri',
                },
              ],
            },
          },
        ]),
      ]),
    ];
    assert.deepStrictEqual(summarizeStrictValidation(phases), {
      observable: true,
      checked: 1,
      passed: 0,
      failed: 1,
      strict_only_failures: 1,
      lenient_also_failed: 0,
    });
  });

  test('lenient_also_failed partitions failed from strict_only_failures', () => {
    // When the step already failed Zod (passed=false), strict-fail isn't
    // a new signal — the lenient path already blocked it. Counts against
    // `lenient_also_failed`, not `strict_only_failures`.
    const phases = [
      makePhase([
        makeStep([
          {
            check: 'response_schema',
            passed: false,
            description: 'both reject',
            strict: { valid: false, variant: 'sync', issues: [] },
          },
        ]),
      ]),
    ];
    assert.deepStrictEqual(summarizeStrictValidation(phases), {
      observable: true,
      checked: 1,
      passed: 0,
      failed: 1,
      strict_only_failures: 0,
      lenient_also_failed: 1,
    });
  });

  test('ignores checks without a strict verdict (no AJV schema)', () => {
    // response_schema validations whose task has no compiled AJV
    // validator don't contribute to the summary — they're invisible
    // to the strict/lenient signal.
    const phases = [
      makePhase([
        makeStep([
          { check: 'response_schema', passed: true, description: 'no ajv' }, // strict absent
          {
            check: 'response_schema',
            passed: true,
            description: 'has ajv',
            strict: { valid: true, variant: 'sync' },
          },
        ]),
      ]),
    ];
    assert.deepStrictEqual(summarizeStrictValidation(phases), {
      observable: true,
      checked: 1,
      passed: 1,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// listStrictOnlyFailures drill-down helper
// ─────────────────────────────────────────────────────────────

describe('listStrictOnlyFailures: drill-down into the #820 signal', () => {
  test('returns empty on runs with no strict-only failures', () => {
    const phases = [
      makePhase([
        makeStep([
          { check: 'response_schema', passed: true, description: 'clean', strict: { valid: true, variant: 'sync' } },
        ]),
      ]),
    ];
    assert.deepStrictEqual(listStrictOnlyFailures(phases), []);
  });

  test('flattens every strict-only failure with step / task / variant / issues', () => {
    const phases = [
      makePhase([
        makeStep([
          {
            check: 'response_schema',
            passed: true, // lenient accepted
            description: 'format violation',
            strict: {
              valid: false,
              variant: 'sync',
              issues: [
                {
                  instance_path: '/caller',
                  schema_path: '#/properties/caller/format',
                  keyword: 'format',
                  message: 'must match format "uri"',
                },
              ],
            },
          },
        ]),
      ]),
    ];
    const rows = listStrictOnlyFailures(phases);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].phase_id, 'p1');
    assert.strictEqual(rows[0].step_id, 's');
    assert.strictEqual(rows[0].task, 'list_creative_formats');
    assert.strictEqual(rows[0].variant, 'sync');
    assert.strictEqual(rows[0].issues.length, 1);
    assert.strictEqual(rows[0].issues[0].keyword, 'format');
  });

  test('excludes lenient-also-failed rows (not strict-only signal)', () => {
    // A step that failed BOTH Zod and AJV isn't a strict-only failure —
    // today's suite already blocks it. Don't put it in the drill-down.
    const phases = [
      makePhase([
        makeStep([
          {
            check: 'response_schema',
            passed: false, // lenient also rejected
            description: 'both reject',
            strict: { valid: false, variant: 'sync', issues: [] },
          },
        ]),
      ]),
    ];
    assert.deepStrictEqual(listStrictOnlyFailures(phases), []);
  });
});
