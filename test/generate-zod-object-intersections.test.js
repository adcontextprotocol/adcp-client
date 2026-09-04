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

function postProcessRecordIntersections(input) {
  return runPostProcess('postProcessRecordIntersections', input, '.zod-record-intersections-');
}

function postProcessRecordSizeConstraints(input) {
  return runPostProcess('postProcessRecordSizeConstraints', input, '.zod-record-size-');
}

function relaxArrayCardinalityTypes(input) {
  return runPostProcess('relaxArrayCardinalityTypes', input, '.zod-array-cardinality-');
}

function postProcessTupleRestArrays(input) {
  return runPostProcess('postProcessTupleRestArrays', input, '.zod-tuple-rest-');
}

function postProcessArrayMaxItems(typeSource, zodSource, passes = 1) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-array-max-items-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.txt');
  const generateZodPath = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(generateZodPath)};
let output = ${JSON.stringify(zodSource)};
for (let pass = 0; pass < ${JSON.stringify(passes)}; pass++) {
  output = __test__.postProcessArrayMaxItems(output, ${JSON.stringify(typeSource)});
}
writeFileSync(${JSON.stringify(outPath)}, output);
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return fs.readFileSync(outPath, 'utf8');
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

function postProcessMarkerUnionObjectIntersections(input) {
  return runPostProcess('postProcessMarkerUnionObjectIntersections', input, '.zod-marker-union-');
}

function postProcessRepeatedProductIntersections(input) {
  return runPostProcess('postProcessRepeatedProductIntersections', input, '.zod-product-intersections-');
}

function postProcessObjectUnionIntersections(input) {
  return runPostProcess('postProcessObjectUnionIntersections', input, '.zod-object-union-');
}

function reportingStatusViewRequiredFields(input) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-reporting-status-required-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.json');
  const generateZodPath = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(generateZodPath)};
writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(__test__.reportingStatusViewRequiredFields(${JSON.stringify(input)})));
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

function postProcessGetReportingStatusViewRequiredFields(input, requiredByView) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-reporting-status-views-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.txt');
  const generateZodPath = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(generateZodPath)};
writeFileSync(${JSON.stringify(outPath)}, __test__.postProcessGetReportingStatusViewRequiredFields(${JSON.stringify(input)}, ${JSON.stringify(requiredByView)}));
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return fs.readFileSync(outPath, 'utf8');
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

