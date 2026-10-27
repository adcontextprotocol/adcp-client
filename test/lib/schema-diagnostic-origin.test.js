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
  withExternalSchemaRoot,
} = require('../../dist/lib/validation/schema-loader');
const { validateResponse, validateRequest } = require('../../dist/lib/validation/schema-validator');
const { createSchemaDiagnosticOrigins } = require('../../dist/lib/validation/schema-diagnostic-origins');

const base = 'https://adcontextprotocol.org/schemas/3.2.7/';
const large = 'large schema origin regression annotation '.repeat(80);
function fixture(t, schema, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-schema-origin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'index.json': { adcp_version: '3.2.7' },
    'bundled/media-buy/get-products-response.json': { $id: base + 'media-buy/get-products-response.json', ...schema },
    'bundled/media-buy/get-products-request.json': { $id: base + 'media-buy/get-products-request.json', ...schema },
    ...extraFiles,
  };
  for (const [file, document] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(document));
  }
  return root;
}
function arm(kind, required = [], properties = {}) {
  return { type: 'object', required: ['kind', ...required], properties: { kind: { const: kind }, ...properties } };
}
function union(...arms) {
  return { description: large, oneOf: arms };
}

test('nested large factored unions keep the deepest surviving discriminator and required failure', t => {
  const inner = union(arm('inner-a', ['a']), arm('inner-b', ['b']));
  const root = fixture(t, {
    type: 'object',
    properties: { payload: union(arm('outer-a', ['child'], { child: inner }), arm('outer-b', ['other'])) },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const payload = { payload: { kind: 'outer-a', child: { kind: 'inner-b' } } };
    const outcome = validateResponse('get_products', payload, '3.2');
    const leaf = outcome.issues.find(issue => issue.pointer === '/payload/child/b');
    assert.ok(leaf, JSON.stringify(outcome.issues));
    assert.deepEqual(leaf.discriminator, [{ field: 'kind', value: 'inner-b' }]);
    assert.ok(!outcome.issues.some(issue => issue.pointer === '/payload/other'));
    const validate = getValidator('get_products', 'sync', '3.2');
    assert.ok(Object.values(validate.schema.$defs).filter(node => node.oneOf).length >= 2);
    assert.ok(validate.errors.every(error => !Object.hasOwn(error, 'data')));
  });
});

for (const location of ['additionalProperties', 'patternProperties', 'then']) {
  test(`factored union diagnostics use their exact origin under ${location}`, t => {
    const value = union(arm('image', ['src']), arm('video', ['url']));
    const assets =
      location === 'then'
        ? { if: { type: 'object' }, then: { properties: { banner: value } } }
        : location === 'patternProperties'
          ? { patternProperties: { '^banner$': value } }
          : { additionalProperties: value };
    const root = fixture(t, {
      oneOf: [
        { type: 'object', required: ['assets'], properties: { assets } },
        {
          type: 'object',
          required: ['errors'],
          properties: { errors: { type: 'array' } },
          not: { required: ['assets'] },
        },
      ],
    });
    withExternalSchemaRoot('3.2', root, () => {
      const outcome = validateResponse('get_products', { assets: { banner: { kind: 'video' } } }, '3.2');
      const leaf = outcome.issues.find(issue => issue.pointer === '/assets/banner/url');
      assert.ok(leaf, JSON.stringify(outcome.issues));
      assert.deepEqual(leaf.discriminator, [{ field: 'kind', value: 'video' }]);
      assert.ok(!outcome.issues.some(issue => issue.pointer === '/errors'));
    });
  });
}

test('different composed guards at the same instance never attribute forbidden keys to the wrong not origin', t => {
  const root = fixture(t, {
    properties: {
      payload: {
        allOf: [
          { description: large + 'a', not: { anyOf: [{ required: ['a'] }] } },
          { description: large + 'b', not: { anyOf: [{ required: ['b'] }] } },
        ],
      },
    },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: { a: true, b: true } }, '3.2');
    assert.deepEqual(outcome.issues.map(issue => issue.pointer).sort(), ['/payload/a', '/payload/b']);
  });
});

