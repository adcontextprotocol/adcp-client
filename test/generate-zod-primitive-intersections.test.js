const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

test('primitive marker repair preserves named enum validation and object intersections', () => {
  const harnessDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-primitive-intersections-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  fs.writeFileSync(
    scriptPath,
    `
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { __test__ } from '../scripts/generate-zod-from-ts';

const input = \`
export const ValuesSchema = z.union([z.literal("first"), z.literal("second")]);
export const AliasSchema = ValuesSchema;
export const NamedSchema = AliasSchema.and(z.object({}).passthrough());
export const ReversedSchema = z.union([z.object({}), z.object({}).passthrough()]).and(ValuesSchema);
export const LiteralSchema = z.literal("first").and(z.object({}));
export const InlineSchema = z.string().and(z.object({}));
export const RepeatedSchema = ValuesSchema.and(z.object({})).and(z.object({}));
export const ObjectSchema = z.object({ id: z.string() }).and(z.object({}));
export const RichSchema = ValuesSchema.and(z.object({ id: z.string() }));
export const MixedSchema = z.union([z.string(), z.object({})]).and(z.object({}));
export const ArraySchema = z.array(ValuesSchema).and(z.object({}));
export const TextSchema = z.literal('z.string().and(z.object({}))');
\`;
const fixed = __test__.postProcessPrimitiveIntersections(input);
assert.match(fixed, /NamedSchema = AliasSchema;/);
assert.match(fixed, /ReversedSchema = ValuesSchema;/);
assert.match(fixed, /LiteralSchema = z.literal\\("first"\\);/);
assert.match(fixed, /InlineSchema = z.string\\(\\);/);
assert.match(fixed, /RepeatedSchema = ValuesSchema;/);
for (const name of ['ObjectSchema', 'RichSchema', 'MixedSchema', 'ArraySchema', 'TextSchema']) {
  assert.equal(fixed.split('\\n').find(line => line.startsWith('export const ' + name)),
    input.split('\\n').find(line => line.startsWith('export const ' + name)));
}
assert.equal(__test__.postProcessPrimitiveIntersections(fixed), fixed);

const cacheRoot = path.join(${JSON.stringify(harnessDir)}, 'cache');
function source(file: string, value: unknown) {
  const destination = path.join(cacheRoot, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(value));
}
function intersection(file: string, exclusion: unknown) {
  return { allOf: [{ $ref: 'https://adcontextprotocol.org/schemas/3.2.4/' + file }, { not: exclusion }] };
}
source('enums/macro-value-context.json', { type: 'string', enum: ['url_query_value', 'url_path_segment', 'opaque'] });
source('enums/vast-tracking-event.json', { type: 'string', enum: ['start', 'complete', 'impression', 'error'] });
source('enums/daast-tracking-event.json', { type: 'string', enum: ['start', 'complete', 'impression', 'error'] });
source('enums/available-metric.json', { type: 'string', enum: ['impressions', 'clicks', 'spend', 'viewability'] });
source('enums/notification-type.json', { type: 'string', enum: ['capabilities.changed', 'principal.changed', 'scheduled'] });
source('core/macro-resolution-capability.json', { properties: {
  supported_contexts: { items: intersection('enums/macro-value-context.json', { const: 'opaque' }) }
} });
source('core/assets/vast-tracker-asset.json', { properties: {
  vast_event: intersection('enums/vast-tracking-event.json', { enum: ['impression', 'error'] })
} });
source('core/assets/daast-tracker-asset.json', { properties: {
  daast_event: intersection('enums/daast-tracking-event.json', { enum: ['impression', 'error'] })
} });
source('core/delivery-metric-aggregate.json', { oneOf: [{ properties: {
  metric_id: intersection('enums/available-metric.json', { enum: ['viewability'] })
} }] });
source('core/package-delivery-metric-value.json', { allOf: [
  { $ref: 'https://adcontextprotocol.org/schemas/3.2.4/core/delivery-metric-aggregate.json#/oneOf/0' },
  { not: { properties: { metric_id: { const: 'spend' } }, required: ['metric_id'] } }
] });
for (const file of ['core/agent-notification-config.json', 'core/agent-notification-config-state.json']) {
  source(file, { properties: { event_types: { items: intersection('enums/notification-type.json', { enum: ['scheduled'] }) } } });
}
const projected = \`
export const MacroValueContextSchema = z.enum(['url_query_value', 'url_path_segment', 'opaque']);
export const VASTTrackingEventSchema = z.enum(['start', 'complete', 'impression', 'error']);
export const DAASTTrackingEventSchema = VASTTrackingEventSchema;
export const AvailableMetricSchema = z.enum(['impressions', 'clicks', 'spend', 'viewability']);
export const NotificationTypeSchema = z.enum(['capabilities.changed', 'principal.changed', 'scheduled']);
export const MacroProcessingCapabilitySchema = z.union([
  z.object({ operation: z.literal('translate'), supported_contexts: z.array(MacroValueContextSchema.and(z.object({}))).min(1) }),
  z.object({ operation: z.literal('resolve'), supported_contexts: z.array(MacroValueContextSchema.and(z.object({}))).min(1) })
]);
export const VASTTrackerAssetSchema = z.object({ vast_event: VASTTrackingEventSchema.and(z.object({})) });
export const DAASTTrackerAssetSchema = z.object({ daast_event: DAASTTrackingEventSchema.and(z.object({})) });
export const PackageDeliveryMetricValueSchema = z.object({ metric_id: AvailableMetricSchema.and(z.object({})) });
export const AgentNotificationConfigSchema = z.object({ event_types: z.array(NotificationTypeSchema.and(z.object({}))).min(1) });
export const AgentNotificationConfigStateSchema = z.object({ event_types: z.array(NotificationTypeSchema.and(z.object({}))).min(1) });
\`;
const repaired = __test__.postProcessPrimitiveEnumExclusions(
  __test__.postProcessPrimitiveIntersections(projected), cacheRoot
);
assert.equal(__test__.postProcessPrimitiveEnumExclusions(repaired, cacheRoot), repaired);
const schemas = new Function('z', repaired.replaceAll('export const ', 'const ') +
  ';return { MacroProcessingCapabilitySchema, VASTTrackerAssetSchema, DAASTTrackerAssetSchema, PackageDeliveryMetricValueSchema, AgentNotificationConfigSchema, AgentNotificationConfigStateSchema };')(z);
for (const operation of ['translate', 'resolve']) {
  assert.equal(schemas.MacroProcessingCapabilitySchema.safeParse({ operation, supported_contexts: ['url_query_value'] }).success, true);
  assert.equal(schemas.MacroProcessingCapabilitySchema.safeParse({ operation, supported_contexts: ['opaque'] }).success, false);
  assert.equal(schemas.MacroProcessingCapabilitySchema.safeParse({ operation, supported_contexts: [] }).success, false);
}
for (const [name, field, valid, forbidden] of [
  ['VASTTrackerAssetSchema', 'vast_event', 'start', 'impression'],
  ['DAASTTrackerAssetSchema', 'daast_event', 'complete', 'error'],
  ['PackageDeliveryMetricValueSchema', 'metric_id', 'impressions', 'spend']
]) {
  assert.equal(schemas[name].safeParse({ [field]: valid }).success, true);
  assert.equal(schemas[name].safeParse({ [field]: forbidden }).success, false);
  assert.equal(schemas[name].safeParse({ [field]: 'unknown' }).success, false);
}
assert.equal(schemas.PackageDeliveryMetricValueSchema.safeParse({ metric_id: 'viewability' }).success, false);
for (const name of ['AgentNotificationConfigSchema', 'AgentNotificationConfigStateSchema']) {
  assert.equal(schemas[name].safeParse({ event_types: ['capabilities.changed'] }).success, true);
  assert.equal(schemas[name].safeParse({ event_types: ['scheduled'] }).success, false);
  assert.equal(schemas[name].safeParse({ event_types: [] }).success, false);
}
for (const schema of Object.values(schemas)) assert.doesNotThrow(() => z.toJSONSchema(schema));
source('core/assets/vast-tracker-asset.json', { properties: {
  vast_event: intersection('enums/vast-tracking-event.json', { enum: ['impression', 'error', 'complete'] })
} });
const changed = __test__.postProcessPrimitiveEnumExclusions(__test__.postProcessPrimitiveIntersections(projected), cacheRoot);
assert.match(changed, /vast_event: z.enum\\(\\["start"\\]\\)/);
`
  );
  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `generator regression harness failed:\n${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
});