function postProcessReportingEvidenceStrictness(input) {
  return runPostProcess('postProcessReportingEvidenceStrictness', input, '.zod-reporting-strictness-');
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

test('reporting-status view post-processor restores source required fields', () => {
  const source = {
    allOf: [
      { properties: { status: { type: 'string' } }, required: ['status'] },
      { required: ['shared_required_field'] },
    ],
    oneOf: [
      {
        oneOf: [
          { properties: { view: { const: 'summary' } }, required: ['view', 'ledger_snapshot_id', 'health'] },
          {
            properties: { view: { const: 'summary' } },
            required: ['health', 'view', 'ledger_snapshot_id'],
          },
          {
            properties: { view: { const: 'periods' } },
            required: ['view', 'ledger_snapshot_id', 'periods', 'materializations', 'pagination'],
          },
          {
            properties: { view: { const: 'revision' } },
            required: ['view', 'ledger_snapshot_id', 'revision', 'pagination'],
          },
        ],
      },
    ],
  };
  const requiredByView = reportingStatusViewRequiredFields(source);
  assert.deepEqual(requiredByView, {
    summary: ['status', 'shared_required_field', 'view', 'ledger_snapshot_id', 'health'],
    periods: [
      'status',
      'shared_required_field',
      'view',
      'ledger_snapshot_id',
      'periods',
      'materializations',
      'pagination',
    ],
    revision: ['status', 'shared_required_field', 'view', 'ledger_snapshot_id', 'revision', 'pagination'],
  });

  const output = postProcessGetReportingStatusViewRequiredFields(
    `
export const SummaryViewSchema = z.object({ status: z.literal("completed"), view: z.literal("summary") }).passthrough();

export const PeriodsViewSchema = z.object({ status: z.literal("completed"), view: z.literal("periods"), pagination: z.object({}).passthrough() }).passthrough();

export const RevisionViewSchema = z.object({ status: z.literal("completed"), view: z.literal("revision"), pagination: z.object({}).passthrough() }).passthrough();
`,
    requiredByView
  );

  assert.match(
    output,
    /SummaryViewSchema[\s\S]*?\["status","shared_required_field","view","ledger_snapshot_id","health"\][\s\S]*?Required by get_reporting_status summary view/
  );
  assert.match(
    output,
    /PeriodsViewSchema[\s\S]*?\["status","shared_required_field","view","ledger_snapshot_id","periods","materializations","pagination"\][\s\S]*?Required by get_reporting_status periods view/
  );
  assert.match(
    output,
    /RevisionViewSchema[\s\S]*?\["status","shared_required_field","view","ledger_snapshot_id","revision","pagination"\][\s\S]*?Required by get_reporting_status revision view/
  );
});

test('reporting evidence post-processor makes only closed reporting schemas strict', () => {
  const names = [
    'ReportingCoverage',
    'ReportingStatusIssue',
    'ReportingCanonicalContentDigest',
    'IntegerReportingControlTotal',
    'DecimalReportingControlTotal',
    'SHA256PhysicalChecksum',
    'SHA512PhysicalChecksum',
    'ReportingResource',
    'ReportingVerification',
    'ReportingSchedule',
    'ReportingReceipt',
    'ReportingRevision',
    'ReportingObligation',
    'ReportingMaterialization',
  ];
  const input = `${names.map(name => `export const ${name}Schema = z.object({ nested: z.object({}).passthrough() }).passthrough();`).join('\n\n')}

export const ExtensionFriendlySchema = z.object({}).passthrough();
`;
  const output = postProcessReportingEvidenceStrictness(input);

  for (const name of names) {
    assert.match(
      output,
      new RegExp(`${name}Schema = z\\.object\\(\\{ nested: z\\.object\\(\\{\\}\\)\\.strict\\(\\) \\}\\)\\.strict\\(\\)`)
    );
  }
  assert.match(output, /ExtensionFriendlySchema = z\.object\(\{\}\)\.passthrough\(\)/);
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

test('postProcessMarkerUnionObjectIntersections collapses nested opaque marker unions', () => {
  const output = postProcessMarkerUnionObjectIntersections(`
export const FixedSchema = z.record(z.string(), z.unknown());
export const ResponsiveSchema = z.record(z.string(), z.unknown());
export const FluidSchema = z.record(z.string(), z.unknown());
export const StaticSizeSchema = z.union([FixedSchema, ResponsiveSchema]);
export const SizeModeMutexSchema = z.union([
  StaticSizeSchema,
  z.union([FluidSchema, z.record(z.string(), z.unknown())])
]);

export const CanonicalFormatImageSchema = SizeModeMutexSchema.and(z.object({
  width: z.number().optional(),
  height: z.number().optional()
}).passthrough());
`);

  assert.match(output, /export const CanonicalFormatImageSchema = z\.object\(/);
  assert.doesNotMatch(output, /CanonicalFormatImageSchema = SizeModeMutexSchema\.and/);
});

test('postProcessRecordIntersections collapses nested named record-only unions', () => {
  const output = postProcessRecordIntersections(`
export const FixedSchema = z.record(z.string(), z.unknown());
export const ResponsiveSchema = z.record(z.string(), z.unknown());
export const FluidSchema = z.record(z.string(), z.unknown());
export const StaticSizeSchema = z.union([FixedSchema, ResponsiveSchema]);
export const SizeModeMutexSchema = z.union([
  StaticSizeSchema,
  z.union([FluidSchema, z.record(z.string(), z.unknown())])
]);

export const CanonicalFormatImageSchema = SizeModeMutexSchema.and(z.object({
  width: z.number().optional(),
  height: z.number().optional()
}));
`);

  assert.match(output, /export const CanonicalFormatImageSchema = z\.object\(/);
  assert.doesNotMatch(output, /CanonicalFormatImageSchema = SizeModeMutexSchema\.and/);
});

test('postProcessRecordIntersections preserves typed record constraints as object catchalls', () => {
  const output = postProcessRecordIntersections(`
export const MediaBuyFeaturesSchema = z.record(z.string(), z.boolean()).and(z.object({
  inline_creative_management: z.boolean().optional(),
  audience_targeting: z.boolean().optional()
}));
`);

  assert.match(output, /export const MediaBuyFeaturesSchema = z\.object\(/);
  assert.match(output, /\.catchall\(z\.boolean\(\)\)/);
  assert.doesNotMatch(output, /MediaBuyFeaturesSchema = z\.record\(z\.string\(\), z\.boolean\(\)\)\.and/);
});

test('postProcessRecordSizeConstraints strips unsupported record max/min/length calls', () => {
  const output = postProcessRecordSizeConstraints(`
export const CappedSchema = z.record(z.string(), z.unknown()).max(1000);
export const NestedSchema = z.record(z.string(), z.union([z.string(), z.number()])).min(1);
export const ExactSchema = z.record(z.string(), z.boolean()).length(2);
export const ArraySchema = z.array(z.string()).max(5);
`);

  assert.match(output, /CappedSchema = z\.record\(z\.string\(\), z\.unknown\(\)\);/);
  assert.match(output, /NestedSchema = z\.record\(z\.string\(\), z\.union\(\[z\.string\(\), z\.number\(\)\]\)\);/);
  assert.match(output, /ExactSchema = z\.record\(z\.string\(\), z\.boolean\(\)\);/);
  assert.match(output, /ArraySchema = z\.array\(z\.string\(\)\)\.max\(5\);/);
});

test('relaxArrayCardinalityTypes uses source metadata and preserves structural tuples', () => {
  const output = relaxArrayCardinalityTypes(`
/** @minItems 1 */
export type ComplexArray = [{ /** Item value. */ value: string }, ...{ /** Item value. */ value: string }[]];
/**
 * @minItems 1
 * @maxItems 3
 */
export type BoundedArray =
  | [{ value: string }]
  | [{ value: string }, { value: string }]
  | [{ value: string }, { value: string }, { value: string }];
/** @minItems 2 @maxItems 2 */
export type Coordinate = [number, number];
export type StructuralTupleUnion = [string] | [string, string];
`);

  assert.match(output, /type ComplexArray = \{[\s\S]*?value: string;?[\s\S]*?\}\[\]/);
  assert.match(output, /Item value\./);
  assert.match(output, /type BoundedArray =\s*\{\s*value: string;?\s*\}\[\]/);
  assert.match(output, /type Coordinate = \[\s*number,\s*number\s*\]/);
  assert.match(output, /type StructuralTupleUnion = \[\s*string\s*\] \| \[\s*string,\s*string\s*\]/);
});

test('relaxArrayCardinalityTypes makes maxItems properties assignable from ordinary arrays', () => {
  const output = relaxArrayCardinalityTypes(`
export interface ReportingDeliveryConfigurationState {}
export interface Account {
  /** @maxItems 16 */
  reporting_delivery_configs?:
    | []
    | [ReportingDeliveryConfigurationState]
    | [ReportingDeliveryConfigurationState, ReportingDeliveryConfigurationState];
}
`);

  assert.match(output, /reporting_delivery_configs\?:\s*ReportingDeliveryConfigurationState\[\];/);
  assert.doesNotMatch(output, /reporting_delivery_configs\?:\s*\| \[\]/);
});

test('relaxArrayCardinalityTypes is idempotent for relaxed intersection arrays', () => {
  const source = `
export interface AttestationReference {}
/** @maxItems 3 */
export type AttestationRefs = (AttestationReference & {
  /** Inline provenance. */
  required: true;
})[];
/** @maxItems 4 */
export type Matrix = [number, number][];
/** @maxItems 4 */
export type GenericMatrix = Array<[number, number]>;
`;

  assert.equal(relaxArrayCardinalityTypes(source), source);

  const bounded = `
export interface AttestationReference {}
/** @maxItems 2 */
export type AttestationRefs =
  | [AttestationReference & { required: true }]
  | [AttestationReference & { required: true }, AttestationReference & { required: true }];
`;
  const relaxed = relaxArrayCardinalityTypes(bounded);
  assert.equal(relaxArrayCardinalityTypes(relaxed), relaxed);
});

test('generated Account maxItems property accepts dynamically assembled arrays', () => {
  const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-maxitems-types-'));
  const reproPath = path.join(tmpDir, 'repro.ts');
  fs.writeFileSync(
    reproPath,
    `import type { Account, ReportingDeliveryConfigurationState } from '../src/lib/types/tools.generated';
declare const states: ReportingDeliveryConfigurationState[];
const configs: Account['reporting_delivery_configs'] = states;
void configs;
`
  );

  try {
    const result = spawnSync(
      'npx',
      [
        'tsc',
        reproPath,
        '--noEmit',
        '--skipLibCheck',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, `TypeScript repro failed:\n${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('postProcessArrayMaxItems restores metadata bounds without changing exact tuples', () => {
  const typeSource = `
export interface CreativeLocalePolicy {
  /**
   * @minItems 1
   * @maxItems 50
   */
  accepted_language_ranges: string[];
  nested_entries: {
    /** @maxItems 16 */
    reporting_delivery_configs?: number[];
  }[];
}
/** @minItems 2 @maxItems 2 */
export type Coordinate = [number, number];
`;
  const zodSource = `
export const CreativeLocalePolicySchema = z.object({
  accepted_language_ranges: z.array(z.string()),
  nested_entries: z.array(z.object({ reporting_delivery_configs: z.array(z.number()).optional() }))
});
export const CoordinateSchema = z.tuple([z.number(), z.number()]);
`;
  const output = postProcessArrayMaxItems(typeSource, zodSource);

  assert.match(output, /accepted_language_ranges: z\.array\(z\.string\(\)\)\.max\(50\)/);
  assert.match(output, /reporting_delivery_configs: z\.array\(z\.number\(\)\)\.max\(16\)\.optional\(\)/);
  assert.match(output, /CoordinateSchema = z\.tuple\(\[z\.number\(\), z\.number\(\)\]\)/);
  assert.doesNotMatch(output, /CoordinateSchema = z\.tuple[^;]*\.max\(/);
  assert.equal(postProcessArrayMaxItems(typeSource, output, 2), output);
});

test('postProcessArrayMaxItems keeps same-named root and nested paths distinct', () => {
  const output = postProcessArrayMaxItems(
    `
export interface Collision {
  /** @maxItems 2 */
  values: string[];
  nested: {
    /** @maxItems 3 */
    values: string[];
  };
  unbounded: { values: string[] };
}
`,
    `
export const CollisionSchema = z.object({
  values: z.array(z.string()),
  nested: z.object({ values: z.array(z.string()) }),
  unbounded: z.object({ values: z.array(z.string()) })
});
`
  );

  assert.match(output, /^\s*values: z\.array\(z\.string\(\)\)\.max\(2\),$/m);
  assert.match(output, /nested: z\.object\(\{ values: z\.array\(z\.string\(\)\)\.max\(3\) \}\)/);
  assert.match(output, /unbounded: z\.object\(\{ values: z\.array\(z\.string\(\)\) \}\)/);
});

test('generated Zod schemas enforce maxItems at the boundary', () => {
  const harnessDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-zod-maxitems-runtime-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const schemasPath = path.join(REPO_ROOT, 'src/lib/types/schemas.generated.ts');
  fs.writeFileSync(
    scriptPath,
    `
import assert from 'node:assert/strict';
import { AccountSchema, CreativeLocalePolicySchema } from ${JSON.stringify(schemasPath)};

const languages = (length: number) => Array.from({ length }, () => 'en');
assert.equal(CreativeLocalePolicySchema.safeParse({ accepted_language_ranges: languages(50) }).success, true);
assert.equal(CreativeLocalePolicySchema.safeParse({ accepted_language_ranges: languages(51) }).success, false);

const reportingConfig = {
  configuration: {
    delivery_config_id: 'config',
    delivery_config_version: 1,
    offering_id: 'offering',
    active: true,
    feed_purpose: 'pacing',
    report_definition_id: 'definition',
    reporting_profile: 'profile',
    scope: { all_media_buys: true },
    coverage_requirement: 'full',
    required_finality: 'snapshot',
    reconciliation_mode: 'delivery_only',
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'P1D' }
  },
  state: 'ready'
};
const account = (count: number) => ({
  account_id: 'account',
  name: 'Account',
  status: 'active',
  reporting_delivery_configs: Array.from({ length: count }, () => reportingConfig)
});
assert.equal(AccountSchema.safeParse(account(16)).success, true);
assert.equal(AccountSchema.safeParse(account(17)).success, false);
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `runtime boundary harness failed:\n${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
});

test('postProcessTupleRestArrays handles differently-indented complex items only', () => {
  const output = postProcessTupleRestArrays(`
export const ComplexArraySchema = z.tuple([z.object({
        value: z.string()
    }).passthrough()]).rest(z.object({
  value: z.string()
}).passthrough());
export const FixedTupleSchema = z.tuple([z.number(), z.number()]);
export const StructuralUnionSchema = z.union([
  z.tuple([z.string()]),
  z.tuple([z.string(), z.string()])
]);
export const DistinctRegexSchema = z.tuple([z.string().regex(/a b/)]).rest(z.string().regex(/ab/));
`);

  assert.match(output, /ComplexArraySchema = z\.array\(z\.object\(/);
  assert.match(output, /FixedTupleSchema = z\.tuple\(\[z\.number\(\), z\.number\(\)\]\)/);
  assert.match(output, /StructuralUnionSchema = z\.union\(/);
  assert.match(output, /DistinctRegexSchema = z\.tuple\(/);
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

test('postProcessRepeatedProductIntersections collapses repeated format and placement validators', () => {
  const output = postProcessRepeatedProductIntersections(`
export const CommonBFormatSchema = z.object({ value: z.string() }).passthrough();
export const FormatKindsSchema = z.union([z.object({ format_kind: z.literal("image") })]);
export const ProductFormatDeclarationSchema = z.object({ id: z.string() }).merge(CommonBFormatSchema)
  .and(FormatKindsSchema)
  .and(CommonBFormatSchema)
  .and(FormatKindsSchema)
  .and(CommonBFormatSchema)
  .and(FormatKindsSchema)
  .and(CommonBFormatSchema)
  .and(FormatKindsSchema);
export const PlacementBaseSchema = z.object({ placement_id: z.string() });
export const PlacementChoiceSchema = z.union([z.object({ required: z.boolean() })]);
export const PlacementSchema = PlacementBaseSchema
  .and(PlacementChoiceSchema)
  .and(CommonBFormatSchema)
  .and(PlacementChoiceSchema)
  .and(CommonBFormatSchema);
`);

  assert.match(
    output,
    /ProductFormatDeclarationSchema = z\.object\(\{ id: z\.string\(\) \}\)\.merge\(CommonBFormatSchema\)\.and\(FormatKindsSchema\);/
  );
  assert.match(
    output,
    /PlacementSchema = PlacementBaseSchema\.and\(PlacementChoiceSchema\)\.and\(CommonBFormatSchema\);/
  );
});

test('postProcessRepeatedProductIntersections fails closed when the common Product validator is not contained', () => {
  assert.throws(
    () =>
      postProcessRepeatedProductIntersections(`
export const ProductFormatDeclarationSchema = z.object({ id: z.string() })
  .and(z.literal("format"))
  .and(z.object({ constraint: z.string() }))
  .and(z.literal("format"))
  .and(z.object({ constraint: z.string() }))
  .and(z.literal("format"))
  .and(z.object({ constraint: z.string() }))
  .and(z.literal("format"));
export const PlacementSchema = z.object({ placement_id: z.string() });
`),
    /no longer matches the verified repeated allOf projection/
  );
});

test('postProcessRepeatedProductIntersections preserves literal whitespace semantics', () => {
  const output = postProcessRepeatedProductIntersections(`
export const ProductFormatDeclarationSchema = z.object({ product_id: z.string() });
export const PlacementSchema = z.literal("a b").and(z.literal("a  b")).and(z.literal("a b"));
`);

  assert.match(output, /PlacementSchema = z\.literal\("a b"\)\.and\(z\.literal\("a  b"\)\);/);
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

test('postProcessObjectIntersections handles typed exports with equals signs in annotations', () => {
  const output = postProcessObjectIntersections(`
export const BaseSchema: z.ZodType<FactoryOptions<DefaultValue = unknown>> = z.object({
  id: z.string().optional()
}).passthrough();

export const SafeSchema: z.ZodType<FactoryOptions<DefaultValue = unknown>> = BaseSchema.and(z.object({
  id: z.string(),
  name: z.string()
}).passthrough());
`);

  assert.match(
    output,
    /export const SafeSchema: z\.ZodType<FactoryOptions<DefaultValue = unknown>> = BaseSchema\.merge\(z\.object\(/
  );
  assert.doesNotMatch(output, /SafeSchema: z\.ZodType<FactoryOptions<DefaultValue = unknown>> = BaseSchema\.and/);
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
