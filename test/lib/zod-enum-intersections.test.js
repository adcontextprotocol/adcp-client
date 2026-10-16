const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const cache = path.resolve(__dirname, '../../schemas/cache/latest');
const document = name => JSON.parse(readFileSync(path.join(cache, name), 'utf8'));
const macroCapability = {
  dialect: 'adcp',
  dialect_semantic: 'CACHEBUSTER',
  mapping_status: 'verified_universal',
  universal_semantic: 'CACHEBUSTER',
  operation: 'resolve_value',
  performed_by: 'seller',
  supported_contexts: ['url_query_value'],
  supported_encodings: [{ kind: 'rfc3986', depth: 1 }],
};
const notificationConfig = {
  subscriber_id: 'registry-cache',
  url: 'https://registry.example/webhooks/adcp',
  all_authorized_accounts: true,
};

const cases = [
  {
    schema: 'VASTTrackerAssetSchema',
    enumFile: 'enums/vast-tracking-event.json',
    constraint: document('core/assets/vast-tracker-asset.json').properties.vast_event,
    payload: value => ({
      asset_type: 'vast_tracker',
      vast_event: value,
      url: 'https://tracker.example/start',
      offset: '25%',
    }),
  },
  {
    schema: 'DAASTTrackerAssetSchema',
    enumFile: 'enums/daast-tracking-event.json',
    constraint: document('core/assets/daast-tracker-asset.json').properties.daast_event,
    payload: value => ({
      asset_type: 'daast_tracker',
      daast_event: value,
      url: 'https://tracker.example/start',
      offset: '25%',
    }),
  },
  {
    schema: 'MacroProcessingCapabilitySchema',
    enumFile: 'enums/macro-value-context.json',
    constraint: document('core/macro-resolution-capability.json').properties.supported_contexts.items,
    payload: value => ({ ...macroCapability, supported_contexts: [value] }),
  },
  ...['AgentNotificationConfigSchema', 'AgentNotificationConfigStateSchema'].map(schema => ({
    schema,
    enumFile: 'enums/notification-type.json',
    constraint: document('core/agent-notification-config.json').properties.event_types.items,
    payload: value => ({ ...notificationConfig, event_types: [value] }),
  })),
  {
    schema: 'PackageDeliveryMetricValueSchema',
    enumFile: 'enums/available-metric.json',
    constraint: document('core/delivery-metric-aggregate.json').oneOf[0].properties.metric_id,
    payload: value => ({ scope: 'standard', metric_id: value, qualifier: { viewability_standard: 'mrc' }, value: 1 }),
  },
];

for (const [moduleKind, load] of [
  ['CommonJS', async () => require('@adcp/sdk/schemas')],
  ['ESM', async () => import('../../dist/lib/schemas/index.mjs')],
]) {
  describe(`enum intersections preserve primitive values (${moduleKind}, issue #3300)`, () => {
    for (const entry of cases) {
      test(`${entry.schema} accepts allowed enum members and rejects excluded or invalid values`, async () => {
        const schemas = await load();
        const excluded = entry.constraint.allOf.flatMap(branch =>
          branch.not ? (branch.not.enum ?? [branch.not.const]) : []
        );
        for (const value of [...document(entry.enumFile).enum, 'not-a-protocol-enum', {}, null, 42]) {
          // Package-level spend is expressly forbidden by its containing schema.
          const allowed =
            document(entry.enumFile).enum.includes(value) &&
            !excluded.includes(value) &&
            !(entry.schema === 'PackageDeliveryMetricValueSchema' && value === 'spend');
          const result = schemas[entry.schema].safeParse(entry.payload(value));
          assert.equal(result.success, allowed, `${entry.schema}: ${JSON.stringify(value)}: ${result.error?.message}`);
        }
        assert.doesNotThrow(() => z.toJSONSchema(schemas[entry.schema]));
      });
    }

    test('seller format options preserve declared macro resolution capabilities', async () => {
      const schemas = await load();
      const declaration = {
        format_kind: 'image',
        params: { width: 300, height: 250 },
        macro_resolution_capabilities: [macroCapability],
      };
      assert.deepEqual(schemas.ProductFormatDeclarationSchema.parse(declaration), declaration);
      assert.equal(
        schemas.ProductFormatDeclarationSchema.safeParse({
          ...declaration,
          macro_resolution_capabilities: [{ ...macroCapability, supported_contexts: ['opaque'] }],
        }).success,
        false
      );
    });
  });
}

test('tracker creative sync passes both canonical and SingleAgentClient pre-dispatch validation', () => {
  const { SingleAgentClient } = require('@adcp/sdk');
  const schemas = require('@adcp/sdk/schemas');
  const client = new SingleAgentClient({
    id: 'seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  });
  const canonical = schemas.getCanonicalToolValidator('sync_creatives', 'request', { adcpVersion: '3.2' });
  for (const [assetType, eventField, formatKind] of [
    ['vast_tracker', 'vast_event', 'video_vast'],
    ['daast_tracker', 'daast_event', 'audio_vast'],
  ]) {
    for (const arraySlot of [false, true]) {
      const tracker = { asset_type: assetType, [eventField]: 'start', url: 'https://tracker.example/start' };
      const request = {
        account: { account_id: 'account-1' },
        idempotency_key: `sync-${assetType}-${arraySlot}`,
        creatives: [
          {
            creative_id: 'creative-1',
            name: 'Tracked creative',
            format_kind: formatKind,
            assets: { start_tracker: arraySlot ? [tracker] : tracker },
          },
        ],
      };
      assert.equal(canonical(request), true, JSON.stringify(canonical.errors));
      assert.deepEqual(schemas.SyncCreativesRequestSchema.parse(request), request);
      assert.doesNotThrow(() => client.validateRequest('sync_creatives', request));
      const inlineRequest = {
        account: request.account,
        idempotency_key: `inline-${assetType}-${arraySlot}`,
        brand: { domain: 'buyer.example' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-01-02T00:00:00Z',
        packages: [
          {
            product_id: 'product-1',
            pricing_option_id: 'cpm',
            budget: 1000,
            creatives: request.creatives,
          },
        ],
      };
      const canonicalInline = schemas.getCanonicalToolValidator('create_media_buy', 'request', { adcpVersion: '3.2' });
      assert.equal(canonicalInline(inlineRequest), true, JSON.stringify(canonicalInline.errors));
      assert.doesNotThrow(() => client.validateRequest('create_media_buy', inlineRequest));
      tracker[eventField] = 'impression';
      assert.equal(canonical(request), false);
      assert.throws(() => client.validateRequest('sync_creatives', request), /Request validation failed/);
      assert.equal(canonicalInline(inlineRequest), false);
      assert.throws(() => client.validateRequest('create_media_buy', inlineRequest), /Request validation failed/);
    }
  }
});
