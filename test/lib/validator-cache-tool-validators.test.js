'use strict';
// With ADCP_VALIDATOR_CACHE_DIR set, the validator cache keeps the modular tool
// validators (getValidator for schemas that $ref the release's shared
// documents), the canonical tool validators (getCanonicalToolValidatorForVersion)
// and the schema-ref validators (getSchemaValidatorByRef), keyed by the
// release's content, and serves their diagnostics without compiling them.
//
// Contract:
//   - A later process gets those validators without an Ajv compile or a
//     document registration, and a failing payload's diagnostics compile
//     nothing either.
//   - Every outcome a caller can see is identical cache off, cold and warm,
//     in any call order and with any mix of hits and misses: raw verdicts and
//     errors, validateRequest/validateResponse issues, registered ids, thrown
//     errors and the validators' schema objects.
//   - Each validator served from the cache is its own function.
//   - A changed document is a miss; a damaged entry compiles live.
//
// The plan runs against small fixture releases written to a temp dir, so a
// child costs a fraction of a CPU-second. Each run is a fresh child process
// that counts Ajv's top-level compiles (Ajv.prototype.compile and
// _compileSchemaEnv, the meta-schema excepted), document registrations, lookups
// of validator entries, evaluations of cached modules, directory scans and
// writes. Nothing under test is replaced. There are no wall-clock assertions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SDK_ROOT = path.resolve(__dirname, '../..');

