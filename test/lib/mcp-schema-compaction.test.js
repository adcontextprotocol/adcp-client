const { test } = require('node:test');
const assert = require('node:assert/strict');
const AjvCore = require('ajv/dist/core').default;
const fc = require('fast-check');
const { AjvJsonSchemaValidator: LegacyProvider } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { AjvJsonSchemaValidator: ModernProvider } = require('@modelcontextprotocol/client/validators/ajv');
const { compactMcpSchemaForValidation } = require('../../dist/lib/validation/compact-schema');
const {
  sharedLegacyJsonSchemaValidator,
  sharedModernJsonSchemaValidator,
} = require('../../dist/lib/protocols/mcp-schema-validator');
const { getToolSchemaDocument } = require('../../dist/lib/validation/schema-loader');

const padding = 'schema annotation '.repeat(4000);
const payload = {
  description: padding,
  type: 'object',
  properties: { value: { type: 'integer', minimum: 1 } },
  required: ['value'],
  additionalProperties: false,
};

function compare(schema, values, { modern = false } = {}) {
  const before = structuredClone(schema);
  const original = new (modern ? ModernProvider : LegacyProvider)().getValidator(schema);
  const cache = modern ? sharedModernJsonSchemaValidator : sharedLegacyJsonSchemaValidator;
  const bounded = cache.getValidator(schema);
  for (const value of values) {
    assert.equal(bounded(value).valid, original(value).valid, JSON.stringify(value));
  }
  assert.deepEqual(schema, before, 'seller-provided schema remains unchanged');
  return { original, bounded };
}

test('large remote schemas retain local refs, ref siblings, and literal annotation data', () => {
  const literal = { $id: 'literal', $ref: 'literal', value: 2 };
  const schema = {
    type: 'object',
    properties: {
      a: structuredClone(payload),
      b: structuredClone(payload),
      tag: { $ref: '#/$defs/tag', minLength: 2 },
      literal: { const: literal },
    },
    required: ['a', 'b', 'tag', 'literal'],
    additionalProperties: false,
    $defs: { tag: { type: 'string' } },
    examples: [literal],
    default: literal,
  };
  const good = { a: { value: 1 }, b: { value: 2 }, tag: 'ok', literal };
  const { original, bounded } = compare(schema, [
    good,
    { ...good, tag: 'x' },
    { ...good, a: {} },
    { ...good, extra: 1 },
  ]);
  fc.assert(
    fc.property(fc.jsonValue(), value => bounded(value).valid === original(value).valid),
    { numRuns: 500, seed: 3530 }
  );
  const compacted = compactMcpSchemaForValidation(schema);
  assert.deepEqual(compacted.default, literal);
  assert.deepEqual(compacted.examples, [literal]);
  assert.ok(Object.keys(compacted.$defs).length > 1);
});

for (const rootId of [undefined, 'https://seller.example/output.json', 'relative-output.json']) {
  test(`remote factoring preserves nested resource scopes and pointer targets (${rootId ?? 'anonymous'})`, () => {
    const schema = {
      ...(rootId && { $id: rootId }),
      type: 'object',
      properties: {
        other: payload,
        resource: {
          $id: 'resources/payload.json',
          description: padding,
          type: 'object',
          $defs: { value: { type: 'string', minLength: 2 } },
          properties: {
            a: { $ref: '#/$defs/value' },
            b: { $ref: 'value.json' },
            declaration: { $id: 'value.json', type: 'integer', minimum: 1 },
          },
          required: ['a', 'b'],
        },
        copy: { $ref: '#/properties/resource/properties/a' },
      },
      required: ['resource', 'copy'],
    };
    const good = { resource: { a: 'ok', b: 2 }, copy: 'ok' };
    compare(schema, [
      good,
      { ...good, copy: '' },
      { ...good, resource: { a: '', b: 2 } },
      { ...good, resource: { a: 'ok', b: 'no' } },
    ]);
    const compacted = compactMcpSchemaForValidation(schema);
    assert.ok(compacted['x-adcp-compact-definitions']);
    assert.equal(
      typeof compacted.properties.resource.properties.a.$ref,
      'string',
      'pointer-addressed path stays present'
    );
  });
}

test('absolute nested resources can move while anchors retain their resource', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    $defs: {
      local: { $anchor: 'tag', type: 'string', minLength: 2 },
    },
    properties: {
      local: { $ref: '#tag' },
      resource: {
        $id: 'https://seller.example/resource.json',
        description: padding,
        type: 'object',
        $defs: { tagged: { $anchor: 'number', type: 'integer' } },
        properties: { n: { $ref: '#number' } },
        required: ['n'],
      },
    },
    required: ['local', 'resource'],
  };
  compare(
    schema,
    [
      { local: 'ok', resource: { n: 2 } },
      { local: 'x', resource: { n: 2 } },
      { local: 'ok', resource: { n: 'no' } },
    ],
    { modern: true }
  );
  const compacted = compactMcpSchemaForValidation(schema);
  assert.ok(compacted['x-adcp-compact-definitions']);
  assert.ok(Object.values(compacted.$defs).some(node => node.$id === 'https://seller.example/resource.json'));
});

