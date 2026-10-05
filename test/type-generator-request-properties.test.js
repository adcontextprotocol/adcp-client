const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'schemas/cache/latest');
const generatedFiles = ['core.generated.ts', 'tools.generated.ts'].map(file => path.join(root, 'src/lib/types', file));

test('bundled request fields and nested targeting property names appear in generated declarations', () => {
  const generatedProperties = new Set();
  for (const file of generatedFiles) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        generatedProperties.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const documents = new Map();
  const loadDocument = url => {
    const relative = url.pathname.replace(/^\/schemas\/[^/]+\//, '');
    if (!documents.has(relative))
      documents.set(relative, JSON.parse(fs.readFileSync(path.join(cache, relative), 'utf8')));
    return documents.get(relative);
  };
  const visited = new Set();
  const schemaProperties = new Map();
  const walk = (node, document, location) => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (node.$id) document = node;
    if (node.$ref) {
      const url = new URL(node.$ref, document.$id);
      const referenced = url.href.split('#')[0] === document.$id ? document : loadDocument(url);
      let target = referenced;
      if (url.hash) {
        assert.ok(url.hash.startsWith('#/'), `unsupported schema fragment: ${url}`);
        for (const token of decodeURIComponent(url.hash.slice(2)).split('/')) {
          target = target?.[token.replace(/~1/g, '/').replace(/~0/g, '~')];
        }
      }
      assert.notEqual(target, undefined, `unresolved bundled schema: ${url}`);
      walk(target, referenced, location);
    }
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      if (property === false) continue; // Forbidden fields are not request properties.
      const propertyPath = `${location}.${name}`;
      if (!schemaProperties.has(name)) schemaProperties.set(name, propertyPath);
      walk(property, document, propertyPath);
    }
    for (const item of Array.isArray(node.items) ? node.items : [node.items]) walk(item, document, `${location}[]`);
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const branch of node[keyword] ?? []) walk(branch, document, location);
    }
    // Validation predicates are runtime-only. Walk the structural request
    // surface; conditional compliance payloads can embed entire responses.
    walk(node.additionalProperties, document, location);
    for (const value of Object.values(node.patternProperties ?? {})) walk(value, document, `${location}.*`);
  };
  // MCP profiles wrap the canonical requests in transport-specific schemas.
  const requests = fs
    .readdirSync(cache, { recursive: true })
    .filter(file => file.endsWith('-request.json') && !file.startsWith('mcp/'));
  for (const file of requests) {
    const schema = loadDocument(new URL(file, 'https://adcontextprotocol.org/schemas/latest/'));
    for (const name of Object.keys(schema.properties ?? {})) {
      if (!schemaProperties.has(name)) schemaProperties.set(name, `${schema.title ?? file}.${name}`);
    }
  }
  // Fully traverse the request-only targeting schema, including references,
  // inline objects, and allOf branches. This is where #3115 lost properties.
  for (const file of ['core/targeting-input.json', 'core/demographic-targeting-intent.json']) {
    const schema = loadDocument(new URL(file, 'https://adcontextprotocol.org/schemas/latest/'));
    walk(schema, schema, schema.title);
  }
  assert.ok(requests.length >= 40, `expected at least 40 request schemas, found ${requests.length}`);
  assert.ok(schemaProperties.size >= 100, `expected at least 100 property names, found ${schemaProperties.size}`);
  const missing = [...schemaProperties]
    .filter(([name]) => !generatedProperties.has(name))
    .map(([, location]) => location);
  assert.deepEqual(missing, [], `request properties missing from generated declarations:\n${missing.join('\n')}`);
});