const tempDirs = [];
const scenario = {};
after(async () => {
  // A filtered run never awaits the shared scenarios; let their children finish first.
  await Promise.allSettled(Object.values(scenario));
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function privateDir(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adcp-vtool-${label}-`)));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------- fixture releases

// The $ref-only chain's tool comes first: its origin must come from loading the
// chain's document roots, before another tool's compile could add it.
const TOOLS = [
  'get_signals',
  'get_products',
  'create_media_buy',
  'update_media_buy',
  'activate_signal',
  'list_creatives',
];
const MIRRORS = [
  'core/async-response-refs/media-buy/create-media-buy-async-response-submitted.json',
  'media-buy/create-media-buy-async-response-submitted.json',
];
// The two mirror files share entries by content, so a cold run serves the second
// from the first's entry; they stay in the probes, out of the plan's refs.
const REFS = [
  'core/account-ref.json',
  'core/b.json',
  'core/mcp-webhook-payload.json',
  'media-buy/update-media-buy-request.json',
];

/**
 * A small release: requests and responses (closed and oneOf roots, which
 * envelope widening copies), shared core documents, an enum, a discriminated
 * union, a schema-ref target, two files mirroring one $id, a recursive tool,
 * a document whose own root Ajv compiles while resolving another's reference
 * (b, for c#/properties/a) and a $ref-only definition chain (d to e).
 * `ids`: 'path' ($id /schemas/<v>/...) or 'url'. `bundled`: also ship
 * activate_signal as self-contained bundled/ documents, as releases do.
 */
function releaseFiles(version, { ids = 'url', bundled = false, marker } = {}) {
  const B = ids === 'path' ? `/schemas/${version}/` : `https://adcontextprotocol.org/schemas/${version}/`;
  const ref = rel => ({ $ref: `${B}${rel}` });
  const id = rel => ({ $id: `${B}${rel}` });
  const submitted = {
    ...id('media-buy/create-media-buy-async-response-submitted.json'),
    allOf: [ref('core/protocol-envelope.json')],
    properties: { status: { const: 'submitted' }, task_id: { type: 'string' } },
    required: ['status', 'task_id'],
  };
  // The success and error branches of activate_signal's response, as fragments
  // the authored response composes and its bundled copy inlines.
  const activateBranches = {
    success: {
      type: 'object',
      required: ['deployments'],
      additionalProperties: false,
      properties: {
        deployments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: { type: { enum: ['platform', 'agent'] }, is_live: { type: 'boolean' } },
          },
        },
      },
    },
    error: {
      type: 'object',
      required: ['errors'],
      additionalProperties: false,
      properties: { errors: { type: 'array', items: { type: 'object', required: ['code'] } } },
    },
  };
  return {
    'index.json': { adcp_version: version, ...(marker && { marker }) },
    'enums/task-status.json': {
      ...id('enums/task-status.json'),
      type: 'string',
      enum: ['completed', 'working', 'submitted'],
    },
    'enums/channel.json': { ...id('enums/channel.json'), type: 'string', enum: ['display', 'video', 'audio'] },
    'core/protocol-envelope.json': {
      ...id('core/protocol-envelope.json'),
      type: 'object',
      properties: {
        status: ref('enums/task-status.json'),
        context_id: { type: 'string' },
        task_id: { type: 'string' },
      },
    },
    'core/destination.json': {
      ...id('core/destination.json'),
      oneOf: [
        {
          type: 'object',
          required: ['type', 'platform'],
          properties: { type: { const: 'platform' }, platform: { type: 'string' }, account: { type: 'string' } },
        },
        {
          type: 'object',
          required: ['type', 'agent_url'],
          properties: { type: { const: 'agent' }, agent_url: { type: 'string', format: 'uri' } },
        },
      ],
    },
    'core/c.json': { ...id('core/c.json'), type: 'object', properties: { a: { type: 'integer' } } },
    'core/b.json': {
      ...id('core/b.json'),
      type: 'object',
      properties: { c: ref('core/c.json#/properties/a') },
      definitions: { x: { type: 'string' } },
    },
    'core/e.json': { ...id('core/e.json'), type: 'object', definitions: { b: { type: 'string' } } },
    'core/d.json': {
      ...id('core/d.json'),
      type: 'object',
      properties: { q: ref('core/c.json#/properties/a') },
      definitions: { a: ref('core/e.json#/definitions/b') },
    },
    'core/package.json': {
      ...id('core/package.json'),
      type: 'object',
      required: ['product_id'],
      additionalProperties: false,
      properties: {
        product_id: { type: 'string' },
        budget: { type: 'number', minimum: 0 },
        channels: { type: 'array', items: ref('enums/channel.json') },
      },
    },
    'core/account-ref.json': {
      ...id('core/account-ref.json'),
      oneOf: [
        {
          type: 'object',
          required: ['account_id'],
          additionalProperties: false,
          properties: { account_id: { type: 'string' } },
        },
        {
          type: 'object',
          required: ['brand', 'operator'],
          additionalProperties: false,
          properties: { brand: { type: 'string' }, operator: { type: 'string' } },
        },
      ],
    },
    'core/mcp-webhook-payload.json': {
      ...id('core/mcp-webhook-payload.json'),
      type: 'object',
      required: ['task_id', 'status'],
      properties: {
        task_id: { type: 'string' },
        task_type: { type: 'string', enum: ['create_media_buy'] },
        status: ref('enums/task-status.json'),
        result: { type: 'object' },
      },
    },
    'core/pagination-response.json': {
      ...id('core/pagination-response.json'),
      type: 'object',
      properties: { has_more: { type: 'boolean' } },
    },
    [MIRRORS[0]]: submitted,
    [MIRRORS[1]]: submitted,
    'signals/get-signals-request.json': {
      ...id('signals/get-signals-request.json'),
      type: 'object',
      properties: { p: ref('core/d.json#/definitions/a'), c: ref('core/c.json') },
    },
    'signals/get-signals-response.json': {
      ...id('signals/get-signals-response.json'),
      type: 'object',
      properties: {
        signals: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    'media-buy/get-products-request.json': {
      ...id('media-buy/get-products-request.json'),
      type: 'object',
      required: ['brief'],
      properties: {
        brief: { type: 'string' },
        channels: { type: 'array', items: ref('enums/channel.json') },
        b: ref('core/b.json#/definitions/x'),
        c: ref('core/c.json'),
        account: ref('core/account-ref.json'),
      },
    },
    'media-buy/get-products-response.json': {
      ...id('media-buy/get-products-response.json'),
      type: 'object',
      additionalProperties: false,
      required: ['products'],
      properties: {
        products: {
          type: 'array',
          items: {
            type: 'object',
            required: ['product_id'],
            properties: {
              product_id: { type: 'string' },
              channels: { type: 'array', items: ref('enums/channel.json') },
            },
          },
        },
      },
    },
    'media-buy/create-media-buy-request.json': {
      ...id('media-buy/create-media-buy-request.json'),
      type: 'object',
      required: ['packages'],
      properties: {
        packages: { type: 'array', minItems: 1, items: ref('core/package.json') },
        account: ref('core/account-ref.json'),
        destination: ref('core/destination.json'),
      },
    },
    'media-buy/create-media-buy-response.json': {
      ...id('media-buy/create-media-buy-response.json'),
      oneOf: [
        {
          type: 'object',
          required: ['media_buy_id'],
          additionalProperties: false,
          properties: {
            media_buy_id: { type: 'string' },
            packages: { type: 'array', items: ref('core/package.json') },
          },
        },
        {
          type: 'object',
          required: ['errors'],
          additionalProperties: false,
          properties: {
            errors: {
              type: 'array',
              items: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
            },
          },
        },
      ],
    },
    'media-buy/update-media-buy-request.json': {
      ...id('media-buy/update-media-buy-request.json'),
      type: 'object',
      required: ['media_buy_id'],
      properties: { media_buy_id: { type: 'string' }, packages: { type: 'array', items: ref('core/package.json') } },
    },
    'media-buy/update-media-buy-response.json': {
      ...id('media-buy/update-media-buy-response.json'),
      type: 'object',
      required: ['media_buy_id'],
      properties: { media_buy_id: { type: 'string' }, status: ref('enums/task-status.json') },
    },
    'signals/activate-signal-request.json': {
      ...id('signals/activate-signal-request.json'),
      type: 'object',
      required: ['signal_agent_segment_id', 'destinations'],
      properties: {
        signal_agent_segment_id: { type: 'string' },
        destinations: { type: 'array', minItems: 1, items: ref('core/destination.json') },
      },
    },
    'signals/activate-signal-success.json': {
      ...id('signals/activate-signal-success.json'),
      ...activateBranches.success,
    },
    'signals/activate-signal-error.json': { ...id('signals/activate-signal-error.json'), ...activateBranches.error },
    // A response that composes references: with a bundled/ copy, the getter takes that copy.
    'signals/activate-signal-response.json': {
      ...id('signals/activate-signal-response.json'),
      oneOf: [ref('signals/activate-signal-success.json'), ref('signals/activate-signal-error.json')],
    },
    ...(bundled && {
      'bundled/signals/activate-signal-response.json': {
        ...id('bundled/signals/activate-signal-response.json'),
        oneOf: [activateBranches.success, activateBranches.error],
      },
      'bundled/signals/activate-signal-request.json': {
        ...id('bundled/signals/activate-signal-request.json'),
        type: 'object',
        required: ['signal_agent_segment_id', 'destinations'],
        properties: {
          signal_agent_segment_id: { type: 'string' },
          destinations: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', required: ['type'], properties: { type: { enum: ['platform', 'agent'] } } },
          },
        },
      },
    }),
    // `#` from a definition makes Ajv call the root through a holder object, and
    // a and b refer to each other, so one of them calls the other through Ajv's
    // wrapper for a function still being compiled.
    'creative/list-creatives-request.json': {
      ...id('creative/list-creatives-request.json'),
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['a', 'b'] },
        child: { $ref: '#' },
        node: { $ref: '#/definitions/a' },
      },
      definitions: {
        a: { type: 'object', properties: { b: { $ref: '#/definitions/b' }, up: { $ref: '#' } } },
        b: { type: 'object', properties: { a: { $ref: '#/definitions/a' }, v: { type: 'integer' } } },
      },
    },
  };
}

/** Write `files` (root-relative path -> document, or raw JSON text) under `root`. */
function writeRoot(root, files) {
  for (const [rel, document] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof document === 'string' ? document : JSON.stringify(document));
  }
  return root;
}

/** A fixture release `<version>` directory in its own temp dir (or under `parent`). */
function release(label, version, options, extra = {}, parent) {
  const root = path.join(parent ?? privateDir(`root-${label}`), version);
  return writeRoot(root, { ...releaseFiles(version, options), ...extra });
}

