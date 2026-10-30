// adcp-client#3512: the submitted task body stays a ZodObject because the
// generic object-intersection rewrite proves each merge exact, not because a
// pass knows one schema's field-by-field layout. Both the 3.3.0-beta.2 layout
// (the compact object restates narrowed envelope fields) and the adcp#8547
// layout (`allOf` of the protocol envelope and `core/task-submitted.json`)
// must merge, and a merge that would change what validates must not happen.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');
const ZOD = require.resolve('zod', { paths: [REPO_ROOT] });

/** Run the propagating rewrite on `input`, then evaluate the output with Zod and run `checks`. */
function runHarness(prefix, input, checks) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const harness = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import { z } from ${JSON.stringify(ZOD)};
import { __test__ } from ${JSON.stringify(GENERATOR)};

const input = ${JSON.stringify(input)};
const output = __test__.postProcessObjectIntersections(input, { propagate: true });
const prelude = [
  'const ContextObjectSchema = z.object({}).passthrough();',
  'const ExtensionObjectSchema = z.object({}).passthrough();',
  'const ErrorSchema = z.object({ code: z.string(), message: z.string() }).passthrough();',
].join('\\n');
const names = [...output.matchAll(/^export const (\\w+Schema)\\b/gm)].map(match => match[1]);
const schemas: Record<string, any> = new Function(
  'z',
  prelude + '\\n' + output.replace(/^export const /gm, 'const ') + '\\nreturn { ' + names.join(', ') + ' };'
)(z);
${checks}
`
  );
  try {
    const result = spawnSync('npx', ['tsx', harness], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const TASK_STATUS =
  'export const TaskStatusSchema = z.union([z.literal("submitted"), z.literal("working"), z.literal("completed"), z.literal("failed")]);';

// AdCP 3.3.0-beta.2: the compact object narrows envelope fields locally.
const BETA2_LAYOUT = [
  TASK_STATUS,
  '',
  'export const AdCPVersionEnvelopeSchema = z.object({',
  '    adcp_version: z.string().optional(),',
  '    adcp_major_version: z.number().int().gte(1).lte(99).optional()',
  '}).passthrough();',
  '',
  'export const ProtocolEnvelopeSchema = z.object({',
  '    context_id: z.string().optional(),',
  '    context: ContextObjectSchema.optional(),',
  '    task_id: z.string().optional(),',
  '    status: TaskStatusSchema,',
  '    message: z.string().optional()',
  '}).passthrough();',
  '',
  'export const CompactTaskSubmittedSchema = AdCPVersionEnvelopeSchema.merge(ProtocolEnvelopeSchema).and(z.object({',
  '    status: z.literal("submitted"),',
  '    task_id: z.string().min(1),',
  '    message: z.string().max(2000).optional(),',
  '    errors: z.array(ErrorSchema).optional(),',
  '    context: ContextObjectSchema.optional(),',
  '    ext: ExtensionObjectSchema.optional()',
  '}).passthrough());',
  '',
  'export const RefineProposalsAsyncSubmittedSchema = CompactTaskSubmittedSchema.and(z.object({',
  '    expected_confirmation_at: z.string().optional()',
  '}).passthrough());',
].join('\n');

// adcp#8547: every envelope field is defined once and composed through allOf/$ref.
const COMPOSED_LAYOUT = [
  TASK_STATUS,
  '',
  'export const TaskIDSchema = z.string().min(1);',
  '',
  'export const TaskMessageSchema = z.string().max(2000);',
  '',
  'export const AdCPVersionEnvelopeSchema = z.object({',
  '    adcp_version: z.string().optional(),',
  '    adcp_major_version: z.number().int().gte(1).lte(99).optional()',
  '}).passthrough();',
  '',
  'export const ProtocolEnvelopeSchema = AdCPVersionEnvelopeSchema.and(z.object({',
  '    context_id: z.string().optional(),',
  '    context: ContextObjectSchema.optional(),',
  '    task_id: TaskIDSchema.optional(),',
  '    status: TaskStatusSchema,',
  '    message: TaskMessageSchema.optional()',
  '}).passthrough());',
  '',
  'export const TaskSubmittedSchema = z.object({',
  '    status: z.literal("submitted"),',
  '    task_id: TaskIDSchema',
  '}).passthrough();',
  '',
  'export const CompactTaskSubmittedSchema = ProtocolEnvelopeSchema.and(TaskSubmittedSchema).and(z.object({',
  '    errors: z.array(ErrorSchema).optional(),',
  '    context: ContextObjectSchema.optional(),',
  '    ext: ExtensionObjectSchema.optional()',
  '}).passthrough());',
  '',
  'export const RefineProposalsAsyncSubmittedSchema = CompactTaskSubmittedSchema.and(z.object({',
  '    expected_confirmation_at: z.string().optional()',
  '}).passthrough());',
].join('\n');

// Same validation whichever layout produced the schema.
const SUBMITTED_BEHAVIOUR = `
for (const name of ['CompactTaskSubmittedSchema', 'RefineProposalsAsyncSubmittedSchema']) {
  assert.doesNotMatch(output, new RegExp('export const ' + name + ' = [^\\\\n]*\\\\.and\\\\('), name + ' stays an intersection');
  const schema = schemas[name];
  assert.equal(typeof schema.extend, 'function', name + ' must be a ZodObject');
  assert.ok(schema.shape.status && schema.shape.task_id && schema.shape.errors, name + ' exposes .shape');
  const ok = { status: 'submitted', task_id: 'task-1', message: 'queued', adcp_version: '3.3', extra: true };
  assert.deepEqual(schema.parse(ok), ok, 'unknown keys pass through');
  assert.equal(schema.safeParse({ ...ok, status: 'completed' }).success, false, 'status narrowed to submitted');
  assert.equal(schema.safeParse({ ...ok, task_id: '' }).success, false, 'task_id non-empty');
  const { task_id, ...withoutTaskId } = ok;
  assert.equal(schema.safeParse(withoutTaskId).success, false, 'task_id required');
  assert.equal(schema.safeParse({ ...ok, message: 'x'.repeat(2001) }).success, false, 'message bounded');
  assert.equal(schema.safeParse({ ...ok, adcp_major_version: 0 }).success, false, 'version envelope kept');
}
assert.ok(schemas.RefineProposalsAsyncSubmittedSchema.shape.expected_confirmation_at);
`;

test('beta.2 layout: the compact submitted body merges into a ZodObject with the same validation', () => {
  runHarness('adcp-zod-submitted-beta2-', BETA2_LAYOUT, SUBMITTED_BEHAVIOUR);
});

test('adcp#8547 layout: the composed submitted body merges into a ZodObject with the same validation', () => {
  runHarness('adcp-zod-submitted-composed-', COMPOSED_LAYOUT, SUBMITTED_BEHAVIOUR);
});

test('a merge that would change validation keeps the intersection', () => {
  const cases = {
    // A literal outside the envelope's union is not a narrowing.
    literal: ['status: z.literal("submitted")', 'status: z.literal("rejected")'],
    // A strict operand: `.merge()` keeps one operand's unknown-key policy, so it is
    // not provably the intersection. Stay conservative.
    strict: ['    task_id: TaskIDSchema\n}).passthrough();', '    task_id: TaskIDSchema\n}).strict();'],
  };
  const swap = ([from, to]) => {
    assert.ok(COMPOSED_LAYOUT.includes(from), `fixture is missing ${from}`);
    return COMPOSED_LAYOUT.replace(from, to);
  };
  runHarness(
    'adcp-zod-submitted-unsafe-literal-',
    swap(cases.literal),
    `assert.match(output, /CompactTaskSubmittedSchema = ProtocolEnvelopeSchema\\.and\\(TaskSubmittedSchema\\)/);`
  );
  runHarness(
    'adcp-zod-submitted-unsafe-strict-',
    swap(cases.strict),
    `assert.match(output, /CompactTaskSubmittedSchema = ProtocolEnvelopeSchema\\.and\\(TaskSubmittedSchema\\)/);`
  );
  // Narrowing judged per key: a wider string declaration is refused.
  runHarness(
    'adcp-zod-submitted-unsafe-widen-',
    COMPOSED_LAYOUT.replace(
      '    task_id: TaskIDSchema\n}).passthrough();',
      '    task_id: z.string()\n}).passthrough();'
    ),
    `assert.match(output, /CompactTaskSubmittedSchema = ProtocolEnvelopeSchema\\.and\\(TaskSubmittedSchema\\)/);`
  );
  // Required-from-optional is a narrowing, optional-from-required is not.
  runHarness(
    'adcp-zod-submitted-unsafe-optional-',
    COMPOSED_LAYOUT.replace(
      '    task_id: TaskIDSchema\n}).passthrough();',
      '    task_id: TaskIDSchema,\n    status: z.literal("submitted").optional()\n}).passthrough();'
    ).replace('    status: z.literal("submitted"),\n    task_id: TaskIDSchema,', '    task_id: TaskIDSchema,'),
    `assert.match(output, /CompactTaskSubmittedSchema = ProtocolEnvelopeSchema\\.and\\(TaskSubmittedSchema\\)/);`
  );
});