test('age provenance constraints compile with canonical enums and non-empty arrays on both public type surfaces', () => {
  const intent = JSON.parse(fs.readFileSync(path.join(cache, 'core/demographic-targeting-intent.json'), 'utf8'));
  const range = JSON.parse(fs.readFileSync(path.join(cache, 'core/demographic-age-range.json'), 'utf8'));
  const intentKeys = Object.keys(intent.properties)
    .map(name => JSON.stringify(name))
    .join(' | ');
  const ageKeys = [
    ...Object.keys(range.properties),
    ...intent.properties.age.allOf.flatMap(member => Object.keys(member.properties ?? {})),
  ]
    .map(name => JSON.stringify(name))
    .join(' | ');
  const context = path.join(root, '.context');
  fs.mkdirSync(context, { recursive: true });
  const directory = fs.mkdtempSync(path.join(context, 'age-types-'));
  const file = path.join(directory, 'consumer.ts');
  const cases = ['core', 'tools']
    .map(
      surface => `
    type ${surface}Age = ${surface}.DemographicTargetingIntent['age'];
    type ${surface}IntentFields = Assert<Exclude<${intentKeys}, keyof ${surface}.DemographicTargetingIntent> extends never ? true : false>;
    type ${surface}AgeFields = Assert<Exclude<${ageKeys}, keyof ${surface}Age> extends never ? true : false>;
    type ${surface}Bases = Assert<Equal<NonNullable<${surface}Age['accepted_bases']>, [core.AgeDeterminationBasis, ...core.AgeDeterminationBasis[]]>>;
    type ${surface}Methods = Assert<Equal<NonNullable<${surface}Age['accepted_verification_methods']>, [core.AgeVerificationMethod, ...core.AgeVerificationMethod[]]>>;
    const ${surface}Legacy: ${surface}Age = { min: 18, include_unknown: false };
    const ${surface}Constrained: ${surface}Age = { min: 18, max: 65, include_unknown: false, accepted_bases: ['verified', 'declared'], accepted_verification_methods: ['digital_id'] };
    // @ts-expect-error Constraints must be non-empty when supplied.
    const ${surface}EmptyBases: ${surface}Age = { min: 18, include_unknown: false, accepted_bases: [] };
    // @ts-expect-error Constraints must be non-empty when supplied.
    const ${surface}EmptyMethods: ${surface}Age = { min: 18, include_unknown: false, accepted_verification_methods: [] };
    // @ts-expect-error Population estimates cannot determine an individual user's age.
    const ${surface}InvalidBasis: ${surface}Age = { min: 18, include_unknown: false, accepted_bases: ['population_estimate'] };
    // @ts-expect-error Inference is not an age-verification method.
    const ${surface}InvalidMethod: ${surface}Age = { min: 18, include_unknown: false, accepted_verification_methods: ['inferred'] };
  `
    )
    .join('\n');
  fs.writeFileSync(
    file,
    `
    import type * as core from '../../src/lib/types/core.generated';
    import type * as tools from '../../src/lib/types/tools.generated';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    ${cases}
  `
  );
  try {
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: [] });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime age validation retains provenance constraints and conditional verification requirements', () => {
  const { getSchemaValidatorByRef } = require('../dist/lib/validation/schema-loader.js');
  const { DemographicTargetingIntentSchema } = require('../dist/lib/types/schemas.generated.js');
  const validate = getSchemaValidatorByRef('core/demographic-targeting-intent.json');
  assert.ok(validate);
  const range = { min: 18, include_unknown: false };
  const constrained = {
    age: { ...range, accepted_bases: ['verified'], accepted_verification_methods: ['digital_id'] },
  };
  assert.equal(validate({ age: range }), true);
  assert.equal(validate(constrained), true);
  assert.deepEqual(DemographicTargetingIntentSchema.parse(constrained), constrained);
  for (const constraint of [
    { accepted_bases: [] },
    { accepted_bases: ['population_estimate'] },
    { accepted_bases: ['verified'], accepted_verification_methods: [] },
    { accepted_bases: ['verified'], accepted_verification_methods: ['inferred'] },
    { accepted_verification_methods: ['digital_id'] },
    { accepted_bases: ['inferred'], accepted_verification_methods: ['digital_id'] },
  ]) {
    assert.equal(validate({ age: { ...range, ...constraint } }), false, JSON.stringify(constraint));
  }
});

test('direct and referenced age schema compilation preserve constraints without changing the bundled schema', () => {
  const context = path.join(root, '.context');
  fs.mkdirSync(context, { recursive: true });
  const directory = fs.mkdtempSync(path.join(context, 'age-codegen-'));
  const file = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    file,
    `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { compile } from 'json-schema-to-typescript';
    import { codegenRefResolvers, createVerifiedCacheRefResolver, enforceStrictSchema } from '../../scripts/generate-types';
    async function main() {
      const resolver = createVerifiedCacheRefResolver(${JSON.stringify(cache)});
      const schema = JSON.parse(readFileSync(${JSON.stringify(path.join(cache, 'core/demographic-targeting-intent.json'))}, 'utf8'));
      const original = structuredClone(schema);
      const strict = enforceStrictSchema(schema);
      assert.deepEqual(schema, original);
      assert.deepEqual(enforceStrictSchema(strict), strict);
      const options = { bannerComment: '', additionalProperties: false, $refOptions: { resolve: codegenRefResolvers(resolver) } };
      for (const root of [strict, { title: 'Referenced Intent', type: 'object', properties: { demographic: { $ref: schema.$id } } }]) {
        const source = await compile(root, 'Intent', options);
        assert.match(source, /accepted_bases\\?: \\[AgeDeterminationBasis, \\.\\.\\.AgeDeterminationBasis\\[\\]\\]/);
        assert.match(source, /accepted_verification_methods\\?: \\[AgeVerificationMethod, \\.\\.\\.AgeVerificationMethod\\[\\]\\]/);
      }
      assert.deepEqual(await resolver.read({ url: schema.$id }), original);
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `
  );
  try {
    const result = spawnSync(path.join(root, 'node_modules/.bin/tsx'), [file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 50_000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
