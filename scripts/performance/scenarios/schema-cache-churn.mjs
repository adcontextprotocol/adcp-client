import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { CachedJsonSchemaValidator } = require('../../../dist/lib/protocols/mcp-schema-validator.js');
const { getToolSchemaDocument } = require('../../../dist/lib/validation/schema-loader.js');

export async function run({ mode, options, measurePhase }) {
  const document = getToolSchemaDocument('delete_property_list', 'sync', options.adcpVersion ?? '3.2.7');
  assert.ok(document, 'Missing real bundled schemas; run npm run build:lib');
  const schema = structuredClone(document.schema);
  delete schema.$id;
  const serialized = JSON.stringify(schema);
  const capacity = 8;
  const references = [];
  // Negative control for the tempting partial fix: the outer LRU is bounded,
  // but its shared Ajv still retains every evicted schema internally.
  const shared = mode === 'leaky' ? new AjvJsonSchemaValidator() : undefined;
  const cache = new CachedJsonSchemaValidator(
    () => ({
      getValidator(input) {
        references.push(new WeakRef(input));
        return (shared ?? new AjvJsonSchemaValidator()).getValidator(input);
      },
    }),
    capacity
  );
  const batch = start => {
    for (let i = start; i < start + capacity * 3; i++) {
      // Change only an annotation, modeling sellers refreshing schemas while
      // keeping every protocol validation constraint intact.
      cache.getValidator({ ...schema, $comment: `schema refresh ${i}` });
    }
  };
  const first = await measurePhase('three cache turnovers', () => batch(0));
  const second = await measurePhase('three more cache turnovers', () => batch(capacity * 3));
  const liveSchemas = references.filter(reference => reference.deref() !== undefined).length;
  // Keep the LRU alive through the collection/count, including optimized runs.
  assert.ok(cache.getValidator({ ...schema, $comment: `schema refresh ${capacity * 6 - 1}` }));
  return {
    source: [
      {
        name: 'delete_property_list',
        adcpVersion: document.resolvedVersion,
        bytes: Buffer.byteLength(serialized),
        sha256: createHash('sha256').update(serialized).digest('hex'),
      },
    ],
    workload: { capacity, uniqueSchemas: capacity * 6 },
    phases: [first, second],
    metrics: { liveSchemas, retainedHeapGrowthBytes: second.afterGc.heapUsed - first.afterGc.heapUsed },
    maximums: { liveSchemas: capacity, retainedHeapGrowthBytes: 16 * 1024 ** 2 },
  };
}