test('same-instance factored unions retain their own distinct variant metadata', t => {
  const root = fixture(t, {
    properties: {
      payload: {
        allOf: [
          union({ required: ['a'] }, { required: ['b'] }),
          union({ required: ['c'] }, { required: ['d'] }, { required: ['e'] }),
        ],
      },
    },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: {} }, '3.2');
    assert.deepEqual(
      outcome.issues
        .filter(issue => issue.keyword === 'oneOf')
        .map(issue => issue.variants.map(variant => variant.required))
        .sort(),
      [
        [['a'], ['b']],
        [['c'], ['d'], ['e']],
      ]
    );
  });
});

test('recursive reuse of the same union preserves independent nested failures', t => {
  const root = fixture(t, {
    $defs: { node: { oneOf: [arm('leaf', ['value']), arm('branch', ['next'], { next: { $ref: '#/$defs/node' } })] } },
    properties: { payload: { $ref: '#/$defs/node' } },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest(
      'get_products',
      { payload: { kind: 'branch', next: { kind: 'branch', next: { kind: 'leaf' } } } },
      '3.2'
    );
    const leaf = outcome.issues.find(issue => issue.pointer === '/payload/next/next/value');
    assert.ok(leaf, JSON.stringify(outcome.issues));
    assert.deepEqual(leaf.discriminator, [{ field: 'kind', value: 'leaf' }]);
    assert.ok(!outcome.issues.some(issue => issue.pointer === '/payload/value'));
  });
});

test('invalid validation reuses compiled origins without loading a public document or changing root identity', t => {
  const root = fixture(
    t,
    { type: 'object', required: ['payload'], properties: { payload: { type: 'string' } } },
    {
      'media-buy/get-products-response.json': {
        $id: base + 'authored.json',
        type: 'object',
        required: ['payload'],
        properties: { payload: { type: 'string' } },
      },
    }
  );
  withExternalSchemaRoot('3.2', root, () => {
    validateResponse('get_products', {}, '3.2');
    const originalRead = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', (...args) => {
      if (String(args[0]).startsWith(root)) reads++;
      return originalRead(...args);
    });
    const outcome = validateResponse('get_products', {}, '3.2');
    assert.equal(reads, 0);
    assert.equal(outcome.schemaId, base + 'authored.json');
    assert.ok(outcome.issues.every(issue => issue.schemaId === outcome.schemaId));
  });
});

for (const first of ['canonical', 'reference', 'runtime']) {
  test(`strict and relaxed validator registries stay isolated when ${first} compiles first`, t => {
    const closed = {
      type: 'object',
      additionalProperties: false,
      required: ['payload'],
      properties: { payload: { type: 'string' } },
    };
    const root = fixture(
      t,
      { allOf: [closed] },
      {
        'core/reply.json': { $id: base + 'core/reply.json', ...closed },
        'media-buy/get-products-response.json': {
          $id: base + 'media-buy/get-products-response.json',
          allOf: [{ $ref: '../core/reply.json' }],
        },
      }
    );
    withExternalSchemaRoot('3.2', root, () => {
      const getters = {
        canonical: () => getCanonicalToolValidatorForVersion('get_products', 'sync', '3.2'),
        reference: () => getSchemaValidatorByRef('media-buy/get-products-response.json', '3.2'),
        runtime: () => getValidator('get_products', 'sync', '3.2'),
      };
      getters[first]();
      for (const key of Object.keys(getters))
        assert.equal(getters[key]()({ payload: 'ok', replayed: true, context: 'c' }), key === 'runtime', key);
    });
  });
}

