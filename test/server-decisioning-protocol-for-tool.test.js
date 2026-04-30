'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  protocolForTool,
  TOOL_PROTOCOL_MAP,
  SPEC_WEBHOOK_TASK_TYPES,
} = require('../dist/lib/server/decisioning/runtime/protocol-for-tool');

describe('protocolForTool — webhook + tasks_get protocol routing', () => {
  it('maps sales tools to media-buy', () => {
    assert.strictEqual(protocolForTool('create_media_buy'), 'media-buy');
    assert.strictEqual(protocolForTool('update_media_buy'), 'media-buy');
    assert.strictEqual(protocolForTool('get_products'), 'media-buy');
    assert.strictEqual(protocolForTool('sync_audiences'), 'media-buy');
  });

  it('maps signals tools to signals', () => {
    assert.strictEqual(protocolForTool('get_signals'), 'signals');
    assert.strictEqual(protocolForTool('activate_signal'), 'signals');
  });

  it('maps creative tools to creative', () => {
    assert.strictEqual(protocolForTool('build_creative'), 'creative');
    assert.strictEqual(protocolForTool('preview_creative'), 'creative');
    assert.strictEqual(protocolForTool('sync_creatives'), 'creative');
    assert.strictEqual(protocolForTool('list_creative_formats'), 'creative');
  });

  it('maps property/collection-list tools to governance', () => {
    assert.strictEqual(protocolForTool('create_property_list'), 'governance');
    assert.strictEqual(protocolForTool('list_property_lists'), 'governance');
    assert.strictEqual(protocolForTool('delete_collection_list'), 'governance');
    assert.strictEqual(protocolForTool('get_content_standards'), 'governance');
  });

  it('maps brand tools to brand', () => {
    assert.strictEqual(protocolForTool('get_brand_identity'), 'brand');
    assert.strictEqual(protocolForTool('acquire_rights'), 'brand');
  });

  it('maps si_* tools to sponsored-intelligence', () => {
    assert.strictEqual(protocolForTool('si_initiate_session'), 'sponsored-intelligence');
    assert.strictEqual(protocolForTool('si_send_message'), 'sponsored-intelligence');
  });

  it('falls back to media-buy for unknown tools', () => {
    // Sales is the safest default — anything the framework dispatches but
    // isn't catalogued here is most likely a new sales tool.
    assert.strictEqual(protocolForTool('some_future_tool'), 'media-buy');
  });
});

describe('TOOL_PROTOCOL_MAP — table integrity', () => {
  it('returns only the 6 spec-defined protocol values', () => {
    const valid = new Set(['media-buy', 'signals', 'governance', 'creative', 'brand', 'sponsored-intelligence']);
    for (const [tool, protocol] of Object.entries(TOOL_PROTOCOL_MAP)) {
      assert.ok(valid.has(protocol), `tool '${tool}' maps to invalid protocol '${protocol}'`);
    }
  });

  it('covers every tool in the spec task-type webhook allowlist', () => {
    // Every tool in SPEC_WEBHOOK_TASK_TYPES must have an entry in
    // TOOL_PROTOCOL_MAP — webhook delivery looks up `protocol` from
    // protocolForTool, and a missing entry would silently fall through
    // to the 'media-buy' default for tools that aren't actually sales.
    for (const tool of SPEC_WEBHOOK_TASK_TYPES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(TOOL_PROTOCOL_MAP, tool),
        `spec-allowlisted webhook tool '${tool}' missing from TOOL_PROTOCOL_MAP`
      );
    }
  });
});

describe('SPEC_WEBHOOK_TASK_TYPES — closed-enum gate', () => {
  it('matches the AdCP 3.0 GA enums/task-type.json closed enum (20 values)', () => {
    // If this count changes, sync with schemas/cache/3.0.0/enums/task-type.json
    // and update protocol-for-tool.ts. The framework gates webhook delivery
    // to this set so spec-validating receivers don't reject envelopes.
    assert.strictEqual(SPEC_WEBHOOK_TASK_TYPES.size, 20);
  });

  it('includes the canonical HITL tools', () => {
    assert.ok(SPEC_WEBHOOK_TASK_TYPES.has('create_media_buy'));
    assert.ok(SPEC_WEBHOOK_TASK_TYPES.has('sync_creatives'));
    assert.ok(SPEC_WEBHOOK_TASK_TYPES.has('update_media_buy'));
    assert.ok(SPEC_WEBHOOK_TASK_TYPES.has('activate_signal'));
  });

  it('excludes non-spec tools the framework dispatches', () => {
    // These tools are dispatched by the framework but not in the spec's
    // closed task-type enum. Webhook delivery for them is gated off until
    // the spec enum is widened. Adopters surface their lifecycle via
    // `publishStatusChange` instead.
    assert.ok(!SPEC_WEBHOOK_TASK_TYPES.has('check_governance'));
    assert.ok(!SPEC_WEBHOOK_TASK_TYPES.has('build_creative'));
    assert.ok(!SPEC_WEBHOOK_TASK_TYPES.has('preview_creative'));
    assert.ok(!SPEC_WEBHOOK_TASK_TYPES.has('si_initiate_session'));
  });
});