// Payloads beyond the generated ones: the document-root origin (get_products),
// the $ref-only chain (get_signals), the two recursion paths (list_creatives).
const SIDE_EFFECT = { brief: 'x', b: 'ok', c: { a: 'not-an-int' } };
const CHAIN = { p: 'ok', c: { a: 'x' } };
const RECURSION = [
  { name: 'a', child: { name: 'b', child: { name: 'c', child: { name: 7 } } } },
  { node: { b: { a: { b: { v: 'x' } } }, up: { name: 'c', node: { up: { name: 7 } } } } },
];
const EXTRA = [SIDE_EFFECT, CHAIN, { p: 5 }, ...RECURSION];
const EDITED_REQUEST = {
  signal_agent_segment_id: 'seg_1',
  destinations: [{ type: 'platform', platform: 'dsp1' }],
};
const ENVELOPE_PAYLOAD = { products: [], status: 'zzz_new' };

/** Releases no run changes, written once. */
function sharedRoots() {
  const roots = {
    r1: release('r1', '3.0.25', { ids: 'path' }),
    r2: release('r2', '3.2.7', { ids: 'url' }),
    r3: release('r3', '3.1.31', { ids: 'url', bundled: true }),
    probe: release('probe', '3.0.25', { ids: 'path', marker: 'probe' }),
  };
  // Tools no cache can serve: a document without $id, and a property key no
  // JSON pointer can encode (the store must fail closed, never throw).
  const edgeBase = 'https://adcontextprotocol.org/schemas/3.2.7/';
  roots.edge = release(
    'edge',
    '3.2.7',
    { marker: 'edge' },
    {
      'creative/sync-creatives-request.json': { type: 'object', properties: { c: { $ref: `${edgeBase}core/c.json` } } },
      'account/sync-accounts-request.json': `{"$id":"${edgeBase}account/sync-accounts-request.json","properties":{"\\ud800":{},"c":{"$ref":"${edgeBase}core/c.json"}}}`,
    }
  );
  // Canonical registration skips files whose path has an mcp segment (same content as r1).
  roots.underMcp = release('r1-under-mcp', '3.0.25', { ids: 'path' }, {}, path.join(privateDir('root-under'), 'mcp'));
  // A document that fails meta-validation: registration throws, and Ajv keeps it.
  roots.badDocument = release(
    'bad-document',
    '3.0.25',
    { ids: 'path' },
    {
      'core/pagination-response.json': { $id: '/schemas/3.0.25/core/pagination-response.json', type: 5 },
    }
  );
  // A second file declaring an existing $id with different content.
  const destination = releaseFiles('3.0.25', { ids: 'path' })['core/destination.json'];
  roots.ambiguous = release(
    'ambiguous',
    '3.0.25',
    { ids: 'path' },
    {
      'core/destination-copy.json': { ...destination, title: 'Changed' },
    }
  );
  // A release that starts with the task statuses the envelope edit adds.
  const statuses = {
    $id: '/schemas/3.0.25/enums/task-status.json',
    type: 'string',
    enum: ['completed', 'working', 'submitted', 'zzz_new'],
  };
  roots.envelopeFresh = release(
    'envelope-fresh',
    '3.0.25',
    { ids: 'path', marker: 'envelope' },
    { 'enums/task-status.json': statuses }
  );
  roots.envelopeStatuses = JSON.stringify(statuses);
  return roots;
}

/** Releases a run edits in place: its own copies. */
function runRoots() {
  const edited = release('edited', '3.0.25', { ids: 'path', marker: 'edited' });
  const destination = JSON.parse(fs.readFileSync(path.join(edited, 'core/destination.json'), 'utf8'));
  destination.oneOf[0].properties.platform.maxLength = 2;
  return {
    edited,
    editedDestination: JSON.stringify(destination),
    envelope: release('envelope', '3.0.25', { ids: 'path', marker: 'envelope' }),
  };
}

const RELEASE_SEGMENTS = ['r1', 'r2', 'r3'];

/** The plan's segments: the releases, the probes, and one segment per edge case. */
function planSegments(shared, own, { tools = TOOLS } = {}) {
  const versionOf = root => path.basename(root);
  const releaseSegment = (name, root, extra = {}) => ({
    name,
    versions: [versionOf(root)],
    tools,
    externalRoots: [[versionOf(root), root]],
    extraPayloads: EXTRA,
    ...extra,
  });
  return [
    ...RELEASE_SEGMENTS.map(name => releaseSegment(name, shared[name])),
    { name: 'probe', versions: ['3.0.25'], probe: true, externalRoots: [['3.0.25', shared.probe]] },
    releaseSegment('edge', shared.edge, { tools: ['sync_creatives', 'sync_accounts'] }),
    releaseSegment('mcp-under', shared.underMcp, { tools: ['activate_signal'], only: 'canonical' }),
    releaseSegment('retry', shared.badDocument, { tools: ['get_products'], only: 'modular' }),
    releaseSegment('ambiguous', shared.ambiguous, { tools: ['activate_signal'] }),
    releaseSegment('edited-before', own.edited, { tools: ['activate_signal'], extraPayloads: [EDITED_REQUEST] }),
    // Only the referenced core document changes, in place: same path, same $id.
    releaseSegment('edited-after', own.edited, {
      tools: ['activate_signal'],
      extraPayloads: [EDITED_REQUEST],
      writes: [[path.join(own.edited, 'core/destination.json'), own.editedDestination]],
    }),
    // The loader derives a release's envelope fields once per root path and
    // process, so after an in-place edit this process keeps widening the closed
    // response root with the old task statuses. What it stores must not be
    // served to a root that has the new statuses from the start.
    releaseSegment('envelope-before', own.envelope, { tools: ['get_products'], extraPayloads: [ENVELOPE_PAYLOAD] }),
    releaseSegment('envelope-after', own.envelope, {
      tools: ['get_products'],
      extraPayloads: [ENVELOPE_PAYLOAD],
      writes: [[path.join(own.envelope, 'enums/task-status.json'), shared.envelopeStatuses]],
    }),
    releaseSegment('envelope-fresh', shared.envelopeFresh, {
      tools: ['get_products'],
      extraPayloads: [ENVELOPE_PAYLOAD],
    }),
  ];
}

// ---------------------------------------------------------------- child process

const CHILD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cfg = JSON.parse(process.env.PLAN);
const cacheEntries = cfg.cacheDir ? path.join(cfg.cacheDir, 'v1') + path.sep : '\0';

