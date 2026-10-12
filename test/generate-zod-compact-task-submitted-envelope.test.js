const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

// One tsx spawn per test: the harness body runs against `__test__` with `fixture()` in scope.
function runHarness(prefix, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const harness = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import { __test__ } from ${JSON.stringify(GENERATOR)};
const run = __test__.postProcessCompactTaskSubmittedEnvelope;

// Final-stage emission (after the canonical primitive constraints, before PURE wrapping). Nested
// \`message\`/\`task_id\` keys must never count as top-level overlap.
function fixture(edit: (s: string) => string = s => s): string {
  return edit([
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
    '    message: z.string().optional(),',
    '    payload: z.object({',
    '        message: z.string().min(5),',
    '        errors: z.array(z.string()).min(1)',
    '    }).passthrough().optional()',
    '}).passthrough();',
    '',
    'export const CompactTaskSubmittedSchema = AdCPVersionEnvelopeSchema.merge(ProtocolEnvelopeSchema).and(z.object({',
    '    status: z.literal("submitted"),',
    '    task_id: z.string().min(1),',
    '    message: z.string().max(2000).optional(),',
    '    errors: z.array(z.object({ task_id: z.string().min(9) }).passthrough()).optional(),',
    '    context: ContextObjectSchema.optional(),',
    '    ext: ExtensionObjectSchema.optional()',
    '}).passthrough());',
    '',
    'export const RequestProposalsAsyncSubmittedSchema = CompactTaskSubmittedSchema;',
  ].join('\\n'));
}
function swap(from: string, to: string) {
  return (s: string) => {
    assert.ok(s.includes(from), 'fixture is missing ' + from);
    return s.replace(from, to);
  };
}
${body}
`
  );
  try {
    const result = spawnSync('npx', ['tsx', harness], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('compact submitted envelope: merges the reviewed overlap and leaves everything else untouched', () => {
  runHarness(
    'adcp-zod-compact-ok-',
    `
const input = fixture();
const output = run(input);
assert.match(output, /CompactTaskSubmittedSchema = AdCPVersionEnvelopeSchema\\.merge\\(ProtocolEnvelopeSchema\\)\\.merge\\(z\\.object\\(\\{/);
assert.doesNotMatch(output, /\\.and\\(z\\.object/);
assert.equal(output.replace('.merge(z.object({\\n    status', '.and(z.object({\\n    status'), input);
assert.match(output, /export const RequestProposalsAsyncSubmittedSchema = CompactTaskSubmittedSchema;/);
`
  );
});

test('compact submitted envelope: a new top-level overlap with either envelope fails generation', () => {
  runHarness(
    'adcp-zod-compact-overlap-',
    `
// ProtocolEnvelope gains a required \`errors\` while the compact object keeps its optional one.
assert.throws(
  () => run(fixture(swap("    status: TaskStatusSchema,", "    errors: z.array(ErrorSchema).min(1),\\n    status: TaskStatusSchema,"))),
  /top-level overlap with the envelopes changed.*errors/
);
// AdCPVersionEnvelope gains a field the compact object also declares.
assert.throws(
  () => run(fixture(swap("    adcp_version: z.string().optional(),", "    adcp_version: z.string().optional(),\\n    ext: ExtensionObjectSchema.optional(),"))),
  /top-level overlap with the envelopes changed.*ext/
);
// Both envelopes declaring the same key is ambiguous.
assert.throws(
  () => run(fixture(swap("    adcp_version: z.string().optional(),", "    adcp_version: z.string().optional(),\\n    message: z.string().optional(),"))),
  /declared by both envelopes/
);
// A key the compact object stops redeclaring shrinks the overlap set.
assert.throws(
  () => run(fixture(swap("    context: ContextObjectSchema.optional(),\\n    ext:", "    ext:"))),
  /top-level overlap with the envelopes changed/
);
`
  );
});

test('compact submitted envelope: constraint drift on an overlapping field fails generation', () => {
  runHarness(
    'adcp-zod-compact-drift-',
    `
// Envelope side tightens: merge would silently drop it.
assert.throws(() => run(fixture(swap('    message: z.string().optional(),\\n    payload', '    message: z.string().max(10).optional(),\\n    payload'))), /overlapping field message changed/);
assert.throws(() => run(fixture(swap('    task_id: z.string().optional(),', '    task_id: z.string().min(3).optional(),'))), /overlapping field task_id changed/);
assert.throws(() => run(fixture(swap('    status: TaskStatusSchema,', '    status: TaskStatusSchema.refine(s => s !== "unknown"),'))), /overlapping field status changed/);
// Compact side loosens: running before the canonical primitive constraints (no min(1) yet) must fail closed.
assert.throws(() => run(fixture(swap('    task_id: z.string().min(1),', '    task_id: z.string(),'))), /overlapping field task_id changed/);
assert.throws(() => run(fixture(swap('    message: z.string().max(2000).optional(),', '    message: z.string().optional(),'))), /overlapping field message changed/);
`
  );
});

test('compact submitted envelope: unknown-key policy and structure drift fail generation', () => {
  runHarness(
    'adcp-zod-compact-structure-',
    `
assert.throws(() => run(fixture(swap('    adcp_major_version: z.number().int().gte(1).lte(99).optional()\\n}).passthrough();', '    adcp_major_version: z.number().int().gte(1).lte(99).optional()\\n}).strict();'))), /AdCPVersionEnvelopeSchema is no longer a passthrough object/);
assert.throws(() => run(fixture(swap('    }).passthrough().optional()\\n}).passthrough();', '    }).passthrough().optional()\\n});'))), /ProtocolEnvelopeSchema is no longer a passthrough object/);
assert.throws(() => run(fixture(swap('    ext: ExtensionObjectSchema.optional()\\n}).passthrough());', '    ext: ExtensionObjectSchema.optional()\\n}).strict());'))), /CompactTaskSubmittedSchema is no longer a passthrough object/);
// Spread / computed members cannot be reasoned about.
assert.throws(() => run(fixture(swap('    context_id: z.string().optional(),', '    ...Shared,\\n    context_id: z.string().optional(),'))), /non-plain top-level property/);
// Missing declarations and an already-merged (or otherwise reshaped) intersection.
assert.throws(() => run('export const TailSchema = z.string();\\n\\nexport const Other = 1;'), /unable to locate AdCPVersionEnvelopeSchema/);
assert.throws(() => run(run(fixture())), /expected the generated envelope intersection/);
assert.throws(() => run(fixture(swap('.merge(ProtocolEnvelopeSchema).and(z.object({', '.merge(ProtocolEnvelopeSchema).and(SomethingElseSchema).and(z.object({'))), /expected the generated envelope intersection/);
`
  );
});

test('compact submitted envelope: the pass runs after the canonical constraint passes it inspects', () => {
  // The guard compares the FINAL emitted narrowings (task_id min(1), message max(2000)); at an earlier
  // pipeline stage those are not applied yet, so the call must stay after them and before PURE wrapping.
  const source = fs.readFileSync(GENERATOR, 'utf8');
  const at = needle => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, 'generator no longer calls ' + needle);
    return index;
  };
  const call = at('zodSchemas = postProcessCompactTaskSubmittedEnvelope(zodSchemas);');
  for (const earlier of [
    'zodSchemas = postProcessCanonicalPrimitiveConstraints(zodSchemas);',
    'zodSchemas = postProcessCanonicalVastAudioConstraints(zodSchemas);',
    'zodSchemas = postProcessPricingOptionConstraints(zodSchemas);',
    'zodSchemas = postProcessJsonSchemaUriFormats(zodSchemas);',
  ]) {
    assert.ok(at(earlier) < call, earlier + ' must run before the compact envelope pass');
  }
  assert.ok(call < at('postProcessPureInitializers(addBackwardCompatSchemaAliases(zodSchemas))'));
  assert.equal(source.split('zodSchemas = postProcessCompactTaskSubmittedEnvelope(').length - 1, 1);
});
