'use strict';
// Schema-ref validators of one schema root and option set share one Ajv
// registry: each document of the root is registered once per process, not once
// per ref. Documents that core, canonical and schema-ref registration all add
// are meta-validated once. Validators compiled through the shared registry give
// the same verdicts and errors as a per-ref Ajv built the way the loader built
// one before, in any order, and the cases that keep their own Ajv (projected
// roots, roots outside the registered set) still fail and succeed as before.
// Work is counted through the Ajv prototype the SDK loads; no SDK internals
// are replaced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '../../dist/lib');
const loader = require(path.join(DIST, 'validation/schema-loader'));
const { ADCP_VERSION } = require(path.join(DIST, 'version'));
const Ajv = require(require.resolve('ajv', { paths: [DIST] })).default;
const addFormats = require(require.resolve('ajv-formats', { paths: [DIST] })).default;

/**
 * Run `fn` and record, for every Ajv.prototype.addSchema call with one schema,
 * the instance and the schema's $id, and for every validateSchema call on a
 * frozen (shared store) document, the document.
 */
function countAjvWork(fn) {
  const proto = Object.getPrototypeOf(Ajv.prototype);
  const { addSchema, validateSchema } = proto;
  const instances = new Set();
  const registrations = new Map();
  const validations = new Map();
  proto.addSchema = function countingAddSchema(schema, ...rest) {
    if (!Array.isArray(schema) && schema && typeof schema === 'object' && typeof schema.$id === 'string') {
      instances.add(this);
      registrations.set(schema.$id, (registrations.get(schema.$id) ?? 0) + 1);
    }
    return addSchema.call(this, schema, ...rest);
  };
  proto.validateSchema = function countingValidateSchema(schema, ...rest) {
    if (schema && typeof schema === 'object' && Object.isFrozen(schema)) {
      validations.set(schema, (validations.get(schema) ?? 0) + 1);
    }
    return validateSchema.call(this, schema, ...rest);
  };
  try {
    fn();
  } finally {
    proto.addSchema = addSchema;
    proto.validateSchema = validateSchema;
  }
  return { instances, registrations, validations };
}

const SDK_REFS = [
  'core/mcp-webhook-payload.json',
  'core/account-ref.json',
  'core/operator-unit.json',
  'core/notification-config.json',
  'account/sync-accounts-response.json',
  'media-buy/get-products-response.json',
];

test('schema-ref validators of one root and option set register each document once', t => {
  loader._resetValidationLoader();
  t.after(() => loader._resetValidationLoader());
  const { instances, registrations } = countAjvWork(() => {
    for (const ref of SDK_REFS) assert.ok(loader.getSchemaValidatorByRef(ref, ADCP_VERSION), ref);
  });
  // The refs really registered the root, so the bounds below are not vacuous.
  assert.ok(registrations.size > 500, `expected the root's documents to be registered, got ${registrations.size}`);
  assert.equal(instances.size, 1, 'one Ajv for every ref of the root');
  const repeated = Object.fromEntries([...registrations].filter(([, n]) => n > 1));
  assert.deepEqual(repeated, {}, 'documents registered more than once');

  // Another option set has its own registry, once.
  const allErrors = countAjvWork(() => {
    for (const ref of SDK_REFS)
      assert.ok(loader.getSchemaValidatorByRef(ref, ADCP_VERSION, undefined, { allErrors: true }));
  });
  assert.equal(allErrors.instances.size, 1);
  assert.equal(Math.max(...allErrors.registrations.values()), 1);
});

test("a schema-ref validator's errors change only when it is called", t => {
  loader._resetValidationLoader();
  t.after(() => loader._resetValidationLoader());
  const child = loader.getSchemaValidatorByRef('core/canonical-format-kind.json', ADCP_VERSION);
  const parent = loader.getSchemaValidatorByRef('core/canonical-projection-ref.json', ADCP_VERSION);
  assert.notEqual(child, parent);
  assert.equal(child('image'), true);
  assert.equal(child.errors, null);
  // The parent's $ref to the child fails inside the parent.
  assert.equal(parent({ kind: 'not-a-kind' }), false);
  assert.ok(parent.errors.some(error => error.instancePath === '/kind' && error.keyword === 'enum'));
  assert.equal(child.errors, null, "the parent's call left the held child validator's errors alone");
  assert.equal(child('not-a-kind'), false);
  assert.equal(child.errors[0].instancePath, '');
});