const counts = { compile: 0, compileSchemaEnv: 0, addSchema: 0, lookups: 0, evaluated: 0, scans: 0, writes: 0 };
const readdirSync = fs.readdirSync;
fs.readdirSync = function countingReaddir(dir, ...rest) {
  if (typeof dir === 'string' && dir + path.sep === cacheEntries) counts.scans++;
  return readdirSync.call(this, dir, ...rest);
};
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function countingWrite(file, ...rest) {
  if (typeof file === 'string' && file.startsWith(cacheEntries)) counts.writes++;
  return writeFileSync.call(this, file, ...rest);
};
const openSync = fs.openSync;
fs.openSync = function countingOpen(file, ...rest) {
  if (typeof file === 'string' && file.startsWith(cacheEntries) && file.endsWith('.js')) counts.lookups++;
  return openSync.call(this, file, ...rest);
};
const Script = vm.Script;
vm.Script = class CountingScript extends Script {
  constructor(code, options) {
    super(code, options);
    if (options && typeof options.filename === 'string' && options.filename.startsWith(cacheEntries)) counts.evaluated++;
  }
};
const ajvModule = require(require.resolve('ajv', { paths: [cfg.sdkRoot] }));
const Ajv = ajvModule.default || ajvModule;
for (const [method, key] of [['compile', 'compile'], ['_compileSchemaEnv', 'compileSchemaEnv']]) {
  const original = Ajv.prototype[method];
  Ajv.prototype[method] = function countingAjvMethod(...args) {
    // The draft-07 meta-schema compiles once per Ajv instance for addSchema's check; not a tool validator.
    if (!(method === '_compileSchemaEnv' && args[0] && args[0].meta)) counts[key]++;
    return original.apply(this, args);
  };
}
// Document registrations; a new Ajv adds its meta-schemas through addSchema(_, _, true).
const addSchema = Ajv.prototype.addSchema;
Ajv.prototype.addSchema = function countingAddSchema(schema, key, meta, ...rest) {
  if (meta !== true) counts.addSchema += Array.isArray(schema) ? schema.length : 1;
  return addSchema.call(this, schema, key, meta, ...rest);
};

const loader = require(path.join(cfg.sdkRoot, 'dist/lib/validation/schema-loader.js'));
const validator = require(path.join(cfg.sdkRoot, 'dist/lib/validation/schema-validator.js'));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Failing payloads that reach the documents a tool's schema refers to, plus a few whole-body ones. */
function payloadsFor(tool, direction, version, extra) {
  const doc = loader.getToolSchemaDocument(tool, direction, version);
  const properties = Object.keys((doc && doc.schema.properties) || {}).sort().slice(0, 12);
  const out = [{}, [], null, Object.fromEntries(properties.map(p => [p, {}]))];
  for (const p of properties) for (const value of [7, {}, [{}]]) out.push({ [p]: value });
  return out.concat(extra ?? []);
}
// Errors as Ajv returns them, plus whether params that carry schema values are
// the (frozen) schema's own arrays, as a live compile's are.
const raw = (fn, payloads) => payloads.map(p => {
  const valid = fn(p);
  const errors = fn.errors && fn.errors.map(e => (e.params && Array.isArray(e.params.allowedValues)
    ? { ...e, allowedValuesFrozen: Object.isFrozen(e.params.allowedValues) } : e));
  return { valid, errors };
});

// The probes, run first in their release's state, so its registration is still deferred.
function probe(version) {
  const out = { schemaEnv: {}, ownFunction: {} };
  // Reading schemaEnv registers the release, then compiles live.
  for (const [t, d] of [['get_products', 'sync'], ['create_media_buy', 'sync'], ['create_media_buy', 'request']]) {
    const fn = loader.getValidator(t, d, version);
    out.schemaEnv[t + ':' + d] = { same: fn.schemaEnv.schema === fn.schema, compiled: typeof fn.schemaEnv.validate === 'function' };
  }
  for (const getter of ['getValidator', 'getCanonicalToolValidatorForVersion']) {
    const a = loader[getter]('create_media_buy', 'request', version);
    const b = loader[getter]('update_media_buy', 'request', version);
    const again = loader[getter]('create_media_buy', 'request', version);
    a({ packages: [{}] });
    const held = JSON.stringify(a.errors);
    b({ packages: [{ budget: 'x' }] });
    out.ownFunction[getter] = { distinct: a !== b, stable: a === again, untouched: JSON.stringify(a.errors) === held, failed: held !== 'null' };
  }
  const [A, B] = cfg.mirrors;
  const a = loader.getSchemaValidatorByRef(A, version);
  const b = loader.getSchemaValidatorByRef(B, version);
  const docA = loader.getSchemaDocumentByRef(A, version).schema;
  const docB = loader.getSchemaDocumentByRef(B, version).schema;
  a({});
  const held = JSON.stringify(a.errors);
  b({ status: 'submitted', bogus: 1 });
  out.mirror = { sameId: docA.$id === docB.$id, distinct: a !== b, ownSchemas: a.schema.allOf === docA.allOf && b.schema.allOf === docB.allOf,
                 untouched: JSON.stringify(a.errors) === held && held !== 'null' };
  return out;
}

