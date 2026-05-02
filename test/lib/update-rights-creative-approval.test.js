/**
 * Tests for `update_rights` first-class wiring + `creative_approval`
 * webhook builders (#551).
 *
 * Two surfaces to validate:
 *
 *   - `update_rights`: full AdcpToolMap entry → tool registers, mutating
 *     pipeline applies (idempotency, response wrap, MUTATING_TASKS),
 *     `BrandRightsHandlers.updateRights` dispatches.
 *   - `creative_approval`: webhook-only builders (no tool registration);
 *     pure JSON-payload helpers validate + serialize.
 *
 * Tests run against compiled `dist/` to pin shipped behavior.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const responses = require('../../dist/lib/server/responses');
const { BRAND_RIGHTS_TOOLS, PROTOCOL_TOOLS } = require('../../dist/lib/utils/capabilities');
const { MUTATING_TASKS } = require('../../dist/lib/utils/idempotency');
const { TOOL_REQUEST_SCHEMAS } = require('../../dist/lib/utils/tool-request-schemas');
const schemas = require('../../dist/lib/types/schemas.generated');

describe('update_rights wiring (#551)', () => {
  it('appears in BRAND_RIGHTS_TOOLS alongside the other 3 brand tools', () => {
    assert.ok(BRAND_RIGHTS_TOOLS.includes('update_rights'), 'BRAND_RIGHTS_TOOLS must list update_rights');
    assert.ok(BRAND_RIGHTS_TOOLS.includes('get_brand_identity'));
    assert.ok(BRAND_RIGHTS_TOOLS.includes('get_rights'));
    assert.ok(BRAND_RIGHTS_TOOLS.includes('acquire_rights'));
  });

  it('does NOT classify creative_approval as a tool — it is webhook-only', () => {
    assert.ok(
      !BRAND_RIGHTS_TOOLS.includes('creative_approval'),
      'creative_approval is webhook-only, not an MCP/A2A tool'
    );
    assert.ok(!PROTOCOL_TOOLS.includes('creative_approval'));
  });

  it('is registered in TOOL_REQUEST_SCHEMAS so MUTATING_TASKS picks it up', () => {
    assert.ok(TOOL_REQUEST_SCHEMAS.update_rights, 'update_rights must be in TOOL_REQUEST_SCHEMAS');
    assert.strictEqual(
      TOOL_REQUEST_SCHEMAS.update_rights,
      schemas.UpdateRightsRequestSchema,
      'TOOL_REQUEST_SCHEMAS entry must point at the generated Zod schema'
    );
  });

  it('is in MUTATING_TASKS (derived from required idempotency_key on the schema)', () => {
    assert.ok(MUTATING_TASKS.has('update_rights'), 'update_rights must be in MUTATING_TASKS');
  });

  it('does NOT add creative_approval to MUTATING_TASKS — webhooks are out-of-band', () => {
    assert.ok(
      !MUTATING_TASKS.has('creative_approval'),
      'creative_approval is webhook-only and intentionally not in MUTATING_TASKS'
    );
  });

  it('Zod schema validates a minimum-shape request', () => {
    const minimal = {
      rights_id: 'rights_grant_123',
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    };
    const parsed = schemas.UpdateRightsRequestSchema.safeParse(minimal);
    assert.ok(parsed.success, `expected valid; got ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('Zod schema rejects requests missing idempotency_key', () => {
    const noKey = { rights_id: 'rights_grant_123' };
    const parsed = schemas.UpdateRightsRequestSchema.safeParse(noKey);
    assert.equal(parsed.success, false);
  });
});

describe('updateRightsResponse builder', () => {
  it('wraps a success response with structured content + summary', () => {
    const data = {
      rights_id: 'rights_grant_123',
      terms: {
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        impression_cap: 1_000_000,
        territories: ['US'],
        uses: ['display'],
      },
      generation_credentials: [],
      implementation_date: '2026-05-02T19:00:00Z',
    };
    const response = responses.updateRightsResponse(data);
    assert.deepEqual(response.structuredContent, data);
    assert.match(response.content[0].text, /rights_grant_123 updated/);
  });

  it('uses pending-summary when implementation_date is null (rights-holder approval needed)', () => {
    const data = {
      rights_id: 'rights_grant_123',
      terms: {
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        impression_cap: 1_000_000,
        territories: ['US'],
        uses: ['display'],
      },
      implementation_date: null,
    };
    const response = responses.updateRightsResponse(data);
    assert.match(response.content[0].text, /pending approval/);
  });

  it('passes through the error arm', () => {
    const data = {
      errors: [{ code: 'INVALID_REQUEST', message: 'impression_cap below delivered count' }],
    };
    const response = responses.updateRightsResponse(data);
    assert.deepEqual(response.structuredContent, data);
    assert.match(response.content[0].text, /update error/i);
  });

  it('honors a caller-supplied summary', () => {
    const data = {
      rights_id: 'rights_grant_123',
      terms: {
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        impression_cap: 100,
        territories: ['US'],
        uses: ['display'],
      },
      implementation_date: '2026-05-02T19:00:00Z',
    };
    const response = responses.updateRightsResponse(data, 'custom phrase');
    assert.equal(response.content[0].text, 'custom phrase');
  });
});

describe('creative_approval webhook builders', () => {
  it('creativeApproved injects status discriminator', () => {
    const payload = responses.creativeApproved({
      rights_id: 'rights_grant_123',
      creative_id: 'cr_42',
      creative_url: 'https://buyer.example.com/creatives/42.mp4',
      approved_at: '2026-05-02T19:00:00Z',
    });
    assert.equal(payload.status, 'approved');
    assert.equal(payload.rights_id, 'rights_grant_123');
  });

  it('creativeApprovalRejected injects status + carries reason/suggestions', () => {
    const payload = responses.creativeApprovalRejected({
      rights_id: 'rights_grant_123',
      creative_id: 'cr_42',
      reason: 'logo not visible per brand standards',
      suggestions: ['enlarge the logo to 15% of the frame'],
    });
    assert.equal(payload.status, 'rejected');
    assert.equal(payload.reason, 'logo not visible per brand standards');
    assert.deepEqual(payload.suggestions, ['enlarge the logo to 15% of the frame']);
  });

  it('creativeApprovalPendingReview injects status + estimated_response_time', () => {
    const payload = responses.creativeApprovalPendingReview({
      rights_id: 'rights_grant_123',
      creative_id: 'cr_42',
      estimated_response_time: '24h',
      status_url: 'https://brand-rights.example.com/approvals/cr_42',
    });
    assert.equal(payload.status, 'pending_review');
    assert.equal(payload.estimated_response_time, '24h');
  });

  it('creativeApprovalError surfaces multi-error arm without status', () => {
    const payload = responses.creativeApprovalError({
      errors: [{ code: 'INVALID_REQUEST', message: 'creative_url not reachable' }],
    });
    assert.ok(!('status' in payload), 'error arm must not carry status');
    assert.equal(payload.errors[0].code, 'INVALID_REQUEST');
  });

  it('Zod CreativeApprovalRequestSchema validates a minimal webhook payload', () => {
    const minimal = {
      rights_id: 'rights_grant_123',
      creative_url: 'https://buyer.example.com/creative.mp4',
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    };
    const parsed = schemas.CreativeApprovalRequestSchema.safeParse(minimal);
    assert.ok(parsed.success, `expected valid; got ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('Zod CreativeApprovalResponseSchema accepts each of the four arms', () => {
    const approved = { status: 'approved', rights_id: 'rights_grant_123' };
    const rejected = { status: 'rejected', rights_id: 'rights_grant_123', reason: 'r' };
    const pending = { status: 'pending_review', rights_id: 'rights_grant_123' };
    const error = { errors: [{ code: 'INVALID_REQUEST', message: 'm' }] };
    for (const candidate of [approved, rejected, pending, error]) {
      const parsed = schemas.CreativeApprovalResponseSchema.safeParse(candidate);
      assert.ok(
        parsed.success,
        `expected each arm to validate; ${JSON.stringify(candidate)} failed: ${JSON.stringify(parsed.error?.issues)}`
      );
    }
  });
});

describe('public type re-exports', () => {
  it('UpdateRights and CreativeApproval types reachable via @adcp/sdk/types', async () => {
    // The runtime types entrypoint re-exports schema bindings; the static
    // type-only exports are validated at typecheck time. Smoke check that
    // the entrypoint loads and the runtime Zod schemas are reachable.
    const types = await import('../../dist/lib/types/index.js');
    assert.ok(types.UpdateRightsRequestSchema, 'UpdateRightsRequestSchema reachable via /types');
    assert.ok(types.CreativeApprovalRequestSchema, 'CreativeApprovalRequestSchema reachable via /types');
    assert.ok(types.CreativeApprovalResponseSchema, 'CreativeApprovalResponseSchema reachable via /types');
  });
});