test('origin hook escapes unusual IDs and leaves string/comment lookalikes untouched', () => {
  const origins = createSchemaDiagnosticOrigins();
  const root = { $id: 'https://schema.example/a"b\\c.json', oneOf: [{ type: 'string' }, { type: 'number' }] };
  const source = 'const text="schemaPath:\\"#/fake\\""; /* schemaPath:"#/comment" */ const e={schemaPath:"#/oneOf"};';
  const output = origins.process(source, { schema: root, root: { schema: root } });
  const result = new Function(output + 'return {text,e};')();
  assert.equal(result.text, 'schemaPath:"#/fake"');
  assert.equal(result.e.schemaPath, root.$id + '#/oneOf');
  assert.equal(origins.resolve(result.e.schemaPath), root.oneOf);
  assert.ok(output.includes('/* schemaPath:"#/comment" */'));
});

test('unknown diagnostic-code spelling fails closed without changing validation code', () => {
  for (const source of [
    'const e={schemaPath:dynamic};',
    'const e={schemaPath:`#/oneOf`};',
    'const e={schemaPath:"#/oneOf"}; const pattern=/x/;',
  ]) {
    const origins = createSchemaDiagnosticOrigins();
    const root = { $id: 'https://schema.example/root.json', oneOf: [] };
    assert.equal(origins.process(source, { schema: root, root: { schema: root } }), source);
    assert.equal(origins.resolve(root.$id + '#/oneOf'), undefined);
  }
});

test('AJV code generators with compact and multiline source preserve exact $defs origins and no payload data', () => {
  for (const lines of [false, true]) {
    const origins = createSchemaDiagnosticOrigins();
    const schema = {
      $id: `https://schema.example/lines-${lines}.json`,
      $defs: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      properties: { payload: { $ref: '#/$defs/value' } },
    };
    const validate = new Ajv({
      strict: false,
      allErrors: true,
      inlineRefs: false,
      code: { process: origins.process, lines },
    }).compile(schema);
    assert.equal(validate({ payload: false }), false);
    const error = validate.errors.find(error => error.keyword === 'oneOf');
    assert.equal(error.schemaPath, schema.$id + '#/%24defs/value/oneOf');
    assert.equal(origins.resolve(error.schemaPath), schema.$defs.value.oneOf);
    assert.ok(validate.errors.every(error => !Object.hasOwn(error, 'data')));
  }
});

test('unsupported duplicate raw union paths retain every original root diagnostic', () => {
  const { compactUnionErrors } = require('../../dist/lib/validation/schema-validator');
  const errors = Array.from({ length: 2 }, () => ({
    instancePath: '/payload',
    schemaPath: '#/oneOf',
    keyword: 'oneOf',
    params: {},
    message: 'must match exactly one schema',
  }));
  assert.deepEqual(
    compactUnionErrors(errors, () => undefined),
    errors
  );
});

test('many array-instance cascades use bounded grouping work rather than rescanning all other instances', () => {
  const { compactUnionErrors } = require('../../dist/lib/validation/schema-validator');
  const count = 2000;
  const rootPath = 'https://schema.example/root.json#/$defs/option/oneOf';
  const variants = ['a', 'b'].map(kind => ({ properties: { kind: { const: kind } } }));
  let pathReads = 0;
  const measured = (instancePath, schemaPath, keyword) => ({
    get instancePath() {
      pathReads++;
      return instancePath;
    },
    get schemaPath() {
      pathReads++;
      return schemaPath;
    },
    keyword,
    params: {},
    message: 'invalid',
  });
  const errors = Array.from({ length: count }, (_, index) => [
    measured(`/items/${index}/kind`, rootPath + '/0/properties/kind/const', 'const'),
    measured(`/items/${index}/kind`, rootPath + '/1/properties/kind/const', 'const'),
    measured(`/items/${index}`, rootPath, 'oneOf'),
  ]).flat();
  const result = compactUnionErrors(errors, (_instance, path) => (path === rootPath ? variants : undefined));
  assert.equal(result.length, count);
  assert.ok(result.every(error => error.keyword === 'enum'));
  assert.ok(pathReads < 200 * count, `${pathReads} property reads exceeded the per-instance work budget`);
});

test('missing optional AJV schema metadata leaves generated code unchanged', () => {
  const origins = createSchemaDiagnosticOrigins();
  const source = 'const e={schemaPath:"#/oneOf"};';
  assert.equal(origins.process(source), source);
});

