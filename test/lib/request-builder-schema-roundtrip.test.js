/**
 * Schema-driven round-trip invariant for storyboard request builders.
 *
 * For every task that has a request builder AND a generated Zod schema,
 * build the fallback request (empty context + options only) and assert it
 * round-trips through the schema. This catches the class of bugs fixed in
 * #789 / #792 / #793 / #794: builder fallbacks that drift out of spec and
 * emit field names the generated schema rejects with `-32602 invalid_type`.
 *
 * The test iterates schemas from `TOOL_REQUEST_SCHEMAS` plus the two brand-
 * rights schemas that ship outside the MCP tool surface (creative_approval,
 * update_rights) but still have builders. Any new builder registered for a
 * tool that has a schema is covered automatically — no hand-maintained list.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { buildRequest, hasRequestBuilder } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { TOOL_REQUEST_SCHEMAS } = require('../../dist/lib/utils/tool-request-schemas.js');
const schemas = require('../../dist/lib/types/schemas.generated.js');

const DEFAULT_OPTIONS = {
  brand: { domain: 'acmeoutdoor.example' },
  account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'acmeoutdoor.example' },
};

function step(task, overrides = {}) {
  return { id: `test-${task}`, title: `Test ${task}`, task, ...overrides };
}

// Brand-rights schemas that aren't exposed via TOOL_REQUEST_SCHEMAS (they
// ship as webhooks, not MCP tools — see create-adcp-server.ts) but still
// have storyboard request builders.
const EXTRA_SCHEMAS = {
  creative_approval: schemas.CreativeApprovalRequestSchema,
  update_rights: schemas.UpdateRightsRequestSchema,
};

const ALL_SCHEMAS = { ...TOOL_REQUEST_SCHEMAS, ...EXTRA_SCHEMAS };

// Synthetic key that satisfies IDEMPOTENCY_KEY_PATTERN (^[A-Za-z0-9_.:-]{16,255}$).
const SYNTHETIC_IDEMPOTENCY_KEY = 'roundtrip_test_key_0000000000';

// Detect whether a Zod object's `idempotency_key` field is required. Mirrors
// the logic in `deriveMutatingTasks()` so the test stays in sync with the
// schema: if the field exists and isn't ZodOptional/ZodDefault, it's required.
function requiresIdempotencyKey(schema) {
  const shape = schema?.shape;
  const field = shape?.idempotency_key;
  if (!field) return false;
  const typeName = field?._def?.typeName;
  return typeName !== 'ZodOptional' && typeName !== 'ZodDefault';
}

function formatIssues(issues) {
  return issues
    .slice(0, 5)
    .map(i => `  path=${i.path.join('.') || '(root)'} code=${i.code} msg=${i.message}`)
    .join('\n');
}

describe('Request builder schema round-trip', () => {
  for (const [task, schema] of Object.entries(ALL_SCHEMAS)) {
    if (!hasRequestBuilder(task)) continue;

    test(`${task} fallback round-trips through request schema`, () => {
      const request = buildRequest(step(task), {}, DEFAULT_OPTIONS);

      // Runner injects idempotency_key on mutating tasks; the builder never
      // mints one. Stand in for that here so the round-trip reflects what
      // actually goes on the wire.
      if (requiresIdempotencyKey(schema) && request.idempotency_key === undefined) {
        request.idempotency_key = SYNTHETIC_IDEMPOTENCY_KEY;
      }

      const parsed = schema.safeParse(request);
      assert.ok(
        parsed.success,
        parsed.success
          ? ''
          : `${task} fallback does not match schema:\n${formatIssues(parsed.error.issues)}\nrequest=${JSON.stringify(request, null, 2)}`
      );
    });
  }

  test('at least 30 builders are covered (guard against silent skip)', () => {
    const covered = Object.keys(ALL_SCHEMAS).filter(t => hasRequestBuilder(t));
    assert.ok(
      covered.length >= 30,
      `expected >= 30 builder+schema pairs, got ${covered.length}: ${covered.join(', ')}`
    );
  });
});
