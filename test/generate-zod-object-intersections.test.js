const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runPostProcess(methodName, input, tmpPrefix) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.txt');
  const generateZodPath = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(generateZodPath)};

const input = ${JSON.stringify(input)};
writeFileSync(${JSON.stringify(outPath)}, __test__[${JSON.stringify(methodName)}](input));
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return fs.readFileSync(outPath, 'utf8');
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

function postProcessObjectIntersections(input) {
  return runPostProcess('postProcessObjectIntersections', input, '.zod-object-intersections-');
}

function postProcessForNullish(input) {
  return runPostProcess('postProcessForNullish', input, '.zod-nullish-');
}

function postProcessMarkerUnionObjectIntersections(input) {
  return runPostProcess('postProcessMarkerUnionObjectIntersections', input, '.zod-marker-union-');
}

function postProcessObjectUnionIntersections(input) {
  return runPostProcess('postProcessObjectUnionIntersections', input, '.zod-object-union-');
}

test('postProcessForNullish keeps never optional constraints strict', () => {
  const output = postProcessForNullish(`
export const ExampleSchema = z.object({
  forbidden: z.never().optional(),
  allowed: z.string().optional()
}).passthrough();
`);

  assert.match(output, /forbidden: z\.never\(\)\.optional\(\)/);
  assert.match(output, /allowed: z\.string\(\)\.nullish\(\)/);
});

test('postProcessMarkerUnionObjectIntersections collapses opaque marker unions', () => {
  const output = postProcessMarkerUnionObjectIntersections(`
export const V1MarkerSchema = z.record(z.string(), z.unknown());
export const V2MarkerSchema = z.record(z.string(), z.unknown());

export const ProductSchema = z.union([V1MarkerSchema, V2MarkerSchema]).and(z.object({
  product_id: z.string(),
  name: z.string()
}).passthrough());
`);

  assert.match(output, /export const ProductSchema = z\.object\(/);
  assert.doesNotMatch(output, /ProductSchema = z\.union\(\[V1MarkerSchema, V2MarkerSchema\]\)\.and/);
});

test('postProcessMarkerUnionObjectIntersections collapses named opaque marker unions', () => {
  const output = postProcessMarkerUnionObjectIntersections(`
export const FixedSchema = z.record(z.string(), z.unknown());
export const ResponsiveSchema = z.record(z.string(), z.unknown());
export const SizeModeMutexSchema = z.union([FixedSchema, ResponsiveSchema]);

export const CanonicalFormatImageSchema = SizeModeMutexSchema.and(z.object({
  width: z.number().optional(),
  height: z.number().optional()
}).passthrough());
`);

  assert.match(output, /export const CanonicalFormatImageSchema = z\.object\(/);
  assert.doesNotMatch(output, /CanonicalFormatImageSchema = SizeModeMutexSchema\.and/);
});

test('postProcessMarkerUnionObjectIntersections keeps unions once markers gain fields', () => {
  const output = postProcessMarkerUnionObjectIntersections(`
export const V1MarkerSchema = z.object({
  format_id: z.string()
}).passthrough();
export const V2MarkerSchema = z.record(z.string(), z.unknown());

export const FutureProductSchema = z.union([V1MarkerSchema, V2MarkerSchema]).and(z.object({
  product_id: z.string(),
  name: z.string()
}).passthrough());
`);

  assert.match(output, /export const FutureProductSchema = z\.union\(\[V1MarkerSchema, V2MarkerSchema\]\)\.and/);
  assert.doesNotMatch(output, /FutureProductSchema = z\.object\(/);
});

test('postProcessObjectUnionIntersections distributes object envelope over union arms', () => {
  const output = postProcessObjectUnionIntersections(`
export const EnvelopeSchema = z.object({
  adcp_version: z.string().optional()
}).passthrough();

export const VariantASchema = z.object({
  kind: z.literal("a"),
  value: z.string()
}).passthrough();

export const VariantBSchema = z.object({
  kind: z.literal("b"),
  amount: z.number()
}).passthrough();

export const RequestSchema = EnvelopeSchema.and(z.union([VariantASchema, VariantBSchema]));
`);

  assert.match(
    output,
    /export const RequestSchema = z\.union\(\[EnvelopeSchema\.merge\(VariantASchema\), EnvelopeSchema\.merge\(VariantBSchema\)\]\)/
  );
  assert.doesNotMatch(output, /RequestSchema = EnvelopeSchema\.and\(z\.union/);
});

test('postProcessObjectUnionIntersections keeps conflicting arms as intersections', () => {
  const output = postProcessObjectUnionIntersections(`
export const EnvelopeSchema = z.object({
  kind: z.string()
}).passthrough();

export const VariantASchema = z.object({
  kind: z.literal("a")
}).passthrough();

export const RequestSchema = EnvelopeSchema.and(z.union([VariantASchema]));
`);

  assert.match(output, /export const RequestSchema = EnvelopeSchema\.and\(z\.union\(\[VariantASchema\]\)\)/);
  assert.doesNotMatch(output, /RequestSchema = z\.union/);
});

test('postProcessObjectIntersections merges safe object intersections', () => {
  const output = postProcessObjectIntersections(`
export const BaseSchema = z.object({
  id: z.string().optional(),
  ext: ExtensionObjectSchema.optional()
}).passthrough();

export const SafeSchema = BaseSchema.and(z.object({
  id: z.string(),
  name: z.string()
}).passthrough());

export const ContainerSchema = z.object({
  item: BaseSchema.and(z.object({
    name: z.string()
  }).passthrough())
}).passthrough();
`);

  assert.match(output, /export const SafeSchema = BaseSchema\.merge\(z\.object\(/);
  assert.match(output, /item: BaseSchema\.merge\(z\.object\(/);
  assert.doesNotMatch(output, /SafeSchema = BaseSchema\.and/);
});

test('postProcessObjectIntersections keeps conflicting overlaps as intersections', () => {
  const output = postProcessObjectIntersections(`
export const BaseSchema = z.object({
  id: z.string()
}).passthrough();

export const ConflictSchema = BaseSchema.and(z.object({
  id: z.number()
}).passthrough());
`);

  assert.match(output, /export const ConflictSchema = BaseSchema\.and\(z\.object\(/);
  assert.doesNotMatch(output, /ConflictSchema = BaseSchema\.merge/);
});

test('postProcessObjectIntersections does not treat trailing-combinator schemas as ZodObject bases', () => {
  const output = postProcessObjectIntersections(`
export const RefinedBaseSchema = z.object({
  id: z.string()
}).passthrough().refine(value => value.id.length > 0);

export const UnionBaseSchema = z.object({
  kind: z.string()
}).passthrough().and(z.union([
  z.object({ kind: z.literal("a") }).passthrough()
]));

export const UsesRefinedSchema = RefinedBaseSchema.and(z.object({
  name: z.string()
}).passthrough());

export const UsesUnionBaseSchema = UnionBaseSchema.and(z.object({
  name: z.string()
}).passthrough());
`);

  assert.match(output, /export const UsesRefinedSchema = RefinedBaseSchema\.and\(z\.object\(/);
  assert.match(output, /export const UsesUnionBaseSchema = UnionBaseSchema\.and\(z\.object\(/);
  assert.doesNotMatch(output, /UsesRefinedSchema = RefinedBaseSchema\.merge/);
  assert.doesNotMatch(output, /UsesUnionBaseSchema = UnionBaseSchema\.merge/);
});