test('multipleOf division retains origins and actionable union/$defs diagnostics', t => {
  const option = union(arm('number', ['amount'], { amount: { type: 'number', multipleOf: 5 } }), arm('text', ['text']));
  const root = fixture(t, { $defs: { option }, properties: { payload: { $ref: '#/$defs/option' } } });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: { kind: 'number', amount: 7 } }, '3.2');
    const leaf = outcome.issues.find(issue => issue.keyword === 'multipleOf');
    assert.ok(leaf, JSON.stringify(outcome.issues));
    assert.deepEqual(leaf.discriminator, [{ field: 'kind', value: 'number' }]);
    assert.ok(!outcome.issues.some(issue => issue.pointer === '/payload/text'));
  });
});

test('division recognition never rewrites regex literals after keywords or control flow', () => {
  const root = { $id: 'https://schema.example/root.json', oneOf: [] };
  for (const source of [
    'function f(){ return /schemaPath:"#\\/oneOf"/; }',
    'function f(){ throw /schemaPath:"#\\/oneOf"/; }',
    'function* f(){ yield /schemaPath:"#\\/oneOf"/; }',
    'if (data) /schemaPath:"#\\/oneOf"/.test(data);',
    'while (data) /schemaPath:"#\\/oneOf"/.test(data);',
  ]) {
    const origins = createSchemaDiagnosticOrigins();
    assert.equal(origins.process(source, { schema: root, root: { schema: root } }), source);
    assert.equal(origins.resolve(root.$id + '#/oneOf'), undefined);
  }
});

test('URI-encoded schema pointers distinguish space and literal percent-encoded keys', () => {
  const origins = createSchemaDiagnosticOrigins();
  const space = { const: 'space' };
  const percent = { const: 'percent' };
  const schema = {
    $id: 'https://schema.example/encoded.json',
    properties: { 'a b': space, 'a%20b': percent },
    $defs: { 'x y': { type: 'string' }, 'x%20y': { type: 'number' } },
    allOf: [{ properties: { first: { $ref: '#/$defs/x%20y' }, second: { $ref: '#/$defs/x%2520y' } } }],
  };
  const validate = new Ajv({
    strict: false,
    allErrors: true,
    inlineRefs: false,
    code: { process: origins.process },
  }).compile(schema);
  assert.equal(validate({ 'a b': false, 'a%20b': false, first: false, second: false }), false);
  const byInstance = new Map(validate.errors.map(error => [error.instancePath, origins.resolve(error.schemaPath)]));
  assert.equal(byInstance.get('/a b'), 'space');
  assert.equal(byInstance.get('/a%20b'), 'percent');
  assert.equal(byInstance.get('/first'), 'string');
  assert.equal(byInstance.get('/second'), 'number');
});

for (const anonymous of [false, true]) {
  test(`embedded resource schemaId survives an ${anonymous ? 'anonymous' : 'identified'} outer document`, t => {
    const childId = base + 'core/embedded-child.json';
    const document = {
      ...(anonymous ? {} : { $id: base + 'authored-outer.json' }),
      $defs: { child: { $id: childId, type: 'string' } },
      properties: { payload: { $ref: childId } },
    };
    const root = fixture(t, {}, { 'media-buy/get-products-request.json': document });
    withExternalSchemaRoot('3.2', root, () => {
      const outcome = validateRequest('get_products', { payload: 123 }, '3.2');
      assert.equal(outcome.valid, false);
      assert.equal(outcome.issues.find(issue => issue.pointer === '/payload').schemaId, childId);
      assert.ok(outcome.issues.every(issue => !issue.schemaPath.includes('urn:adcp:schema-origin:')));
      assert.ok(outcome.issues.every(issue => issue.schemaPath.startsWith('#')));
    });
  });
}

test('required-property pointers escape slashes and tildes per RFC 6901', t => {
  const root = fixture(t, { type: 'object', required: ['a/b', 'a~b'] });
  withExternalSchemaRoot('3.2', root, () => {
    assert.deepEqual(
      validateRequest('get_products', {}, '3.2')
        .issues.map(issue => issue.pointer)
        .sort(),
      ['/a~0b', '/a~1b']
    );
  });
});