test('URI normalization preserves percent-encoded dot segments as distinct resources', () => {
  const schema = {
    $id: 'https://seller.example/base/root.json',
    description: padding,
    type: 'object',
    $defs: {
      encoded: { $id: 'a/%2e%2e/value.json', type: 'integer' },
      plain: { $id: 'value.json', type: 'string' },
    },
    properties: {
      encoded: { $ref: 'a/%2e%2e/value.json' },
      plain: { $ref: 'value.json' },
      payload,
    },
    required: ['encoded', 'plain'],
  };
  compare(schema, [
    { encoded: 1, plain: 'ok' },
    { encoded: 'no', plain: 'ok' },
    { encoded: 1, plain: 2 },
  ]);
});

for (const dialect of [
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
]) {
  test(`${dialect} retains evaluated properties across factored refs`, () => {
    const schema = {
      $schema: dialect,
      type: 'object',
      allOf: [{ description: padding, properties: { value: { type: 'string' } }, required: ['value'] }],
      unevaluatedProperties: false,
    };
    compare(schema, [{ value: 'ok' }, { value: 2 }, { value: 'ok', extra: 1 }, {}], { modern: true });
  });
}

test('dynamic scopes, fragment IDs, and unresolvable URI bases use the original schema', () => {
  for (const schema of [
    { $dynamicAnchor: 'node', description: padding, type: 'string' },
    { $recursiveAnchor: true, description: padding, type: 'object' },
    { $id: 'https://seller.example/output#anchor', description: padding, type: 'string' },
    { $id: 'urn:output', properties: { x: { $id: 'relative' } }, description: padding },
    { 'x-adcp-compact-definitions': ['authored'], description: padding, type: 'number' },
    { $defs: 42, description: padding },
  ]) {
    assert.equal(compactMcpSchemaForValidation(schema), schema);
  }
});

