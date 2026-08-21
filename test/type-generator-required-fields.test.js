const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_SCHEMA_DIR = path.join(REPO_ROOT, 'schemas/cache/latest/core');
const CORE_TYPES_PATH = path.join(REPO_ROOT, 'src/lib/types/core.generated.ts');

function runGeneratorHarness(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-required-fields-'));
  const script = path.join(dir, 'harness.ts');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(
    script,
    source
      .replaceAll('__GENERATOR__', JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-types.ts')))
      .replaceAll('__REPO_ROOT__', JSON.stringify(REPO_ROOT))
      .replaceAll('__OUTPUT__', JSON.stringify(output))
  );
  try {
    const result = spawnSync('npx', ['tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PostalCountrySystem propagates unconditional requirements into every anyOf branch', () => {
  const result = runGeneratorHarness(`
import { writeFileSync } from 'node:fs';
import { preservePostalCountrySystemRequiredness } from __GENERATOR__;

const schema = {
  title: 'Postal Country System',
  type: 'object',
  properties: { country: { type: 'string' }, system: { type: 'string' } },
  required: ['country', 'system'],
  anyOf: [
    { properties: { country: { const: 'US' }, system: { const: 'zip' } } },
    { properties: { country: { const: 'GB' }, system: { const: 'outward' } } },
  ],
};
const transformed = preservePostalCountrySystemRequiredness(schema);
writeFileSync(__OUTPUT__, JSON.stringify({
  branches: transformed.anyOf.map((branch: any) => branch.required),
  originalBranchesRemainUntouched: schema.anyOf.every((branch: any) => branch.required === undefined),
}));
`);

  assert.deepEqual(result.branches, [
    ['country', 'system'],
    ['country', 'system'],
  ]);
  assert.equal(result.originalBranchesRemainUntouched, true);
});

test('PostalArea preserves the native branch fields and non-empty values type', () => {
  const result = runGeneratorHarness(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyCodegenSchemaWorkarounds, enforceStrictSchema } from __GENERATOR__;

const source = JSON.parse(
  readFileSync(path.join(__REPO_ROOT__, 'schemas/cache/latest/core/postal-area.json'), 'utf8')
);
const transformed = applyCodegenSchemaWorkarounds(source, 'PostalArea');
const native = transformed.anyOf.find((branch: any) => branch.title === 'Postal Country Area');
const nested = enforceStrictSchema({ type: 'object', properties: { postal: source } })
  .properties.postal.anyOf.find((branch: any) => branch.title === 'Postal Country Area');
writeFileSync(__OUTPUT__, JSON.stringify({
  hasAllOf: Array.isArray(native.allOf),
  required: native.required,
  properties: Object.keys(native.properties),
  valuesMinItems: native.properties.values.minItems,
  valuesTsType: native.properties.values.tsType,
  nestedHasAllOf: Array.isArray(nested.allOf),
  nestedProperties: Object.keys(nested.properties),
}));
`);

  assert.equal(result.hasAllOf, false);
  assert.deepEqual(result.required, ['country', 'system', 'values']);
  assert.deepEqual(result.properties, ['country', 'system', 'values']);
  assert.equal(result.valuesMinItems, 1);
  assert.equal(result.valuesTsType, '[string, ...string[]]');
  assert.equal(result.nestedHasAllOf, false);
  assert.deepEqual(result.nestedProperties, ['country', 'system', 'values']);
});

test('GetMediaBuysResponse folds creative approval refinements without dropping base fields', () => {
  const result = runGeneratorHarness(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyCodegenSchemaWorkarounds } from __GENERATOR__;

const source = JSON.parse(
  readFileSync(path.join(__REPO_ROOT__, 'schemas/cache/latest/media-buy/get-media-buys-response.json'), 'utf8')
);
const transformed = applyCodegenSchemaWorkarounds(source, 'GetMediaBuysResponse');
const approval = transformed.properties.media_buys.items.properties.packages.items
  .properties.creative_approvals.items;
const indicatorTypeOverlay = (approval.properties.indicators.items.allOf ?? [])
  .find((member: any) => member.properties?.type);
const evaluatedTypeOverlay = (approval.properties.indicator_types_evaluated.items.allOf ?? [])
  .find((member: any) => member.enum);
writeFileSync(__OUTPUT__, JSON.stringify({
  hasAllOf: Array.isArray(approval.allOf),
  required: approval.required,
  properties: Object.keys(approval.properties),
  indicatorTypes: evaluatedTypeOverlay.enum,
  indicatorKinds: indicatorTypeOverlay.properties.type.enum,
}));
`);

  assert.equal(result.hasAllOf, false);
  assert.ok(result.required.includes('creative_id'));
  assert.ok(result.required.includes('approval_status'));
  for (const field of [
    'creative_id',
    'approval_status',
    'rejection_reason',
    'approval_scopes',
    'indicators',
    'indicator_types_evaluated',
    'indicators_as_of',
    'indicators_evaluated_scope',
  ]) {
    assert.ok(result.properties.includes(field), `${field} should remain in the approval shape`);
  }
  assert.deepEqual(result.indicatorTypes, ['creative_fatigue', 'creative_quality_opportunity']);
  assert.deepEqual(result.indicatorKinds, ['creative_fatigue', 'creative_quality_opportunity']);
});

test('refine_proposals result overlays preserve the canonical proposal base', () => {
  const result = runGeneratorHarness(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyCodegenSchemaWorkarounds, enforceStrictSchema } from __GENERATOR__;

const root = __REPO_ROOT__;
const source = JSON.parse(
  readFileSync(path.join(root, 'schemas/cache/latest/media-buy/refine-proposals-response.json'), 'utf8')
);
const transformed = enforceStrictSchema(applyCodegenSchemaWorkarounds(source, 'RefineProposalsResponse'));
const completed = transformed.oneOf.filter((branch: any) => branch.properties?.status?.const === 'completed');
const submitted = transformed.oneOf.filter((branch: any) => branch.properties?.status?.const === 'submitted');
const branches = completed.flatMap((branch: any) => branch.properties.results.items.oneOf);

function inspectIntersection(schema: any) {
  const members = schema.allOf ?? [];
  const canonical = members.find((member: any) =>
    typeof member?.$ref === 'string' && member.$ref.endsWith('/core/canonical-proposal.json')
  );
  const overlay = members.find((member: any) => member?.properties || member?.required);
  return {
    hasCanonicalRef: Boolean(canonical),
    required: overlay?.required ?? [],
    status: overlay?.properties?.proposal_status?.const,
    hasExpiry: Boolean(overlay?.properties?.expires_at),
    hasParentProposalIdProperty: overlay?.properties?.parent_proposal_id?.type === 'string',
  };
}

writeFileSync(__OUTPUT__, JSON.stringify({
  completedCount: completed.length,
  completedRequired: completed.map((branch: any) => branch.required),
  completedMinResults: completed.map((branch: any) => branch.properties.results.minItems),
  completedHasTaskId: completed.map((branch: any) => 'task_id' in branch.properties),
  outcomes: completed.map((branch: any) => branch.properties.results.items.oneOf.map((arm: any) => arm.properties.outcome.const)),
  submittedCount: submitted.length,
  submittedOutcomes: submitted.map((branch: any) => branch.properties.results.items.oneOf.map((arm: any) => arm.properties.outcome.const)),
  revised: inspectIntersection(branches.find((arm: any) => arm.properties.outcome.const === 'revised').properties.proposals.items),
  partial: inspectIntersection(branches.find((arm: any) => arm.properties.outcome.const === 'partial').properties.proposals.items),
  finalized: inspectIntersection(branches.find((arm: any) => arm.properties.outcome.const === 'finalized').properties.proposal),
}));
`);

  assert.equal(result.completedCount, 2);
  for (const required of result.completedRequired) {
    assert.ok(required.includes('results'));
    assert.ok(required.includes('products'));
  }
  assert.deepEqual(result.completedMinResults, [1, 1]);
  assert.deepEqual(result.completedHasTaskId, [false, false]);
  assert.deepEqual(result.outcomes, [['revised', 'partial', 'unable'], ['finalized']]);
  assert.equal(result.submittedCount, 2);
  assert.deepEqual(result.submittedOutcomes, [['revised', 'partial', 'unable'], ['finalized']]);

  for (const arm of [result.revised, result.partial, result.finalized]) {
    assert.equal(arm.hasCanonicalRef, true);
    assert.ok(arm.required.includes('proposal_status'));
    assert.ok(arm.required.includes('parent_proposal_id'));
    assert.equal(arm.hasParentProposalIdProperty, true);
  }
  assert.equal(result.revised.status, 'draft');
  assert.equal(result.partial.status, 'draft');
  assert.equal(result.finalized.status, 'committed');
  assert.ok(result.finalized.required.includes('expires_at'));
  assert.equal(result.finalized.hasExpiry, true);
});

test('request_proposals outcome branches retain products and legacy continuation fields', () => {
  const result = runGeneratorHarness(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyCodegenSchemaWorkarounds, enforceStrictSchema } from __GENERATOR__;

const source = JSON.parse(
  readFileSync(path.join(__REPO_ROOT__, 'schemas/cache/latest/media-buy/request-proposals-response.json'), 'utf8')
);
const transformed = enforceStrictSchema(applyCodegenSchemaWorkarounds(source, 'RequestProposalsResponse'));
const proposed = transformed.oneOf.find(
  (branch: any) => branch.properties?.outcome?.const === 'proposed'
);
const productsAvailable = transformed.oneOf.find(
  (branch: any) => branch.properties?.outcome?.const === 'products_available'
);
const legacyCreate = productsAvailable.properties.purchase_continuation.oneOf.find(
  (branch: any) => branch.properties?.kind?.const === 'legacy_create'
);
writeFileSync(__OUTPUT__, JSON.stringify({
  branchCount: transformed.oneOf.length,
  productsAvailableRequired: productsAvailable.required,
  productsAvailableProperties: Object.keys(productsAvailable.properties),
  productsMinItems: productsAvailable.properties.products.minItems,
  proposedForbidsContinuation: proposed.properties.purchase_continuation === false,
  productsAvailableForbidsProposals: productsAvailable.properties.proposals === false,
  continuationRequired: legacyCreate.required,
  continuationProperties: Object.keys(legacyCreate.properties),
}));
`);

  assert.equal(result.branchCount, 4);
  assert.ok(result.productsAvailableRequired.includes('products'));
  assert.ok(result.productsAvailableRequired.includes('purchase_continuation'));
  assert.ok(result.productsAvailableProperties.includes('purchase_continuation'));
  assert.equal(result.productsMinItems, 1);
  assert.equal(result.proposedForbidsContinuation, true);
  assert.equal(result.productsAvailableForbidsProposals, true);
  assert.ok(result.continuationRequired.includes('continuation_token'));
  assert.ok(result.continuationRequired.includes('losses'));
  assert.ok(result.continuationProperties.includes('product_ids'));
});

test('GetMediaBuyDeliveryResponse isolates optional breakdown identifiers under unique compat titles', () => {
  const result = runGeneratorHarness(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyCodegenSchemaWorkarounds } from __GENERATOR__;

const root = __REPO_ROOT__;
const specs = [
  ['by_catalog_item', 'Get Media Buy Delivery Catalog Item Metrics', ['content_id']],
  ['by_keyword', 'Get Media Buy Delivery Keyword Metrics', ['keyword', 'match_type']],
  ['by_geo', 'Get Media Buy Delivery Geo Metrics', ['geo_level', 'geo_code']],
  ['by_device_type', 'Get Media Buy Delivery Device Type Metrics', ['device_type']],
  ['by_device_platform', 'Get Media Buy Delivery Device Platform Metrics', ['device_platform']],
  ['by_audience', 'Get Media Buy Delivery Audience Metrics', ['audience_id', 'audience_source']],
  ['by_placement', 'Get Media Buy Delivery Placement Metrics', ['placement_id']],
];

function read(relative: string) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function inspect(schema: any) {
  const packageItems = schema.properties.media_buy_deliveries.items.properties.by_package.items;
  const members = [packageItems, ...(packageItems.allOf ?? [])];
  const packageDetails = members.find((member: any) => specs.some(([name]) => member?.properties?.[name]));
  const properties = packageDetails.properties;
  const breakdowns = Object.fromEntries(specs.map(([name, expectedTitle, optionalFields]) => {
    const item = properties[name].items;
    const required = [...(item.required ?? []), ...(item.allOf ?? []).flatMap((member: any) => member.required ?? [])];
    return [name, {
      title: item.title,
      expectedTitle,
      optionalFieldsAbsent: optionalFields.every((field: string) => !required.includes(field)),
      baseMetricsRemainRequired: required.includes('impressions') && required.includes('spend'),
      hasCanonicalId: Object.hasOwn(item, '$id'),
    }];
  }));
  return {
    breakdowns,
    responseCurrencyAbsent: !(schema.required ?? []).includes('currency'),
    responseBaseFieldsRemainRequired: ['reporting_period', 'media_buy_deliveries'].every(field =>
      (schema.required ?? []).includes(field)
    ),
    packageCompatFieldsAbsent: ['pricing_model', 'rate', 'currency'].every(
      field => !(packageDetails.required ?? []).includes(field)
    ),
    packageBaseFieldsRemainRequired: ['package_id', 'spend'].every(field =>
      (packageDetails.required ?? []).includes(field)
    ),
  };
}

function countUnrelatedKeywordRequirements(value: any, path: string[] = []): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce((count, entry, index) => count + countUnrelatedKeywordRequirements(entry, [...path, String(index)]), 0);
  }
  const ownCount =
    Array.isArray(value.required) && value.required.includes('keyword') && !path.includes('by_keyword') ? 1 : 0;
  return ownCount + Object.entries(value).reduce(
    (count, [key, entry]) => count + countUnrelatedKeywordRequirements(entry, [...path, key]),
    0
  );
}

const unbundledInput = read('schemas/cache/latest/media-buy/get-media-buy-delivery-response.json');
const bundledInput = read('schemas/cache/latest/bundled/media-buy/get-media-buy-delivery-response.json');
const unbundledBefore = JSON.stringify(unbundledInput);
const bundledBefore = JSON.stringify(bundledInput);
const bundledUnrelatedKeywordRequirements = countUnrelatedKeywordRequirements(bundledInput);
const unbundled = applyCodegenSchemaWorkarounds(unbundledInput, 'GetMediaBuyDeliveryResponse');
const bundled = applyCodegenSchemaWorkarounds(bundledInput, 'GetMediaBuyDeliveryResponse');
const noOpInput = { title: 'Unrelated response', type: 'object', properties: {} };
const noOpResult = applyCodegenSchemaWorkarounds(noOpInput, 'GetMediaBuyDeliveryResponse');
const canonicalRequired = Object.fromEntries([
  ['catalog', read('schemas/cache/latest/core/catalog-item-delivery-metrics.json')],
  ['keyword', read('schemas/cache/latest/core/keyword-delivery-metrics.json')],
  ['geo', read('schemas/cache/latest/core/geo-delivery-metrics.json')],
].map(([name, schema]: any) => [name, (schema.allOf ?? []).flatMap((member: any) => member.required ?? [])]));

writeFileSync(__OUTPUT__, JSON.stringify({
  unbundled: inspect(unbundled),
  bundled: inspect(bundled),
  canonicalRequired,
  inputsUnchanged: JSON.stringify(unbundledInput) === unbundledBefore && JSON.stringify(bundledInput) === bundledBefore,
  noOpPreservesIdentity: noOpResult === noOpInput,
  unrelatedKeywordRequirementsPreserved:
    bundledUnrelatedKeywordRequirements > 0 &&
    countUnrelatedKeywordRequirements(bundled) === bundledUnrelatedKeywordRequirements,
}));
`);

  for (const source of [result.unbundled, result.bundled]) {
    for (const entry of Object.values(source.breakdowns)) {
      assert.equal(entry.title, entry.expectedTitle);
      assert.equal(entry.optionalFieldsAbsent, true);
      assert.equal(entry.baseMetricsRemainRequired, true);
      assert.equal(entry.hasCanonicalId, false);
    }
    assert.equal(source.responseCurrencyAbsent, true);
    assert.equal(source.responseBaseFieldsRemainRequired, true);
    assert.equal(source.packageCompatFieldsAbsent, true);
    assert.equal(source.packageBaseFieldsRemainRequired, true);
  }
  assert.equal(result.inputsUnchanged, true);
  assert.equal(result.noOpPreservesIdentity, true);
  assert.equal(result.unrelatedKeywordRequirementsPreserved, true);
  assert.ok(result.canonicalRequired.catalog.includes('content_id'));
  assert.ok(result.canonicalRequired.keyword.includes('keyword'));
  assert.ok(result.canonicalRequired.keyword.includes('match_type'));
  assert.ok(result.canonicalRequired.geo.includes('geo_level'));
  assert.ok(result.canonicalRequired.geo.includes('geo_code'));
});

test('every unconditional canonical core required property is required in generated TypeScript', () => {
  const requiredByType = new Map();
  let requiredCellCount = 0;

  const schemaPaths = [];
  const directories = [CORE_SCHEMA_DIR];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) schemaPaths.push(entryPath);
    }
  }

  for (const schemaPath of schemaPaths) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    if (typeof schema.title !== 'string') continue;
    const typeName = schema.title.replace(/[^A-Za-z0-9]/g, '');
    const fields = requiredByType.get(typeName) ?? new Set();
    const collect = member => {
      if (!member?.properties || !Array.isArray(member.required)) return;
      for (const field of member.required) {
        if (typeof field === 'string' && Object.hasOwn(member.properties, field)) fields.add(field);
      }
    };
    collect(schema);
    for (const member of schema.allOf ?? []) collect(member);
    if (fields.size > 0) requiredByType.set(typeName, fields);
  }

  const source = ts.createSourceFile(
    CORE_TYPES_PATH,
    fs.readFileSync(CORE_TYPES_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = new Map();
  const declarationsByCaseFoldedName = new Map();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement);
      declarationsByCaseFoldedName.set(statement.name.text.toLowerCase(), statement);
    }
  }

  const memberState = (members, field) => {
    const member = members.find(
      candidate =>
        ts.isPropertySignature(candidate) &&
        (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
        candidate.name.text === field
    );
    if (!member) return 'absent';
    return member.questionToken ? 'optional' : 'required';
  };

  const typeNodeState = (node, field, seen) => {
    if (ts.isTypeLiteralNode(node)) return memberState(node.members, field);
    if (ts.isParenthesizedTypeNode(node)) return typeNodeState(node.type, field, seen);
    if (ts.isIntersectionTypeNode(node)) {
      const states = node.types.map(type => typeNodeState(type, field, seen));
      if (states.includes('required')) return 'required';
      if (states.includes('optional')) return 'optional';
      return 'absent';
    }
    if (ts.isUnionTypeNode(node)) {
      const states = node.types.map(type => typeNodeState(type, field, seen));
      if (states.length > 0 && states.every(state => state === 'required')) return 'required';
      if (states.some(state => state !== 'absent')) return 'optional';
      return 'absent';
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      return declarationState(node.typeName.text, field, seen);
    }
    return 'absent';
  };

  const declarationState = (typeName, field, seen = new Set()) => {
    const key = `${typeName}.${field}`;
    if (seen.has(key)) return 'absent';
    seen.add(key);
    // json-schema-to-typescript PascalCases words in titles (for example,
    // "Scoped creative approval" -> ScopedCreativeApproval), while the raw
    // schema-title normalization above only removes punctuation. Resolve the
    // declaration case-insensitively so this guard checks requiredness rather
    // than generator-specific capitalization.
    const declaration = declarations.get(typeName) ?? declarationsByCaseFoldedName.get(typeName.toLowerCase());
    if (!declaration) return 'absent';
    let state;
    if (ts.isInterfaceDeclaration(declaration)) {
      state = memberState(declaration.members, field);
      if (state === 'absent') {
        const inherited = (declaration.heritageClauses ?? [])
          .flatMap(clause => clause.types)
          .map(type =>
            ts.isIdentifier(type.expression) ? declarationState(type.expression.text, field, seen) : 'absent'
          );
        state = inherited.includes('required') ? 'required' : inherited.includes('optional') ? 'optional' : 'absent';
      }
    } else {
      state = typeNodeState(declaration.type, field, seen);
    }
    seen.delete(key);
    return state;
  };

  const drift = [];
  for (const [typeName, fields] of requiredByType) {
    for (const field of fields) {
      requiredCellCount++;
      const state = declarationState(typeName, field);
      if (state !== 'required') drift.push(`${typeName}.${field} (${state})`);
    }
  }

  assert.ok(requiredCellCount >= 380, `expected at least 380 required-field cells, found ${requiredCellCount}`);
  assert.deepEqual(drift, [], `schema-required fields drifted in generated TypeScript:\n${drift.join('\n')}`);
});
