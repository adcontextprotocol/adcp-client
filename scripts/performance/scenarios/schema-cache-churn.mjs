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
  // Exercise the production entry cap, with a scaled byte budget so this
  // workload stays cheap while requiring eviction by bytes rather than count.
  const capacity = 256;
  const retainedSchemas = 8;
  const revision = index => ({ ...schema, $comment: `schema refresh ${String(index).padStart(4, '0')}` });
  const schemaBytes = Buffer.byteLength(JSON.stringify(revision(0)));
  const byteBudget = schemaBytes * retainedSchemas;
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
    capacity,
    byteBudget
  );
  const batch = start => {
    for (let i = start; i < start + retainedSchemas * 3; i++) {
      // Change only an annotation, modeling sellers refreshing schemas while
      // keeping every protocol validation constraint intact.
      cache.getValidator(revision(i));
    }
  };
  const first = await measurePhase('three cache turnovers', () => batch(0));
  const second = await measurePhase('three more cache turnovers', () => batch(retainedSchemas * 3));
  const liveSchemas = references.filter(reference => reference.deref() !== undefined).length;
  // Keep the LRU alive through the collection/count, including optimized runs.
  assert.ok(cache.getValidator(revision(retainedSchemas * 6 - 1)));
  return {
    source: [
      {
        name: 'delete_property_list',
        adcpVersion: document.resolvedVersion,
        bytes: Buffer.byteLength(serialized),
        sha256: createHash('sha256').update(serialized).digest('hex'),
      },
    ],
    workload: { capacity, byteBudget, schemaBytes, uniqueSchemas: retainedSchemas * 6 },
    phases: [first, second],
    metrics: { liveSchemas, retainedHeapGrowthBytes: second.afterGc.heapUsed - first.afterGc.heapUsed },
    maximums: { liveSchemas: retainedSchemas, retainedHeapGrowthBytes: 16 * 1024 ** 2 },
  };
}
