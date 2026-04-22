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
const { MUTATING_TASKS } = require('../../dist/lib/utils/idempotency.js');
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
// have storyboard request builders. Both are mutating per their generated
// schemas (idempotency_key required).
const EXTRA_SCHEMAS = {
  creative_approval: schemas.CreativeApprovalRequestSchema,
  update_rights: schemas.UpdateRightsRequestSchema,
};
const EXTRA_MUTATING = new Set(Object.keys(EXTRA_SCHEMAS));

const ALL_SCHEMAS = { ...TOOL_REQUEST_SCHEMAS, ...EXTRA_SCHEMAS };

// Synthetic key that satisfies IDEMPOTENCY_KEY_PATTERN (^[A-Za-z0-9_.:-]{16,255}$).
const SYNTHETIC_IDEMPOTENCY_KEY = 'roundtrip_test_key_0000000000';

function isMutating(task) {
  return MUTATING_TASKS.has(task) || EXTRA_MUTATING.has(task);
}

function formatIssues(issues) {
  return issues
    .slice(0, 5)
    .map(i => `  path=${i.path.join('.') || '(root)'} code=${i.code} msg=${i.message}`)
    .join('\n');
}

// Enumerated list of every builder covered by this invariant. Keeping this
// explicit — rather than a ">= N" floor — turns "new builder silently skipped"
// into a real test failure: the iterated keys MUST match this list.
const EXPECTED_COVERED_TASKS = [
  'acquire_rights',
  'activate_signal',
  'build_creative',
  'calibrate_content',
  'check_governance',
  'comply_test_controller',
  'create_content_standards',
  'create_media_buy',
  'creative_approval',
  'get_account_financials',
  'get_adcp_capabilities',
  'get_brand_identity',
  'get_content_standards',
  'get_media_buy_delivery',
  'get_media_buys',
  'get_products',
  'get_rights',
  'get_signals',
  'list_accounts',
  'list_content_standards',
  'list_creative_formats',
  'list_creatives',
  'log_event',
  'preview_creative',
  'report_usage',
  'si_get_offering',
  'si_initiate_session',
  'si_send_message',
  'si_terminate_session',
  'sync_accounts',
  'sync_audiences',
  'sync_catalogs',
  'sync_creatives',
  'sync_event_sources',
  'sync_governance',
  'sync_plans',
  'update_content_standards',
  'update_media_buy',
  'update_rights',
  'validate_content_delivery',
];

describe('Request builder schema round-trip', () => {
  for (const [task, schema] of Object.entries(ALL_SCHEMAS)) {
    if (!hasRequestBuilder(task)) continue;

    test(`${task} fallback round-trips through request schema`, () => {
      const request = buildRequest(step(task), {}, DEFAULT_OPTIONS);

      // Runner injects idempotency_key on mutating tasks; the builder never
      // mints one. Stand in for that here so the round-trip reflects what
      // actually goes on the wire.
      if (isMutating(task) && request.idempotency_key === undefined) {
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

  test('covered builders match the enumerated list (guard against silent skip)', () => {
    const covered = Object.keys(ALL_SCHEMAS)
      .filter(t => hasRequestBuilder(t))
      .sort();
    assert.deepStrictEqual(
      covered,
      [...EXPECTED_COVERED_TASKS].sort(),
      'Covered builder+schema pairs changed. Update EXPECTED_COVERED_TASKS if a new builder was added (or a schema removed).'
    );
  });
});
