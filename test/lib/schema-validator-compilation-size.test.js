const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const {
  getValidator,
  getCanonicalToolValidatorForVersion,
  getSchemaValidatorByRef,
  getToolSchemaDocument,
  withExternalSchemaRoot,
} = require('../../dist/lib/validation/schema-loader');
const { compactSchemaForValidation } = require('../../dist/lib/validation/compact-schema');
const { loadResponseSchema } = require('../../dist/lib/conformance/schemaLoader');

function maxFunctionBytes(validate) {
  const seen = new Set();
  let largest = 0;
  function visit(env) {
    if (!env || typeof env !== 'object' || seen.has(env)) return;
    seen.add(env);
    if (typeof env.validate === 'function') largest = Math.max(largest, env.validate.toString().length);
    for (const ref of Object.values(env.refs ?? {})) visit(ref);
    visit(env.root);
  }
  visit(validate.schemaEnv);
  assert.ok(largest > 0, 'the actual AJV function graph was inspected');
  return largest;
}
const MAX_FUNCTION_BYTES = 1024 * 1024;
for (const version of [...new Set(['3.0.25', '3.1.31', '3.2.7', require('../../dist/lib/version').ADCP_VERSION])]) {
  test(`${version}: primary tool validators compile as bounded referenced functions`, () => {
    for (const [tool, direction] of [
      ['get_products', 'request'],
      ['get_products', 'sync'],
      ['create_media_buy', 'request'],
      ['create_media_buy', 'sync'],
      ['get_media_buy_delivery', 'sync'],
      ['get_adcp_capabilities', 'sync'],
    ]) {
      const validate = getValidator(tool, direction, version);
      assert.ok(validate, `${tool}/${direction}`);
      const largest = maxFunctionBytes(validate);
      assert.ok(largest < MAX_FUNCTION_BYTES, `${version} ${tool}/${direction} has ${largest} byte generated function`);
    }
    const products = getValidator('get_products', 'sync', version);
    const empty = { status: 'completed', cache_scope: 'public', products: [] };
    assert.equal(products(empty), true, JSON.stringify(products.errors));
    // Exercise a hot validator only after enforcing the size cap, preventing a
    // regression from recreating the Node24 Maglev native-memory spike in CI.
    for (let i = 0; i < 2000; i++) assert.equal(products(empty), true);
    assert.equal(products({ status: 'completed', products: [{}] }), false);
    assert.ok(products.errors.some(error => error.instancePath.startsWith('/products/0')));
  });
  test(`${version}: conformance's self-contained schemas also compile into bounded functions`, () => {
    const schema = loadResponseSchema('get_products', { version });
    const before = structuredClone(schema);
    const prepared = compactSchemaForValidation(schema);
    const ajv = new Ajv({ strict: false, allErrors: true, inlineRefs: false, validateFormats: false });
    const validate = ajv.compile(prepared);
    assert.ok(maxFunctionBytes(validate) < MAX_FUNCTION_BYTES);
    assert.equal(
      validate({ status: 'completed', cache_scope: 'public', products: [] }),
      true,
      JSON.stringify(validate.errors)
    );
    assert.equal(validate({ status: 'completed', products: [{}] }), false);
    assert.ok(validate.errors.some(error => error.instancePath.startsWith('/products/0')));
    assert.deepEqual(schema, before, 'factoring must not mutate public schema documents');
  });
}

test('modular validation resolves absolute, relative and local refs while preserving response relaxation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-modular-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = 'https://adcontextprotocol.org/schemas/3.2.7/';
  const write = (file, schema) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(schema));
  };
  const response = {
    $id: base + 'media-buy/get-products-response.json',
    type: 'object',
    additionalProperties: false,
    required: ['payload'],
    properties: { payload: { $ref: '../core/payload.json' } },
  };
  const payload = {
    $id: base + 'core/payload.json',
    type: 'object',
    additionalProperties: false,
    definitions: { tag: { type: 'string', minLength: 1 } },
    properties: { tag: { $ref: '#/definitions/tag' } },
    required: ['tag'],
  };
  write('media-buy/get-products-response.json', response);
  write('core/payload.json', payload);
  write('core/duplicate-identical.json', payload);
  write('bundled/media-buy/get-products-response.json', { ...response, _bundled: true, properties: { payload } });
  write('media-buy/get-products-request.json', {
    $id: base + 'media-buy/get-products-request.json',
    type: 'object',
    properties: { payload: { $ref: base + 'core/payload.json' } },
    required: ['payload'],
  });
  withExternalSchemaRoot('3.2', root, () => {
    const runtime = getValidator('get_products', 'sync', '3.2');
    assert.equal(runtime({ payload: { tag: 'ok' }, replayed: true }), true);
    assert.equal(runtime({ payload: { tag: 'ok', secret: 'no' } }), false);
    assert.ok(
      runtime.errors.some(error => error.instancePath === '/payload' && error.keyword === 'additionalProperties')
    );
    const canonical = getCanonicalToolValidatorForVersion('get_products', 'sync', '3.2');
    assert.equal(canonical({ payload: { tag: 'ok' }, replayed: true }), false);
    const request = getValidator('get_products', 'request', '3.2');
    assert.equal(request({ payload: { tag: 'ok' } }), true);
    assert.equal(request({ payload: { tag: '' } }), false);
    assert.equal(getSchemaValidatorByRef('core/payload.json', '3.2')({ tag: 'ok' }), true);
    assert.equal(
      getToolSchemaDocument('get_products', 'sync', '3.2').schema._bundled,
      true,
      'public document selection is unchanged'
    );
  });
});