const steps = [];
const directions = cfg.reverse ? ['sync', 'request'] : ['request', 'sync'];
// Segments run one after another in this process, each first writing its files
// and registering its external roots; labels carry the segment's name.
for (const seg of cfg.segments) {
const prefix = seg.name ? seg.name + '|' : '';
const extra = seg.extraPayloads;
steps.push({ label: (prefix || seg.versions.join(',') + '|') + 'setup', run: () => {
  for (const [file, text] of seg.writes ?? []) fs.writeFileSync(file, text);
  for (const [version, root] of seg.externalRoots ?? []) loader.registerExternalSchemaRoot(version, root);
  return null;
} });
if (seg.probe) {
  steps.push({ label: prefix + 'probe', run: () => probe(seg.versions[0]) });
  continue;
}
const versions = cfg.reverse ? [...seg.versions].reverse() : seg.versions;
const tools = cfg.reverse ? [...seg.tools].reverse() : seg.tools;
for (const version of versions) {
  for (const tool of tools) {
    for (const direction of directions) {
      const label = prefix + version + '|' + tool + '|' + direction;
      const modular = () => {
        steps.push({ label: label + '|get', run: () => {
          const fn = loader.getValidator(tool, direction, version);
          if (!fn) return { defined: false };
          (cfg.held ??= {})[label] = fn;
          return { defined: true, schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema),
                   rootSchemaId: loader.getValidatorRootSchemaId(fn) ?? null, source: Object.hasOwn(fn, 'source') };
        } });
        steps.push({ label: label + '|raw', run: () => {
          const fn = loader.getValidator(tool, direction, version);
          return fn ? raw(fn, payloadsFor(tool, direction, version, extra)) : null;
        } });
        steps.push({ label: label + '|issues', run: () => payloadsFor(tool, direction, version, extra).map(p =>
          direction === 'request' ? validator.validateRequest(tool, p, version) : validator.validateResponse(tool, p, version)) });
      };
      const canonical = () => steps.push({ label: label + '|canonical', run: () => {
        const fn = loader.getCanonicalToolValidatorForVersion(tool, direction, version);
        if (!fn) return null;
        return { schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema), props: Object.getOwnPropertyNames(fn).sort(),
                 outcomes: raw(fn, payloadsFor(tool, direction, version, extra)) };
      } });
      if (seg.only === 'canonical') canonical();
      else if (seg.only === 'modular') modular();
      else if (cfg.reverse) { canonical(); modular(); }
      else { modular(); canonical(); }
    }
  }
  for (const ref of seg.only ? [] : cfg.refs) {
    for (const allErrors of [false, true]) {
      steps.push({ label: prefix + version + '|ref|' + ref + '|' + allErrors, run: () => {
        const fn = loader.getSchemaValidatorByRef(ref, version, undefined, { allErrors });
        if (!fn) return null;
        const doc = loader.getSchemaDocumentByRef(ref, version);
        const properties = Object.keys((doc && doc.schema.properties) || {}).sort().slice(0, 12);
        const payloads = [{}, [], null, ...properties.flatMap(p => [7, {}, [{}]].map(v => ({ [p]: v })))];
        return { schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema), props: Object.getOwnPropertyNames(fn).sort(),
                 outcomes: raw(fn, payloads) };
      } });
    }
  }
  if (!seg.only) steps.push({ label: prefix + version + '|delivery-envelope', run: () => {
    const fn = loader.getMediaBuyDeliveryEnvelopeValidator(version);
    return fn ? raw(fn, [{}, { task_type: 'x' }, { result: 7 }]) : null;
  } });
  steps.push({ label: prefix + version + '|registeredIds', run: () => [...loader.getRegisteredSchemaIds(version)].sort() });
}
}

const results = [];
for (const step of steps) {
  const before = { ...counts };
  let value;
  try {
    value = step.run();
  } catch (error) {
    value = { threw: String(error && error.message) };
  }
  const delta = {};
  for (const key of Object.keys(counts)) delta[key] = counts[key] - before[key];
  results.push({ label: step.label, digest: digest(value), ...delta });
  if (cfg.resultFile) fs.appendFileSync(cfg.resultFile, JSON.stringify({ label: step.label, value }) + '\n');
}
process.stdout.write('\n@@RESULT@@' + JSON.stringify({ results, counts }) + '\n');
`;

/** Run `segments` one after another in a fresh process. `cacheDir` undefined leaves the variable unset. */
function runChild({ cacheDir, reverse = false, segments, maxMb }) {
  const resultFile = path.join(privateDir('results'), 'results.ndjson');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PLAN: JSON.stringify({ sdkRoot: SDK_ROOT, cacheDir, reverse, segments, resultFile, refs: REFS, mirrors: MIRRORS }),
  };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  delete env.ADCP_VALIDATOR_CACHE_MAX_MB;
  if (cacheDir !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
  if (maxMb !== undefined) env.ADCP_VALIDATOR_CACHE_MAX_MB = String(maxMb);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => {
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      const parsed = JSON.parse(line.slice('@@RESULT@@'.length));
      parsed.byLabel = Object.fromEntries(parsed.results.map(r => [r.label, r]));
      parsed.resultFile = resultFile;
      resolve(parsed);
    });
  });
}

/** The first label whose value differs between two runs, with both values, or undefined. */
function firstDifference(a, b) {
  for (const r of a.results) {
    const other = b.byLabel[r.label];
    if (!other || other.digest !== r.digest) {
      const read = run =>
        fs
          .readFileSync(run.resultFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
          .find(entry => entry.label === r.label);
      return { label: r.label, a: JSON.stringify(read(a)).slice(0, 1500), b: JSON.stringify(read(b)).slice(0, 1500) };
    }
  }
  if (a.results.length !== b.results.length) return { label: '(step count)', a: a.results.length, b: b.results.length };
  return undefined;
}

function assertSameOutcomes(run, reference, context) {
  const difference = firstDifference(reference, run);
  assert.equal(difference, undefined, `${context}: ${JSON.stringify(difference, null, 1)}`);
}

const compiles = r => r.compile + r.compileSchemaEnv;

/** The value a run recorded for one step. */
function stepValue(run, label) {
  return fs
    .readFileSync(run.resultFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(entry => entry.label === label).value;
}

/** Stored validator entries (`.js`) in a cache dir. */
function entryFiles(dir) {
  const entries = path.join(dir, 'v1');
  return fs.existsSync(entries)
    ? fs
        .readdirSync(entries)
        .filter(name => name.endsWith('.js'))
        .map(name => path.join(entries, name))
    : [];
}

/** A private copy of a cache dir, with the modes the cache accepts. */
function copyCache(from, label) {
  const dir = privateDir(label);
  fs.cpSync(from, dir, { recursive: true });
  fs.chmodSync(path.join(dir, 'v1'), 0o700);
  for (const name of fs.readdirSync(path.join(dir, 'v1'))) fs.chmodSync(path.join(dir, 'v1', name), 0o600);
  return dir;
}

// ---------------------------------------------------------------- scenarios
//
// One plan, every segment, in every run: cache off forward and reversed, cold,
// warm forward and reversed, hits and misses mixed, and a damaged cache. Each
// run edits its own copies of the releases it edits.

/** Steps of release segments only (the cacheable tools; edge segments are uncacheable by design). */
const releaseSteps = run =>
  run.results.filter(
    r => RELEASE_SEGMENTS.some(name => r.label.startsWith(`${name}|`)) && !r.label.endsWith('|delivery-envelope')
  );
/** Steps of one segment. */
const segmentSteps = (run, name) => run.results.filter(r => r.label.startsWith(`${name}|`));

before(() => {
  const shared = sharedRoots();
  const plan = (options = {}) => ({ segments: planSegments(shared, runRoots(), options) });
  const dir = privateDir('main');
  const mixedDir = privateDir('mixed');
  scenario.main = (async () => {
    const off = runChild(plan());
    const offReverse = runChild({ ...plan(), reverse: true });
    const cold = await runChild({ ...plan(), cacheDir: dir });
    const entriesAfterCold = entryFiles(dir).length;
    // Both only read the entries the cold run stored, so they run together.
    const [warm, warmReverse] = await Promise.all([
      runChild({ ...plan(), cacheDir: dir }),
      runChild({ ...plan(), cacheDir: dir, reverse: true }),
    ]);
    return {
      off: await off,
      offReverse: await offReverse,
      cold,
      warm,
      warmReverse,
      dir,
      entriesAfterCold,
      entriesAfterWarm: entryFiles(dir).length,
    };
  })();
  // Half the tools cached, then the whole plan: hits and misses interleave in each release's state.
  scenario.mixed = (async () => {
    await runChild({ ...plan({ tools: TOOLS.filter((_, i) => i % 2 === 0) }), cacheDir: mixedDir });
    return runChild({ ...plan(), cacheDir: mixedDir });
  })();
  scenario.damaged = (async () => {
    const { dir: mainDir } = await scenario.main;
    const damaged = copyCache(mainDir, 'damaged-meta');
    let rewritten = 0;
    for (const file of entryFiles(damaged)) {
      const text = fs.readFileSync(file, 'utf8');
      const newline = text.indexOf('\n');
      const header = JSON.parse(text.slice('// adcp-validator-cache '.length, newline));
      if (!header.meta) continue;
      const body = text.slice(newline + 1);
      const metaEnd = body.indexOf('\n');
      const meta = JSON.parse(body.slice(0, metaEnd));
      // Bundled entries list their origins; per-function entries carry one.
      const origins = Array.isArray(meta.origins) ? meta.origins : meta.origin ? [meta.origin] : [];
      if (origins.length === 0) continue;
      // A pointer the release does not have: well-formed, correctly hashed, unlocatable.
      for (const origin of origins) origin.pointer = `${origin.pointer}/not-in-the-release`;
      const next = JSON.stringify(meta) + body.slice(metaEnd);
      header.sha256 = crypto.createHash('sha256').update(next).digest('hex');
      fs.writeFileSync(file, `// adcp-validator-cache ${JSON.stringify(header)}\n${next}`);
      rewritten++;
    }
    return { rewritten, run: await runChild({ ...plan(), cacheDir: damaged }) };
  })();
  for (const promise of Object.values(scenario)) promise.catch(() => {});
});