test('mixed referenced and inline union arms retain the matching inline arm residual', t => {
  const root = fixture(t, {
    $defs: { image: arm('image', ['src']) },
    properties: { payload: union({ $ref: '#/$defs/image' }, arm('video', ['url'])) },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: { kind: 'video' } }, '3.2');
    const leaf = outcome.issues.find(issue => issue.pointer === '/payload/url');
    assert.ok(leaf, JSON.stringify(outcome.issues));
    assert.deepEqual(leaf.discriminator, [{ field: 'kind', value: 'video' }]);
  });
});

test('oneOf multiple-pass failures retain their nonunique-match root diagnostic', () => {
  const { compactUnionErrors } = require('../../dist/lib/validation/schema-validator');
  const schemaPath = 'https://schema.example/root.json#/oneOf';
  const root = {
    instancePath: '',
    schemaPath,
    keyword: 'oneOf',
    params: { passingSchemas: [0, 1] },
    message: 'must match exactly one schema in oneOf',
  };
  const errors = [
    {
      instancePath: '/kind',
      schemaPath: schemaPath + '/2/properties/kind/const',
      keyword: 'const',
      params: {},
      message: 'must equal constant',
    },
    root,
  ];
  const variants = [{}, {}, { properties: { kind: { const: 'other' } } }];
  assert.ok(compactUnionErrors(errors, () => variants).includes(root));
});

test('recursive union sibling constraints stay owned by their original outer arm', t => {
  const root = fixture(t, {
    $defs: {
      node: {
        oneOf: [arm('leaf', ['value']), arm('branch', ['next'], { next: { $ref: '#/$defs/node', type: 'object' } })],
      },
    },
    properties: { payload: { $ref: '#/$defs/node' } },
  });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: { kind: 'branch', next: 123 } }, '3.2');
    assert.ok(
      outcome.issues.some(
        issue => issue.pointer === '/payload/next' && issue.schemaPath.endsWith('/oneOf/1/properties/next/type')
      ),
      JSON.stringify(outcome.issues)
    );
  });
});

test('AJV dynamic-key pointer escape regexes are recognized without parsing arbitrary regex bodies', () => {
  const origins = createSchemaDiagnosticOrigins();
  const root = { $id: 'https://schema.example/pointer-escape.json', oneOf: [] };
  const source = 'const p=key0.replace(/~/g,"~0").replace(/\\//g,"~1");const e={schemaPath:"#/oneOf"};';
  const output = origins.process(source, { schema: root, root: { schema: root } });
  const result = new Function('key0', output + 'return {p,e};')('a/b~c');
  assert.equal(result.p, 'a~1b~0c');
  assert.equal(origins.resolve(result.e.schemaPath), root.oneOf);
  const unknown = 'const p=key0.replace(/schemaPath:"#\\/oneOf"/g,"");const e={schemaPath:"#/oneOf"};';
  const isolated = createSchemaDiagnosticOrigins();
  assert.equal(isolated.process(unknown, { schema: root, root: { schema: root } }), unknown);
  assert.equal(isolated.resolve(root.$id + '#/oneOf'), undefined);
});

test('synthetic discriminator enum diagnostics retain the embedded rejecting resource ID', t => {
  const childId = base + 'core/embedded-union.json';
  const document = {
    $id: base + 'authored-outer.json',
    $defs: { child: { $id: childId, oneOf: [arm('a'), arm('b')] } },
    properties: { payload: { $ref: childId } },
  };
  const root = fixture(t, {}, { 'media-buy/get-products-request.json': document });
  withExternalSchemaRoot('3.2', root, () => {
    const outcome = validateRequest('get_products', { payload: { kind: 'invalid' } }, '3.2');
    const issue = outcome.issues.find(issue => issue.keyword === 'enum');
    assert.ok(issue, JSON.stringify(outcome.issues));
    assert.equal(issue.schemaId, childId);
    assert.equal(issue.schemaPath, '');
  });
});