test('bundled-only custom roots retain strict nested validation and extensible response envelopes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-bundled-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bundled/media-buy/get-products-response.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      $id: 'https://adcontextprotocol.org/schemas/3.2.7/media-buy/get-products-response.json',
      type: 'object',
      additionalProperties: false,
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['products'],
    })
  );
  withExternalSchemaRoot('3.2', root, () => {
    const runtime = getValidator('get_products', 'sync', '3.2');
    assert.equal(runtime({ products: [{ id: 'real' }], replayed: true }), true);
    assert.equal(runtime({ products: [{ id: 'real', secret: 'no' }] }), false);
    const canonical = getCanonicalToolValidatorForVersion('get_products', 'sync', '3.2');
    assert.equal(canonical({ products: [{ id: 'real' }], replayed: true }), false);
    assert.equal(canonical({ products: [{ id: 'real' }] }), true);
  });
});

test('validation factoring preserves composition, local refs and literal annotation data', () => {
  const literal = { $id: 'literal-data', value: 1 };
  const shared = {
    type: 'object',
    properties: { value: { type: 'integer', minimum: 1 } },
    required: ['value'],
    additionalProperties: false,
  };
  const schema = {
    $id: 'https://schema.example/compiled.json',
    type: 'object',
    $defs: { tag: { type: 'string', minLength: 1 } },
    properties: {
      a: structuredClone(shared),
      b: structuredClone(shared),
      tag: { $ref: '#/$defs/tag' },
      literal: { const: literal },
      mode: { enum: ['on', 'off'] },
    },
    required: ['a', 'b', 'tag', 'literal', 'mode'],
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { mode: { const: 'on' } } },
        then: { properties: { a: { properties: { value: { minimum: 2 } } } } },
      },
    ],
    examples: [literal],
    default: literal,
  };
  const before = structuredClone(schema);
  const factored = compactSchemaForValidation(schema);
  const original = new Ajv({ strict: false, allErrors: true }).compile(schema);
  const bounded = new Ajv({ strict: false, allErrors: true, inlineRefs: false }).compile(factored);
  const valid = { a: { value: 2 }, b: { value: 1 }, tag: 'ok', literal, mode: 'on' };
  for (const value of [
    valid,
    { ...valid, mode: 'off', a: { value: 1 } },
    { ...valid, a: { value: 1 } },
    { ...valid, b: {} },
    { ...valid, tag: '' },
    { ...valid, literal: { value: 1 } },
    { ...valid, unexpected: true },
  ]) {
    assert.equal(bounded(value), original(value), JSON.stringify(value));
    const diagnostics = validate =>
      (validate.errors ?? []).map(error => `${error.instancePath}:${error.keyword}`).sort();
    assert.deepEqual(diagnostics(bounded), diagnostics(original));
  }
  assert.deepEqual(factored.examples, [literal]);
  assert.deepEqual(factored.default, literal);
  assert.deepEqual(schema, before);
});

for (const composition of ['oneOf', 'anyOf', 'allOf']) {
  test(`large bundled-only ${composition} response arms retain envelope relaxation before factoring`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-large-response-arm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'bundled/media-buy/get-products-response.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const arm = {
      type: 'object',
      additionalProperties: false,
      required: ['payload'],
      properties: {
        payload: {
          type: 'object',
          description: 'large schema annotation '.repeat(100),
          additionalProperties: false,
          required: ['tag'],
          properties: { tag: { type: 'string' } },
        },
      },
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        $id: 'https://adcontextprotocol.org/schemas/3.2.7/media-buy/get-products-response.json',
        [composition]: [arm],
      })
    );
    withExternalSchemaRoot('3.2', root, () => {
      const runtime = getValidator('get_products', 'sync', '3.2');
      const payload = { payload: { tag: 'ok' }, replayed: true, context: { correlation_id: 'replay' } };
      assert.equal(runtime(payload), true, JSON.stringify(runtime.errors));
      assert.equal(runtime({ ...payload, payload: { tag: 'ok', unexpected: true } }), false);
      const canonical = getCanonicalToolValidatorForVersion('get_products', 'sync', '3.2');
      assert.equal(canonical(payload), false, 'canonical response arms remain strict');
      assert.equal(canonical({ payload: { tag: 'ok' } }), true);
    });
  });
}