// ---------------------------------------------------------------- exactness

test('outcomes are identical cache off, cold and warm', async () => {
  const { off, cold, warm } = await scenario.main;
  const failing = off.results.filter(r => r.label.endsWith('|issues'));
  assert.ok(failing.length >= RELEASE_SEGMENTS.length * TOOLS.length, 'the plan validates payloads for every tool');
  assertSameOutcomes(cold, off, 'cold');
  assertSameOutcomes(warm, off, 'warm');
});

test('outcomes are identical warm in another call order, against stock in that order', async () => {
  const { offReverse, warmReverse } = await scenario.main;
  assertSameOutcomes(warmReverse, offReverse, 'warm, reverse order');
});

test('outcomes are identical when hits and misses interleave in one state', async () => {
  const [{ off }, mixed] = await Promise.all([scenario.main, scenario.mixed]);
  assertSameOutcomes(mixed, off, 'mixed');
  assert.ok(
    releaseSteps(mixed).some(r => r.label.endsWith('|get') && compiles(r) > 0),
    'the mixed run compiled the tools the first run did not store'
  );
  assert.ok(
    releaseSteps(mixed).some(r => r.label.endsWith('|get') && r.evaluated > 0),
    'and loaded the ones it stored'
  );
});

test('a cold run compiles exactly what stock compiles', async () => {
  // Not the probe: its second mirror file loads the first's entry, which a cold run just stored.
  const { off, cold } = await scenario.main;
  for (const r of off.results.filter(r => !r.label.startsWith('probe|')))
    assert.deepEqual(
      [cold.byLabel[r.label].compile, cold.byLabel[r.label].compileSchemaEnv],
      [r.compile, r.compileSchemaEnv],
      r.label
    );
});

// ---------------------------------------------------------------- work counts

test('warm runs compile no tool validator, for valid and failing payloads alike', async () => {
  const { off, warm, warmReverse } = await scenario.main;
  const modular = releaseSteps(off).filter(r => r.label.endsWith('|get') && r.compile === 0 && r.compileSchemaEnv > 0);
  const canonical = releaseSteps(off).filter(r => r.label.endsWith('|canonical') && compiles(r) > 0);
  const bundled = releaseSteps(off).filter(
    r => r.label.endsWith('|get') && String(stepValue(off, r.label).rootSchemaId).includes('/bundled/')
  );
  assert.ok(
    modular.length >= RELEASE_SEGMENTS.length * TOOLS.length,
    `modular validators in the plan: ${modular.length}`
  );
  assert.ok(
    canonical.length >= RELEASE_SEGMENTS.length * TOOLS.length,
    `canonical validators in the plan: ${canonical.length}`
  );
  assert.ok(bundled.length >= 1, 'a bundled response validator in the plan');
  for (const run of [warm, warmReverse]) {
    // The delivery-envelope projection keeps its own uncached Ajv (one per release).
    const compiled = releaseSteps(run)
      .filter(r => compiles(r) > 0)
      .map(r => `${r.label}: ${r.compile}+${r.compileSchemaEnv}`);
    assert.deepEqual(compiled, [], 'steps that compiled in a warm run');
  }
});

