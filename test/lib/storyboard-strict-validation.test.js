/**
 * Strict/lenient response-schema validation + run-level aggregation (issue
 * #820, fourth proposal). `runValidations` must attach an AJV-based strict
 * verdict to every `response_schema` ValidationResult without flipping the
 * step's pass/fail (which stays Zod-driven for backwards compatibility).
 *
 * Tests hit the storyboard validation layer directly — `runValidations`
 * with a synthetic `ValidationContext`. No runner boot or network needed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const { summarizeStrictValidation } = require('../../dist/lib/testing/storyboard/runner.js');

function ctx(taskName, data, responseSchemaRef) {
  return {
    taskName,
    taskResult: { data },
    agentUrl: 'http://agent.example/mcp',
    contributions: new Set(),
    responseSchemaRef,
  };
}

describe('storyboard validations: strict/lenient response_schema delta', () => {
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

  test('strictness-delta scenario: Zod accepts a bad URI, AJV rejects format: uri', () => {
    // Zod's generated `z.string()` doesn't enforce `format` keywords. AJV
    // does. A response where `format_id.agent_url` is a bare word rather
    // than a URI is the canonical "lenient passes, strict fails" case —
    // the delta signal #820 wants agent developers to see.
    const response = {
      formats: [
        {
          // agent_url is declared `format: uri` per core/format-id.json.
          // "not-a-uri" satisfies z.string() but fails AJV's URI check.
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
    assert.strictEqual(v.passed, true, 'Zod path accepts bare string (lenient-pass)');
    assert.ok(v.strict);
    assert.strictEqual(v.strict.valid, false, 'AJV rejects bare string where format: uri is required');
    assert.ok(v.strict.issues);
    const hasFormat = v.strict.issues.some(i => i.keyword === 'format');
    assert.ok(hasFormat, `expected a format issue, got: ${JSON.stringify(v.strict.issues)}`);
  });

  test('no AJV schema registered: strict verdict absent (not a failure)', () => {
    // Some task schemas live outside the bundled/ tree and aren't compiled
    // by the AJV loader. The runner must NOT emit a strict verdict in that
    // case — there's no signal to report. The lenient Zod path still runs.
    const results = runValidations(
      [{ check: 'response_schema', description: 'response conforms' }],
      ctx('check_governance', { status: 'approved', plan_id: 'plan-1' }, 'governance/check-governance-response.json')
    );
    const v = results[0];
    // Either passes Zod cleanly (no strict emitted) or fails Zod (still no
    // strict emitted because there's no AJV schema). Either way `strict`
    // is absent.
    assert.strictEqual(v.strict, undefined, 'no strict verdict when AJV has no schema for this task');
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
  test('returns undefined when no response_schema validation has a strict verdict', () => {
    // A run that only exercises non-schema checks (field_present, etc.)
    // emits no strict signal; the summary field must be absent.
    const phases = [makePhase([makeStep([{ check: 'field_present', passed: true, description: 'x' }])])];
    assert.strictEqual(summarizeStrictValidation(phases), undefined);
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
    const summary = summarizeStrictValidation(phases);
    assert.deepStrictEqual(summary, { checked: 2, passed: 2, failed: 0, delta: 0 });
  });

  test('counts a strict/lenient delta (lenient-pass, strict-fail)', () => {
    // Canonical #820 case: agent passes Zod but slips past AJV (format or
    // additionalProperties violation). `delta` counts exactly these.
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
    const summary = summarizeStrictValidation(phases);
    assert.deepStrictEqual(summary, { checked: 1, passed: 0, failed: 1, delta: 1 });
  });

  test('does not count strict-fail as a delta when Zod also rejected', () => {
    // When the step already failed Zod (passed=false), strict-fail is
    // not a NEW signal — the lenient path already blocked it. Delta
    // should be 0; failed still counts.
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
    const summary = summarizeStrictValidation(phases);
    assert.deepStrictEqual(summary, { checked: 1, passed: 0, failed: 1, delta: 0 });
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
    const summary = summarizeStrictValidation(phases);
    assert.deepStrictEqual(summary, { checked: 1, passed: 1, failed: 0, delta: 0 });
  });
});