test('literal __proto__ keys neither alter schema prototypes nor lose constraints', () => {
  const schema = JSON.parse(
    `{"type":"object","description":${JSON.stringify(padding)},"properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false,"__proto__":{"polluted":true}}`
  );
  const compacted = compactMcpSchemaForValidation(schema);
  assert.equal(Object.getPrototypeOf(compacted), Object.prototype);
  assert.equal(Object.hasOwn(compacted, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  compare(schema, [JSON.parse('{"__proto__":"ok"}'), JSON.parse('{"__proto__":42}'), {}]);
});

test('large broken refs and unsupported modern dialects still fail closed', () => {
  for (const cache of [sharedLegacyJsonSchemaValidator, sharedModernJsonSchemaValidator]) {
    assert.throws(() => cache.getValidator({ description: padding, $ref: '#/$defs/missing' }));
    for (const ref of ['#/$defs/__adcp_shared_0', '#/$defs', '#/$id', '#/x-adcp-compact-definitions']) {
      const schema = { description: padding, type: 'object', properties: { payload }, $ref: ref };
      assert.equal(
        compactMcpSchemaForValidation(schema),
        schema,
        'factoring must not create previously missing targets'
      );
      assert.throws(() => cache.getValidator(schema));
    }
  }
  assert.throws(
    () =>
      sharedModernJsonSchemaValidator.getValidator({ $schema: 'https://seller.example/dialect', description: padding }),
    /unsupported dialect/
  );
});

test('references into annotation data retain the untransformed graph', () => {
  const schema = {
    description: padding,
    default: { $ref: '#/properties/payload' },
    properties: { payload },
    $ref: '#/default',
  };
  assert.equal(compactMcpSchemaForValidation(schema), schema);
  compare(schema, [{ value: 1 }, { value: 'no' }, {}]);
});

test('duplicate and empty IDs and scopes under extension keywords retain compiler behavior', () => {
  const duplicate = { $id: 'https://seller.example/repeated', ...payload };
  const schemas = [
    { properties: { a: structuredClone(duplicate), b: structuredClone(duplicate) } },
    { description: padding, properties: { a: { $id: '', type: 'string' } } },
    { properties: { a: { ...payload, 'x-meta': { $id: 'hidden.json', type: 'string' } } } },
    { description: padding, prefixItems: [{ $id: 'https://seller.example/item', type: 'string' }] },
    { properties: { a: { $async: true, ...payload } } },
  ];
  for (const schema of schemas) assert.equal(compactMcpSchemaForValidation(schema), schema);
  for (const cache of [sharedLegacyJsonSchemaValidator, sharedModernJsonSchemaValidator]) {
    assert.throws(() => cache.getValidator(schemas[0]), /resolves to more than one schema/);
  }
  compare(schemas[1], [{ a: 'ok' }, { a: 42 }]);
  assert.throws(() => new LegacyProvider().getValidator(schemas.at(-1)), /async schema in sync schema/);
  assert.throws(() => sharedLegacyJsonSchemaValidator.getValidator(schemas.at(-1)), /async schema in sync schema/);
  const invalid = { description: padding, $ref: 42 };
  assert.equal(compactMcpSchemaForValidation(invalid), invalid);
});

test('synthetic rebasing cannot resolve missing references from anonymous or relative roots', () => {
  for (const schema of [
    { properties: { declaration: { $id: 'abs.json', ...payload } }, $ref: '/abs.json' },
    { $id: './a.json', description: padding, $ref: './a.json' },
    { $id: 'dir/root.json', properties: { declaration: { $id: 'other.json', ...payload } }, $ref: '/dir/other.json' },
    { properties: { declaration: { $id: 'https://seller.example/x', ...payload } }, $ref: '//seller.example/x' },
  ]) {
    assert.equal(compactMcpSchemaForValidation(schema), schema);
    for (const cache of [sharedLegacyJsonSchemaValidator, sharedModernJsonSchemaValidator]) {
      assert.throws(() => cache.getValidator(schema), /resolve reference/);
    }
  }
});

test('valid RFC URIs outside WHATWG URL constraints still compile', () => {
  const schema = { $id: 'https://seller.example:99999/output', type: 'object', properties: { a: payload } };
  compare(schema, [{ a: { value: 1 } }, { a: { value: 'no' } }]);
});

test('scopes nested in extension arrays retain the original graph', () => {
  const schema = { properties: { a: { ...payload, 'x-meta': { allOf: [{ $id: 'hidden.json' }] } } } };
  assert.equal(compactMcpSchemaForValidation(schema), schema);
});

test('modern dialect aliases match the official provider', () => {
  for (const $schema of [
    'http://json-schema.org/draft-07/schema#',
    'http://json-schema.org/draft-06/schema#',
    'http://json-schema.org/draft/2019-09/schema',
    'http://json-schema.org/draft/2020-12/schema',
  ]) {
    const schema = {
      $schema,
      type: 'object',
      properties: { payload, value: { type: 'array', prefixItems: [{ type: 'string' }] } },
    };
    compare(schema, [{ payload: { value: 1 }, value: ['ok'] }, { value: [42] }, { payload: { value: 0 } }], {
      modern: true,
    });
  }
});

test('percent-encoded pointer segments preserve addressed property paths', () => {
  const schema = {
    type: 'object',
    properties: { 'a/b': payload, copy: { $ref: '#/properties/a%2Fb/properties/value' }, other: payload },
  };
  compare(schema, [{ 'a/b': { value: 1 }, copy: 2 }, { copy: 'no' }, { 'a/b': { value: 0 } }]);
  const compacted = compactMcpSchemaForValidation(schema);
  assert.ok(compacted['x-adcp-compact-definitions']);
  assert.equal(compacted.properties['a/b'].properties.value.minimum, 1);
});

test('real AdCP output schemas compile as bounded functions in both MCP eras', t => {
  const { maxCompiledFunctionBytes } = require('../../scripts/performance/compiled-functions.cjs');
  const compile = AjvCore.prototype.compile;
  let largest = 0;
  t.mock.method(AjvCore.prototype, 'compile', function (schema) {
    const validate = compile.call(this, schema);
    largest = Math.max(largest, maxCompiledFunctionBytes(validate));
    return validate;
  });
  for (const cache of [sharedLegacyJsonSchemaValidator, sharedModernJsonSchemaValidator]) {
    for (const tool of ['get_products', 'list_creative_formats']) {
      for (const anonymous of [true, false]) {
        const schema = structuredClone(getToolSchemaDocument(tool, 'sync', '3.2.7').schema);
        if (anonymous) delete schema.$id;
        const validate = cache.getValidator(schema);
        const response = {
          status: 'completed',
          ...(tool === 'get_products' ? { products: [], cache_scope: 'public' } : { formats: [] }),
        };
        assert.equal(validate(response).valid, true);
        assert.equal(validate({}).valid, false);
      }
    }
  }
  for (const dialect of [
    undefined,
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ]) {
    const schema = {
      ...(dialect && { $schema: dialect }),
      description: padding,
      type: 'object',
      allOf: [{ properties: { payload }, required: ['payload'] }],
      unevaluatedProperties: false,
    };
    const validate = sharedModernJsonSchemaValidator.getValidator(schema);
    assert.equal(validate({ payload: { value: 1 } }).valid, true);
    assert.equal(validate({ payload: { value: 'no' } }).valid, false);
    assert.equal(validate({ payload: { value: 1 }, extra: true }).valid, false);
  }
  assert.ok(largest > 0 && largest < 512 * 1024, `largest generated function: ${largest} bytes`);
});

test('ESM clients and compactor load large schemas in a built package', async () => {
  const { sharedModernJsonSchemaValidator: cache } = await import('../../dist/lib/protocols/mcp-schema-validator.mjs');
  const { compactMcpSchemaForValidation: compact } = await import('../../dist/lib/validation/compact-schema.mjs');
  const schema = { type: 'object', properties: { payload } };
  assert.ok(compact(schema)['x-adcp-compact-definitions']);
  const validate = cache.getValidator(schema);
  assert.equal(validate({ payload: { value: 1 } }).valid, true);
  assert.equal(validate({ payload: { value: 'no' } }).valid, false);
});