test('warm runs build no schema-ref registry: schema-ref validators register and compile nothing', async () => {
  const { off, warm, warmReverse } = await scenario.main;
  const refSteps = releaseSteps(off).filter(r => r.label.includes('|ref|'));
  assert.ok(refSteps.length >= RELEASE_SEGMENTS.length * REFS.length * 2, `schema-ref steps: ${refSteps.length}`);
  assert.ok(
    refSteps.some(r => r.addSchema > 0 && compiles(r) > 0),
    'cache off, the first schema-ref validator of a release builds its registry'
  );
  for (const run of [warm, warmReverse]) {
    const work = releaseSteps(run)
      .filter(r => r.label.includes('|ref|'))
      .filter(r => r.addSchema > 0 || compiles(r) > 0)
      .map(r => `${r.label}: addSchema ${r.addSchema}, compiles ${compiles(r)}`);
    assert.deepEqual(work, [], 'schema-ref steps that registered or compiled in a warm run');
  }
});

test('warm runs register no release documents: core registration waits for a validator that is not a hit', async () => {
  const { off, warm, warmReverse } = await scenario.main;
  const registering = run =>
    releaseSteps(run)
      .filter(r => r.addSchema > 0)
      .map(r => `${r.label}: ${r.addSchema}`);
  assert.ok(registering(off).length >= RELEASE_SEGMENTS.length, 'cache off, each release registers its documents');
  for (const run of [warm, warmReverse])
    assert.deepEqual(registering(run), [], 'steps that registered documents in a warm run');
});

test('every entry lookup of a warm run is a hit, and the warm runs store nothing new', async () => {
  const { warm, warmReverse, dir, entriesAfterCold, entriesAfterWarm } = await scenario.main;
  assert.ok(entriesAfterCold > 0, `the cold run stored nothing in ${dir}`);
  assert.equal(entriesAfterWarm, entriesAfterCold, `new entries in ${dir}`);
  for (const run of [warm, warmReverse]) {
    const steps = releaseSteps(run);
    const lookups = steps.reduce((n, r) => n + r.lookups, 0);
    assert.ok(lookups > 0, 'the warm run read the cache');
    assert.equal(
      steps.reduce((n, r) => n + r.evaluated, 0),
      lookups,
      'every entry looked up was found and evaluated'
    );
  }
});

// ---------------------------------------------------------------- function identity (probes)

test('each validator served from the cache is its own function: calling one leaves another errors alone', async () => {
  const { off, cold, warm } = await scenario.main;
  for (const [mode, run] of Object.entries({ off, cold, warm }))
    for (const getter of ['getValidator', 'getCanonicalToolValidatorForVersion'])
      assert.deepEqual(
        stepValue(run, 'probe|probe').ownFunction[getter],
        { distinct: true, stable: true, untouched: true, failed: true },
        `${mode} ${getter}`
      );
});

test("a hit's schema is the object registration adds later: schemaEnv.schema is the validator's schema", async () => {
  // Response roots are registered as envelope-widened copies; the probe reads
  // schemaEnv while the release's registration is still deferred.
  const { off, cold, warm } = await scenario.main;
  const expected = {
    'get_products:sync': { same: true, compiled: true },
    'create_media_buy:sync': { same: true, compiled: true },
    'create_media_buy:request': { same: true, compiled: true },
  };
  for (const [mode, run] of Object.entries({ off, cold, warm }))
    assert.deepEqual(stepValue(run, 'probe|probe').schemaEnv, expected, mode);
});

test('schema-ref validators of two files that mirror one $id stay two functions, warm too', async () => {
  const { off, cold, warm } = await scenario.main;
  const expected = { sameId: true, distinct: true, ownSchemas: true, untouched: true };
  for (const [mode, run] of Object.entries({ off, cold, warm }))
    assert.deepEqual(stepValue(run, 'probe|probe').mirror, expected, mode);
});

// ---------------------------------------------------------------- what the fixtures exercise

test('origins of document roots Ajv compiles while resolving references are served too', async () => {
  // get_products refers to b#/definitions/x and to all of c. Resolving the
  // first compiles b's own root, whose reference compiles c#/properties/a: an
  // origin at a deeper prefix than the request's own functions register,
  // which the issue for c.a reports (`#/type`, not `#/properties/a/type`).
  // get_signals reaches c#/properties/a only through d's root, which Ajv
  // compiles while following d#/definitions/a, a $ref-only definition, to e.
  const { off } = await scenario.main;
  for (const name of RELEASE_SEGMENTS) {
    const version = path.basename(segmentSteps(off, name)[1].label.split('|')[1]);
    const issues = tool => stepValue(off, `${name}|${version}|${tool}|request|issues`);
    assert.deepEqual(
      issues('get_products')
        .at(-5)
        .issues.map(issue => [issue.pointer, issue.schemaPath]),
      [['/c/a', '#/type']],
      `${name}: the document-root origin`
    );
    assert.deepEqual(
      issues('get_signals')
        .at(-4)
        .issues.map(issue => [issue.pointer, issue.schemaPath]),
      [['/c/a', '#/type']],
      `${name}: the $ref-only chain`
    );
  }
});

test('a recursive schema is served from the cache with its recursion intact', async () => {
  const { off, warm } = await scenario.main;
  for (const name of RELEASE_SEGMENTS) {
    const label = segmentSteps(off, name).find(r => r.label.endsWith('|list_creatives|request|raw')).label;
    const [deep, cycle] = stepValue(off, label).slice(-2);
    assert.deepEqual(
      deep.errors.map(e => e.instancePath),
      ['/child/child/name', '/child/child/child/name', '/child/child/child/name'],
      `${name}: the first payload fails three levels down`
    );
    assert.deepEqual(
      cycle.errors.map(e => e.instancePath),
      ['/node/b/a/b/v', '/node/up/name', '/node/up/node/up/name', '/node/up/node/up/name'],
      `${name}: the second payload fails through a, b, a, b and through # from a`
    );
    const work = segmentSteps(warm, name)
      .filter(r => r.label.includes('|list_creatives|'))
      .reduce((n, r) => n + compiles(r), 0);
    assert.equal(work, 0, `${name}: the warm run compiled nothing for it`);
  }
});

