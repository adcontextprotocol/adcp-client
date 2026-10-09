const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { runInNewContext } = require('node:vm');
const { resolve } = require('node:path');
const REPO_ROOT = resolve(__dirname, '..');

test('pure generated factories preserve references, lazy schemas, aliases, and refinements', async () => {
  const source = `
import { z } from 'zod';
const allowed = new Set(['accepted']);
export const LeafSchema = z.object({ value: z.string() }).superRefine((value, ctx) => {
  if (!allowed.has(value.value)) ctx.addIssue({ code: 'custom', message: 'not accepted' });
});
export const LegacyLeafSchema = LeafSchema;
export const LazyLeafSchema: z.ZodType<{ value: string }> = z.lazy(() => LegacyLeafSchema);
export const RecursiveSchema: z.ZodType<{ child?: unknown }> = z.lazy(() => z.object({ child: RecursiveSchema.optional() }));
export const KeptSchema = z.object({ leaf: LazyLeafSchema, recursive: RecursiveSchema.optional() });
export const UnusedSchema = z.object({ unused_schema_marker: z.array(z.string().min(1)) }).passthrough();
export const AnnotatedUnusedSchema = /* @__PURE__ */ z.object({
  value: z.string().describe('annotated_unused_schema_marker')
});
`;
  const generatorPath = resolve(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');
  const script = `
const { __test__ } = require(${JSON.stringify(generatorPath)});
const input = ${JSON.stringify(source)};
const output = __test__.postProcessPureInitializers(input);
require('node:assert/strict').equal(__test__.postProcessPureInitializers(output), output);
require('node:assert/strict').throws(() => __test__.postProcessPureInitializers('let schema = z.string();'), /must be const/);
require('node:assert/strict').throws(() => __test__.postProcessPureInitializers('Schema.register(registry);'), /may only contain/);
process.stdout.write(output);
`;
  const transformed = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  for (const schemaSource of [source, transformed]) {
    const result = await build({
      stdin: {
        contents: `import { KeptSchema, LegacyLeafSchema, LeafSchema } from 'generated-fixture';
globalThis.keptSchema = KeptSchema;
globalThis.aliasMatches = LegacyLeafSchema === LeafSchema;`,
        resolveDir: REPO_ROOT,
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'generated-fixture',
          setup(build) {
            build.onResolve({ filter: /^generated-fixture$/ }, () => ({
              path: 'generated-fixture',
              namespace: 'fixture',
            }));
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: schemaSource,
              loader: 'ts',
              resolveDir: REPO_ROOT,
            }));
          },
        },
      ],
    });
    const code = result.outputFiles[0].text;
    // Use the definitions as a consumer would: unneeded exports can be removed.
    assert.equal(code.includes('unused_schema_marker'), schemaSource === source);
    assert.equal(code.includes('annotated_unused_schema_marker'), schemaSource === source);
    const context = {};
    runInNewContext(code, context, { timeout: 10000 });
    assert.equal(context.aliasMatches, true);
    assert.equal(context.keptSchema.safeParse({ leaf: { value: 'accepted' } }).success, true);
    assert.equal(context.keptSchema.safeParse({ leaf: { value: 'accepted' }, recursive: { child: {} } }).success, true);
    assert.equal(context.keptSchema.safeParse({ leaf: { value: 'accepted' }, recursive: { child: 1 } }).success, false);
    assert.equal(context.keptSchema.safeParse({ leaf: { value: 'rejected' } }).success, false);
    assert.equal(context.keptSchema.safeParse({ leaf: { value: 1 } }).success, false);
  }
});
