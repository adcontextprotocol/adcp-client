const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function postProcessObjectIntersections(input) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-object-intersections-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.txt');
  const generateZodPath = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(generateZodPath)};

const input = ${JSON.stringify(input)};
writeFileSync(${JSON.stringify(outPath)}, __test__.postProcessObjectIntersections(input));
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