test('a referenced document edited in place is a miss: the next registration validates against the new content', async () => {
  const { off, cold } = await scenario.main;
  const label = '3.0.25|activate_signal|request';
  assert.notEqual(
    off.byLabel[`edited-after|${label}|issues`].digest,
    off.byLabel[`edited-before|${label}|issues`].digest,
    'the edit changes the outcome'
  );
  // The cold run stored the release before the edit; after it, the same process must not hit those entries.
  assert.ok(
    compiles(cold.byLabel[`edited-after|${label}|get`]) > 0,
    'the modular validator compiles against the edited root'
  );
  assert.ok(
    compiles(cold.byLabel[`edited-after|${label}|canonical`]) > 0,
    'the canonical validator compiles against the edited root'
  );
});

test('envelope fields a process derived before an in-place edit never reach another root', async () => {
  // envelope-after and envelope-fresh hold the same documents; only the envelope
  // fields their process derived differ.
  const { off, cold, warm } = await scenario.main;
  for (const [mode, run] of Object.entries({ off, cold, warm })) {
    const verdict = name => stepValue(run, `${name}|3.0.25|get_products|sync|issues`).at(-1).valid;
    assert.equal(verdict('envelope-before'), false, `${mode}: the old statuses reject the new one`);
    assert.equal(
      verdict('envelope-after'),
      false,
      `${mode}: after the edit the process keeps the old statuses (stock)`
    );
    assert.equal(verdict('envelope-fresh'), true, `${mode}: a root with the new statuses from the start accepts it`);
  }
});

test('a root under a directory named mcp is no hit for the canonical getter: it throws as stock', async () => {
  // The cold and warm runs hold entries for the same release content from r1's plain path.
  const { off, cold, warm } = await scenario.main;
  const label = 'mcp-under|3.0.25|activate_signal|request|canonical';
  assert.match(String(stepValue(off, label).threw), /can't resolve reference/);
  assert.ok(
    segmentSteps(cold, 'r1').some(r => r.label.includes('|activate_signal|') && compiles(r) > 0),
    'the plain path stored the release'
  );
  for (const [mode, run] of Object.entries({ cold, warm }))
    assert.equal(run.byLabel[label].digest, off.byLabel[label].digest, `${mode}: the same throw`);
});

test('a registration that throws and a retry behave as without the cache', async () => {
  // Ajv keeps a document it rejects, so the next call's registration skips it
  // and can succeed: outcomes depend on the call that failed first.
  const { off } = await scenario.main;
  assert.match(String(stepValue(off, 'retry|3.0.25|get_products|request|get').threw), /schema is invalid/);
  assert.ok(!stepValue(off, 'retry|3.0.25|get_products|request|raw').threw, 'the retry succeeds without the cache');
});

test('a release whose documents have ambiguous identities still throws on the canonical and schema-ref getters', async () => {
  const { off } = await scenario.main;
  assert.match(
    String(stepValue(off, 'ambiguous|3.0.25|activate_signal|request|canonical').threw),
    /unambiguous schema identities/
  );
  assert.match(
    String(stepValue(off, 'ambiguous|3.0.25|ref|core/account-ref.json|false').threw),
    /unambiguous schema identities/
  );
});

test('a tool document without $id and a property key no pointer can encode give stock outcomes', async () => {
  const { off, cold, warm } = await scenario.main;
  for (const tool of ['sync_creatives', 'sync_accounts']) {
    assert.equal(stepValue(off, `edge|3.2.7|${tool}|request|get`).defined, true, `${tool} has a validator`);
    for (const [mode, run] of Object.entries({ cold, warm }))
      for (const r of segmentSteps(run, 'edge').filter(r => r.label.includes(`|${tool}|`)))
        assert.equal(r.digest, off.byLabel[r.label].digest, `${mode} ${r.label}`);
  }
});

// ---------------------------------------------------------------- key coverage, damage and pruning

test('an entry whose origin data no longer matches the release compiles live, with stock outcomes', async () => {
  const [{ off }, { rewritten, run }] = await Promise.all([scenario.main, scenario.damaged]);
  assert.ok(rewritten > 0, 'entries with origin data');
  assertSameOutcomes(run, off, 'unlocatable origin data');
  assert.ok(run.counts.compileSchemaEnv > 0, 'the damaged entries were compiled live');
});

test('pruning keeps the directory near ADCP_VALIDATOR_CACHE_MAX_MB with far fewer scans than writes', async () => {
  // 512 entries of 8 KB into a 1 MB cache: four times the limit. A scan stats
  // every file, so the cache scans at its first write and then only every
  // eighth of the limit written or when it may be full, and prunes to seven
  // eighths, so a full directory is not scanned again on the next write.
  const dir = privateDir('prune');
  const PRUNE = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { sdkRoot, dir } = JSON.parse(process.env.PLAN);
    const entries = path.join(dir, 'v1');
    let scans = 0;
    const readdirSync = fs.readdirSync;
    fs.readdirSync = function countingReaddir(target, ...rest) {
      if (target === entries) scans++;
      return readdirSync.call(this, target, ...rest);
    };
    const { openValidatorCache } = require(path.join(sdkRoot, 'dist/lib/validation/validator-cache.js'));
    const cache = openValidatorCache(dir, path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
    const body = 'module.exports = function () { return true; };\n// ' + 'x'.repeat(8 * 1024);
    for (let i = 0; i < 512; i++) cache.write('entry-' + i, body, undefined);
    const sizes = fs.readdirSync(entries).map(name => fs.statSync(path.join(entries, name)).size);
    process.stdout.write('\n@@RESULT@@' + JSON.stringify({ scans, sizes }) + '\n');
  `;
  const { scans, sizes } = await new Promise((resolve, reject) => {
    const env = { ...process.env, ADCP_VALIDATOR_CACHE_MAX_MB: '1', PLAN: JSON.stringify({ sdkRoot: SDK_ROOT, dir }) };
    const child = spawn(process.execPath, ['-e', PRUNE], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => {
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
    });
  });
  const limit = 1024 * 1024;
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(scans * 8 < 512, `${scans} scans for 512 writes`);
  assert.ok(total <= limit + limit / 8 + Math.max(...sizes), `directory ${total} bytes for a ${limit}-byte limit`);
  assert.ok(total > limit / 2, `the directory keeps recent entries: ${total} bytes`);
});
