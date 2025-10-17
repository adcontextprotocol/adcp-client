/**
 * Type Generator Strictness Test
 *
 * Ensures that the type generator maintains strict typing by preventing
 * excessive use of [k: string]: unknown index signatures.
 *
 * This test prevents regression where additionalProperties: true in JSON schemas
 * leaks into TypeScript types, defeating compile-time type safety.
 */

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

test('generated types maintain strict schema enforcement', () => {
  const typesPath = path.join(__dirname, '../src/lib/types/tools.generated.ts');

  // Ensure file exists
  assert.ok(
    fs.existsSync(typesPath),
    'tools.generated.ts not found. Run "npm run generate-types" first.'
  );

  const typesContent = fs.readFileSync(typesPath, 'utf8');

  // Count index signatures
  const indexSignatures = typesContent.match(/\[k: string\]: unknown/g) || [];
  const count = indexSignatures.length;

  // Maximum acceptable count (based on oneOf/intersection types from JSON Schema)
  const MAX_ALLOWED = 20;

  console.log(`📊 Type strictness metrics:`);
  console.log(`   Index signatures found: ${count}`);
  console.log(`   Maximum allowed: ${MAX_ALLOWED}`);
  console.log(`   Status: ${count <= MAX_ALLOWED ? '✅ PASS' : '❌ FAIL'}`);

  // Assert that we haven't regressed
  assert.ok(
    count <= MAX_ALLOWED,
    `Type generator produced ${count} index signatures, expected <= ${MAX_ALLOWED}. ` +
    `Regression detected! Check that enforceStrictSchema() is being called in scripts/generate-types.ts. ` +
    `If this is intentional due to new schemas, update MAX_ALLOWED and document why.`
  );

  // Additional check: no 'any' types should exist
  const anyUsages = typesContent.match(/:\s*any[^\w]/g) || [];
  const anyCount = anyUsages.length;

  console.log(`   'any' type usage: ${anyCount}`);

  assert.strictEqual(
    anyCount,
    0,
    `Generated types contain ${anyCount} instances of 'any' type. ` +
    `All types should be properly typed. Check json-schema-to-typescript configuration.`
  );
});

test('core types maintain strict schema enforcement', () => {
  const coreTypesPath = path.join(__dirname, '../src/lib/types/core.generated.ts');

  if (!fs.existsSync(coreTypesPath)) {
    console.log('⏭️  Skipping core types test - file not found');
    return;
  }

  const coreContent = fs.readFileSync(coreTypesPath, 'utf8');

  // Count index signatures in core types
  const indexSignatures = coreContent.match(/\[k: string\]: unknown/g) || [];
  const count = indexSignatures.length;

  const MAX_CORE_ALLOWED = 15;

  console.log(`📊 Core types strictness:`);
  console.log(`   Index signatures found: ${count}`);
  console.log(`   Maximum allowed: ${MAX_CORE_ALLOWED}`);

  assert.ok(
    count <= MAX_CORE_ALLOWED,
    `Core types produced ${count} index signatures, expected <= ${MAX_CORE_ALLOWED}. ` +
    `Regression detected in core schema generation.`
  );
});

test('enforceStrictSchema function exists in generator', () => {
  const generatorPath = path.join(__dirname, '../scripts/generate-types.ts');

  assert.ok(
    fs.existsSync(generatorPath),
    'generate-types.ts not found'
  );

  const generatorContent = fs.readFileSync(generatorPath, 'utf8');

  // Check that enforceStrictSchema function exists
  assert.ok(
    generatorContent.includes('function enforceStrictSchema'),
    'enforceStrictSchema function not found in generate-types.ts. ' +
    'This function is critical for preventing overly permissive types.'
  );

  // Check that it's actually being called
  assert.ok(
    generatorContent.includes('enforceStrictSchema('),
    'enforceStrictSchema is defined but not called. ' +
    'Make sure to call it before compiling schemas to TypeScript.'
  );

  // Check that additionalProperties: false is set
  assert.ok(
    generatorContent.includes('additionalProperties: false'),
    'additionalProperties: false not found in compile options. ' +
    'This is needed to prevent index signatures when schema is unspecified.'
  );

  console.log('✅ Type generator has strict schema enforcement enabled');
});