for (const ref of [
  '#/properties/payload/properties/tag',
  'https://schema.example/pointer.json#/properties/payload/properties/tag',
]) {
  test(`validation factoring preserves pointer-addressed one-off nodes: ${ref}`, () => {
    const schema = {
      $id: 'https://schema.example/pointer.json',
      type: 'object',
      required: ['payload', 'copy'],
      properties: {
        payload: {
          type: 'object',
          description: 'large unique payload annotation '.repeat(100),
          properties: { tag: { type: 'string', minLength: 2 } },
          required: ['tag'],
          additionalProperties: false,
        },
        copy: { $ref: ref },
      },
      additionalProperties: false,
    };
    const original = new Ajv({ strict: false, allErrors: true }).compile(schema);
    const factored = compactSchemaForValidation(schema);
    const bounded = new Ajv({ strict: false, allErrors: true, inlineRefs: false }).compile(factored);
    for (const value of [
      { payload: { tag: 'ok' }, copy: 'ok' },
      { payload: { tag: 'ok' }, copy: '' },
      { payload: { tag: '' }, copy: 'ok' },
    ]) {
      assert.equal(bounded(value), original(value), JSON.stringify(value));
      const paths = validate => (validate.errors ?? []).map(error => `${error.instancePath}:${error.keyword}`).sort();
      assert.deepEqual(paths(bounded), paths(original));
    }
    assert.equal(factored.properties.payload.properties.tag.minLength, 2, 'the referenced path remains present');
  });
}

test('paired bundled response aliases accept envelope fields on closed non-tool fragments without loosening shared request schemas', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-closed-reply-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = 'https://adcontextprotocol.org/schemas/3.2.7/';
  const write = (file, schema) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(schema));
  };
  const reply = {
    $id: base + 'core/reply.json',
    type: 'object',
    additionalProperties: false,
    required: ['payload'],
    properties: { payload: { type: 'string' } },
  };
  write('core/reply.json', reply);
  write('media-buy/get-products-response.json', {
    $id: base + 'media-buy/get-products-response.json',
    allOf: [{ $ref: '../core/reply.json' }],
  });
  write('media-buy/get-products-request.json', {
    $id: base + 'media-buy/get-products-request.json',
    allOf: [{ $ref: '../core/reply.json' }],
  });
  write('bundled/media-buy/get-products-response.json', {
    $id: base + 'media-buy/get-products-response.json',
    allOf: [reply],
  });
  withExternalSchemaRoot('3.2', root, () => {
    const request = getValidator('get_products', 'request', '3.2');
    const payload = { payload: 'ok', replayed: true };
    assert.equal(request({ payload: 'ok' }), true);
    assert.equal(request(payload), false);
    const runtime = getValidator('get_products', 'sync', '3.2');
    assert.equal(runtime(payload), true, JSON.stringify(runtime.errors));
    assert.equal(runtime({ ...payload, future_envelope: 'extension' }), false, 'undeclared root fields stay rejected');
    const canonical = getCanonicalToolValidatorForVersion('get_products', 'sync', '3.2');
    assert.equal(canonical(payload), false);
    assert.equal(canonical({ payload: 'ok' }), true);
    assert.equal(request(payload), false, 'shared request fragment must remain closed after response compilation');
    assert.equal(getSchemaValidatorByRef('core/reply.json', '3.2')(payload), false);
  });
});

test('ESM response validators execute the lazy factoring path in a built package', async () => {
  const loader = await import('../../dist/lib/validation/schema-loader.mjs');
  const validate = loader.getValidator('get_products', 'sync', '3.2.7');
  assert.equal(
    validate({ status: 'completed', cache_scope: 'public', products: [] }),
    true,
    JSON.stringify(validate.errors)
  );
});

for (const keyword of ['oneOf', 'anyOf']) {
  test(`validation factoring retains ${keyword} branch diagnostics while factoring their descendants`, () => {
    const branch = kind => ({
      type: 'object',
      required: ['kind', 'payload'],
      properties: {
        kind: { const: kind },
        payload: {
          type: 'object',
          description: 'large branch descendant '.repeat(100),
          properties: { value: { type: 'string' } },
        },
      },
    });
    const original = { type: 'array', items: { [keyword]: [branch('a'), branch('b')] } };
    const prepared = compactSchemaForValidation(original);
    const validate = new Ajv({ strict: false, allErrors: true, inlineRefs: false }).compile(prepared);
    assert.equal(validate([{ kind: 'invalid' }, { kind: 'a' }]), false);
    for (const index of [0, 1]) {
      assert.ok(
        validate.errors.some(
          error => error.instancePath === `/${index}` && /\/(?:oneOf|anyOf)\/0\/required$/.test(error.schemaPath)
        )
      );
    }
    assert.ok(
      validate.errors.every(error => !Object.hasOwn(error, 'data')),
      'diagnostics do not expose payload data'
    );
    assert.ok(maxFunctionBytes(validate) < MAX_FUNCTION_BYTES);
    const definitions = Object.values(prepared.$defs ?? {});
    assert.ok(
      definitions.some(node => Array.isArray(node[keyword]) && node[keyword].every(arm => arm.properties.kind.const))
    );
    assert.ok(definitions.some(node => node.description?.startsWith('large branch descendant')));
  });
}
