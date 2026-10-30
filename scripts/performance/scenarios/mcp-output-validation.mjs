import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { maxCompiledFunctionBytes } from '../compiled-functions.cjs';

const require = createRequire(import.meta.url);
const AjvCore = require('ajv/dist/core').default;
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { getToolSchemaDocument } = require('../../../dist/lib/validation/schema-loader.js');
const { sharedLegacyJsonSchemaValidator } = require('../../../dist/lib/protocols/mcp-schema-validator.js');

export async function run({ mode, options, measurePhase }) {
  const version = options.adcpVersion ?? '3.2.7';
  const names = ['get_products', 'list_creative_formats'];
  const source = [];
  const validators = [];
  const responses = [
    { status: 'completed', cache_scope: 'public', products: [] },
    { status: 'completed', formats: [] },
  ];
  const invalid = [
    { status: 'completed', cache_scope: 'public', products: [{}] },
    { status: 'completed', formats: [{}] },
  ];
  let largestFunctionBytes = 0;
  let compilations = 0;
  let validations = 0;
  const maxFunctionBytes = 512 * 1024;
  const originalCompile = AjvCore.prototype.compile;
  AjvCore.prototype.compile = function (schema) {
    compilations++;
    const validate = originalCompile.call(this, schema);
    largestFunctionBytes = Math.max(largestFunctionBytes, maxCompiledFunctionBytes(validate));
    return validate;
  };
  try {
    const cold = await measurePhase('compile output validators', async () => {
      for (const name of names) {
        const document = getToolSchemaDocument(name, 'sync', version);
        assert.ok(document, `Missing real bundled schema for ${name}`);
        const schema = structuredClone(document.schema);
        delete schema.$id;
        const serialized = JSON.stringify(schema);
        source.push({
          name,
          adcpVersion: document.resolvedVersion,
          bytes: Buffer.byteLength(serialized),
          sha256: createHash('sha256').update(serialized).digest('hex'),
        });
        const provider = mode === 'cached' ? sharedLegacyJsonSchemaValidator : new AjvJsonSchemaValidator();
        validators.push(provider.getValidator(schema));
      }
    });
    assert.ok(
      compilations >= names.length && largestFunctionBytes > 0,
      'Every tool must have observable compiled functions before validation runs'
    );
    const warm = await measurePhase('2000 repeated valid and invalid output checks', async () => {
      // Reject giant functions before executing them: V8's native compilation
      // can consume many GiB even with a small --max-old-space-size heap cap.
      if (largestFunctionBytes > maxFunctionBytes) return;
      for (let round = 0; round < 2000; round++) {
        for (let tool = 0; tool < validators.length; tool++) {
          assert.equal(validators[tool](responses[tool]).valid, true);
          assert.equal(validators[tool](invalid[tool]).valid, false);
          validations += 2;
        }
      }
    });
    return {
      source,
      workload: {
        rounds: 2000,
        tools: names,
        validations,
        skippedOversizedFunctions: largestFunctionBytes > maxFunctionBytes,
      },
      phases: [cold, warm],
      metrics: {
        largestFunctionBytes,
        validationCountMismatch: Math.abs(validations - 8000),
        peakRssBytes: warm.afterGc.peakRssBytes,
        retainedHeapGrowthBytes: warm.afterGc.heapUsed - cold.afterGc.heapUsed,
      },
      maximums: {
        largestFunctionBytes: maxFunctionBytes,
        validationCountMismatch: 0,
        peakRssBytes: 512 * 1024 ** 2,
        retainedHeapGrowthBytes: 64 * 1024 ** 2,
      },
    };
  } finally {
    AjvCore.prototype.compile = originalCompile;
  }
}