test('documents shared by core, canonical and schema-ref registration are meta-validated once', t => {
  loader._resetValidationLoader();
  t.after(() => loader._resetValidationLoader());
  const { validations } = countAjvWork(() => {
    assert.ok(loader.getValidator('create_media_buy', 'request', ADCP_VERSION));
    assert.ok(loader.getCanonicalToolValidatorForVersion('get_products', 'sync', ADCP_VERSION));
    assert.ok(loader.getSchemaValidatorByRef('core/mcp-webhook-payload.json', ADCP_VERSION));
    assert.ok(
      loader.getSchemaValidatorByRef('core/mcp-webhook-payload.json', ADCP_VERSION, undefined, { allErrors: true })
    );
  });
  assert.ok(
    validations.size > 500,
    `expected the registries to validate the root's documents, got ${validations.size}`
  );
  const repeated = [...validations].filter(([, n]) => n > 1).map(([doc]) => doc.$id ?? '(no $id)');
  assert.deepEqual(repeated, [], 'documents meta-validated more than once');
});

/** Runtime documents of a root, the set a schema-ref validator registers. */
function runtimeDocuments(root) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'bundled' && entry.name !== 'mcp') walk(full);
      } else if (entry.name.endsWith('.json')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The loader's stored document for a file of the root (as loaded: some documents are adjusted on load). */
const stored = (root, file) => loader.getSchemaDocumentByRef(path.relative(root, file), ADCP_VERSION).schema;

/** The per-ref Ajv the loader built before the shared registry: every other document, then the root. */
function perRefValidator(root, file, allErrors) {
  const ajv = new Ajv({ inlineRefs: false, strict: false, allErrors, allowUnionTypes: true });
  addFormats(ajv);
  const rootSchema = stored(root, file);
  const ids = new Set([rootSchema.$id]);
  for (const other of runtimeDocuments(root)) {
    if (other === file) continue;
    const schema = stored(root, other);
    if (typeof schema.$id === 'string' && !ids.has(schema.$id)) {
      ids.add(schema.$id);
      ajv.addSchema(schema, undefined, undefined, false);
    }
  }
  return ajv.compile(rootSchema);
}

/** Inputs that reach the schema's root keywords and each declared property. */
function corpus(schema) {
  const inputs = [{}, [], null, 0, '', true, { __unexpected__: 1 }];
  const properties = schema && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  for (const wrong of [12345, 'x', [], { nested: true }]) {
    inputs.push(Object.fromEntries(properties.map(name => [name, wrong])));
  }
  return inputs;
}

const errorView = errors =>
  (errors ?? []).map(({ instancePath, schemaPath, keyword, params, message }) => ({
    instancePath,
    schemaPath,
    keyword,
    params,
    message,
  }));

test('validators from the shared registry match a per-ref Ajv in any compile order', t => {
  t.after(() => loader._resetValidationLoader());
  const root = loader.resolveSchemaRoot(ADCP_VERSION);
  const all = runtimeDocuments(root).filter(file => typeof JSON.parse(fs.readFileSync(file, 'utf8')).$id === 'string');
  // The SDK's own refs plus every 60th document, so a large share of the graph is compiled.
  const sample = [...new Set([...SDK_REFS.map(ref => path.join(root, ref)), ...all.filter((_, i) => i % 60 === 0)])];
  assert.ok(sample.length >= 20, `sample of ${sample.length}`);
  for (const allErrors of [false, true]) {
    const expected = new Map(
      sample.map(file => {
        const validate = perRefValidator(root, file, allErrors);
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
        return [file, corpus(schema).map(input => ({ valid: validate(input), errors: errorView(validate.errors) }))];
      })
    );
    for (const order of [sample, [...sample].reverse()]) {
      loader._resetValidationLoader();
      // Compile every ref first, so each validator is compared after the others shared its registry.
      const validators = order.map(file => [
        file,
        loader.getSchemaValidatorByRef(path.relative(root, file), ADCP_VERSION, undefined, { allErrors }),
      ]);
      for (const [file, validate] of validators) {
        const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
        const actual = corpus(schema).map(input => ({ valid: validate(input), errors: errorView(validate.errors) }));
        assert.deepEqual(actual, expected.get(file), `${path.relative(root, file)} allErrors=${allErrors}`);
      }
    }
  }
});

test('roots outside the shared registry keep their own Ajv and register nothing in it', t => {
  const VERSION = '9.3.0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-shared-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => loader._resetValidationLoader());
  const id = rel => `https://adcontextprotocol.org/schemas/${VERSION}/${rel}`;
  const write = (rel, value) => {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('index.json', { adcp_version: VERSION });
  write('core/tag.json', { $id: id('core/tag.json'), type: 'string', minLength: 1 });
  write('core/item.json', { $id: id('core/item.json'), type: 'object', properties: { tag: { $ref: 'tag.json' } } });
  // Refers to an id that only a bundled document declares.
  write('core/uses-bundled-only.json', {
    $id: id('core/uses-bundled-only.json'),
    type: 'object',
    properties: { only: { $ref: id('core/bundled-only.json') } },
  });
  write('bundled/core/bundled-only.json', { $id: id('core/bundled-only.json'), type: 'integer' });
  write('media-buy/get-products-request.json', { $id: id('media-buy/get-products-request.json'), type: 'object' });

  loader.withExternalSchemaRoot(VERSION, dir, () => {
    const item = loader.getSchemaValidatorByRef('core/item.json', VERSION);
    assert.equal(item({ tag: 'ok' }), true);
    assert.equal(item({ tag: '' }), false);
    // A root under bundled/ compiles in its own Ajv, as before.
    const bundledOnly = loader.getSchemaValidatorByRef('bundled/core/bundled-only.json', VERSION);
    assert.equal(bundledOnly(3), true);
    assert.equal(bundledOnly('3'), false);
    // ...so its id never becomes resolvable for registered documents: this still fails on every call.
    for (let i = 0; i < 2; i++) {
      assert.throws(
        () => loader.getSchemaValidatorByRef('core/uses-bundled-only.json', VERSION),
        /can't resolve reference/
      );
    }
  });
});

test('a new epoch builds the registry again from the files', t => {
  const VERSION = '9.5.0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-shared-registry-epoch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => loader._resetValidationLoader());
  const id = rel => `https://adcontextprotocol.org/schemas/${VERSION}/${rel}`;
  const write = (rel, value) => {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const tag = minLength => ({ $id: id('core/tag.json'), type: 'string', minLength });
  write('index.json', { adcp_version: VERSION });
  write('core/tag.json', tag(1));
  write('core/item.json', { $id: id('core/item.json'), type: 'object', properties: { tag: { $ref: 'tag.json' } } });
  write('core/other.json', { $id: id('core/other.json'), type: 'object', properties: { tag: { $ref: 'tag.json' } } });
  write('media-buy/get-products-request.json', { $id: id('media-buy/get-products-request.json'), type: 'object' });

  loader.withExternalSchemaRoot(VERSION, dir, () => {
    assert.equal(loader.getSchemaValidatorByRef('core/item.json', VERSION)({ tag: 'ab' }), true);
  });
  write('core/tag.json', tag(3));
  // Re-entering an unsettled root starts a new epoch: a ref first compiled now sees the new dependency.
  loader.withExternalSchemaRoot(VERSION, dir, () => {
    assert.equal(loader.getSchemaValidatorByRef('core/other.json', VERSION)({ tag: 'ab' }), false);
    assert.equal(loader.getSchemaValidatorByRef('core/item.json', VERSION)({ tag: 'ab' }), false);
  });
});

test('conflicting identities in the root fail every schema-ref call', t => {
  const VERSION = '9.4.0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-shared-registry-conflict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => loader._resetValidationLoader());
  const id = rel => `https://adcontextprotocol.org/schemas/${VERSION}/${rel}`;
  const write = (rel, value) => {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('index.json', { adcp_version: VERSION });
  write('core/tag.json', { $id: id('core/tag.json'), type: 'string' });
  write('core/tag-copy.json', { $id: id('core/tag.json'), type: 'integer' });
  write('core/other.json', { $id: id('core/other.json'), type: 'boolean' });
  write('media-buy/get-products-request.json', { $id: id('media-buy/get-products-request.json'), type: 'object' });
  loader.withExternalSchemaRoot(VERSION, dir, () => {
    for (let i = 0; i < 2; i++) {
      assert.throws(
        () => loader.getSchemaValidatorByRef('core/other.json', VERSION),
        /Schema validation requires unambiguous schema identities/
      );
    }
  });
});
