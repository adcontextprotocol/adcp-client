const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ts = require('typescript');
const { getSchemaDocumentByRef } = require('../dist/lib/validation/schema-loader.js');

test('cardinality fallback runs while targeting declarations are still local', () => {
  const source = ts.createSourceFile(
    'generate-types.ts',
    fs.readFileSync(path.join(root, 'scripts/generate-types.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const pipeline = source.statements.find(statement => statement.name?.text === 'generateTypes');
  const calls = [];
  let coreInitializer;
  const visit = node => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'processedCoreTypes') {
      coreInitializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(pipeline);
  assert.ok(calls.indexOf('alignTargetingInputArrayCardinality') >= 0);
  assert.ok(calls.indexOf('alignTargetingInputArrayCardinality') < calls.indexOf('addCoreGeneratedTypeImports'));
  assert.ok(ts.isCallExpression(coreInitializer));
  assert.equal(coreInitializer.expression.getText(source), 'alignTargetingInputArrayCardinality');
});

test('nullable targeting aliases survive independent root compilation in either order', () => {
  const context = path.join(root, '.context');
  fs.mkdirSync(context, { recursive: true });
  const directory = fs.mkdtempSync(path.join(context, 'targeting-input-harness-'));
  const script = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    script,
    `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';
import ts from 'typescript';
import { nameTargetingInputForCodegen, codegenRefResolvers, enforceStrictSchema, filterDuplicateTypeDefinitions } from '../../scripts/generate-types';

async function main() {
  // These four array titles are shared by targeting.json and the nullable
  // targeting-input.json at the current pin. Element details do not cause the collision.
  const titles = {
    geo_metros: 'Targeting Geo Metros', language: 'Targeting Languages',
    keyword_targets: 'Targeting Keywords', negative_keywords: 'Targeting Negative Keywords',
  };
  const state = { title: 'Targeting Overlay', type: 'object', properties: Object.fromEntries(
    Object.entries(titles).map(([key, title]) => [key, { title, type: 'array', items: { type: 'string' }, minItems: 1 }])
  ) };
  const input = { title: 'Targeting Overlay Input', type: 'object', properties: Object.fromEntries(
    Object.entries(state.properties).map(([key, value]) => [key, { ...value, type: ['array', 'null'] }])
  ) };
  const stateId = 'https://adcontextprotocol.org/schemas/${fs.readFileSync(path.join(root, 'ADCP_VERSION'), 'utf8').trim()}/core/targeting.json';
  for (const [key, title, values] of [
    ['device_type', 'Device Type', ['mobile', 'desktop']],
    ['device_platform', 'Device Platform', ['ios', 'android']],
  ] as const) {
    state.properties[key] = { type: 'array', items: { title, type: 'string', enum: values }, minItems: 1 };
    input.properties[key] = { anyOf: [{ $ref: stateId + '#/properties/' + key }, { type: 'null' }] };
  }
  const dimensions = [...Object.keys(titles), 'device_type', 'device_platform'];
  input.properties.signal_targeting = { type: ['array', 'null'], items: { type: 'string' }, minItems: 1 };
  const original = structuredClone(input);
  const normalized = enforceStrictSchema(input);
  assert.deepEqual(input, original, 'normalization must not mutate the wire schema');
  assert.deepEqual(normalized.properties.signal_targeting, original.properties.signal_targeting, 'untitled arrays need no alias');
  assert.deepEqual(enforceStrictSchema(normalized), normalized, 'normalization must be idempotent');
  for (const key of Object.keys(titles)) {
    assert.deepEqual({ ...normalized.properties[key], title: input.properties[key].title }, input.properties[key]);
    assert.equal(enforceStrictSchema(state).properties[key].title, state.properties[key].title);
  }
  const inlineInput = structuredClone(input);
  for (const key of ['device_type', 'device_platform']) inlineInput.properties[key].anyOf[0] = structuredClone(state.properties[key]);
  for (const schemas of [[state, input], [input, state], [state, inlineInput], [inlineInput, state]]) {
    const seen = new Set<string>();
    let source = '';
    for (const schema of schemas) {
      source += filterDuplicateTypeDefinitions(await compile(enforceStrictSchema(structuredClone(schema)), schema.title, { bannerComment: '', $refOptions: { resolve: { fixture: { order: 1, canRead: (file: { url: string }) => file.url.startsWith(stateId), read: () => structuredClone(state) } } } }), seen);
    }
    for (const key of dimensions) {
      source += '\\nconst clear_' + key + ': TargetingOverlayInput = { ' + key + ': null };';
      source += '\\nconst value_' + key + ': TargetingOverlay = { ' + key + ': [' + JSON.stringify(key === 'device_type' ? 'mobile' : key === 'device_platform' ? 'ios' : 'value') + '] };';
      source += '\\nconst input_value_' + key + ': TargetingOverlayInput = value_' + key + ';';
      if (key === 'device_type' || key === 'device_platform') source += '\\n// @ts-expect-error Device enums are array elements, not scalar dimensions.\\nconst scalar_' + key + ': TargetingOverlayInput = { ' + key + ': ' + JSON.stringify(key === 'device_type' ? 'mobile' : 'ios') + ' };';
      source += '\\n// @ts-expect-error Clear commands are not effective state.\\nconst invalid_' + key + ': TargetingOverlay = { ' + key + ': null };';
    }
    const file = ${JSON.stringify(path.join(directory, 'generated.ts'))};
    writeFileSync(file, source);
    const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: [] });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\\n')), []);
  }
  const inputId = stateId.replace('targeting.json', 'targeting-input.json');
  let inputReads = 0;
  let httpReads = 0;
  const resolver = { canRead: true, read: () => structuredClone(state) };
  const resolvers = codegenRefResolvers(resolver, url => {
    assert.equal(url, inputId);
    inputReads++;
    return structuredClone(input);
  });
  const compiled = await compile({ title: 'Referenced Input', type: 'object', properties: { targeting: { $ref: inputId } } }, 'ReferencedInput', {
    bannerComment: '', $refOptions: { resolve: { ...resolvers,
      http: { order: 200, canRead: () => true, read: file => {
        if (file.url === inputId) { httpReads++; throw new Error('input normalization was bypassed'); }
        return structuredClone(state);
      } },
    } },
  });
  assert.equal(inputReads, 1);
  assert.equal(httpReads, 0);
  assert.match(compiled, /TargetingGeoMetrosInput/);
  assert.match(compiled, /TargetingDeviceTypesInput/);
  assert.equal(nameTargetingInputForCodegen(input).properties.geo_metros.minItems, 1);
  assert.throws(() => codegenRefResolvers(resolver, () => null).targetingInput.read({ url: inputId }), /verified cache/);
  assert.equal(resolvers.targetingInput.canRead({ url: stateId }), false, 'unrelated resolver behavior is unchanged');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`
  );
  try {
    const result = spawnSync(path.join(root, 'node_modules/.bin/tsx'), [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 50_000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Unlike synthetic compiler fixtures, this checks every known dimension in
// both real generated files against the selected bundle.
test('core and tool targeting aliases preserve the selected schema nullability', () => {
  const properties = getSchemaDocumentByRef('core/targeting.json').schema.properties;
  const dimensions = Object.keys(properties);
  const hasInput = getSchemaDocumentByRef('core/targeting-input.json') !== undefined;
  const files = ['core.generated.ts', 'tools.generated.ts'].map(file => path.join(root, 'src/lib/types', file));
  const program = ts.createProgram(files, { strict: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  for (const file of files) {
    const source = program.getSourceFile(file);
    for (const [name, nullable] of [
      ['TargetingOverlay', false],
      ...(hasInput ? [['TargetingOverlayInput', true]] : []),
    ]) {
      const declaration = source.statements.find(statement => statement.name?.text === name);
      assert.ok(declaration, `${file}: ${name}`);
      const overlay = checker.getTypeAtLocation(declaration.name);
      for (const dimension of dimensions) {
        const property = checker.getPropertyOfType(overlay, dimension);
        assert.ok(property, `${name}.${dimension}`);
        const type = checker.getTypeOfSymbolAtLocation(property, declaration);
        const acceptsNull = type.isUnion() && type.types.some(member => (member.flags & ts.TypeFlags.Null) !== 0);
        assert.equal(acceptsNull, nullable, `${path.basename(file)}: ${name}.${dimension}`);
        if (properties[dimension].type === 'array') {
          const values = (type.isUnion() ? type.types : [type]).filter(
            member => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
          );
          assert.ok(
            values.every(member => checker.isTupleType(member) || checker.isArrayType(member)),
            `${name}.${dimension} must be an array`
          );
        }
      }
    }
  }
});
