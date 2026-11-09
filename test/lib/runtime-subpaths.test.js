// Runtime subpaths for client-only consumers (adcontextprotocol/adcp-client#3664).
//
// Each subpath re-exports names the package root already exports, from the same
// source modules. These tests pin the three properties that make moving an
// import from `@adcp/sdk` to a subpath safe:
//
//   1. every runtime value is the same binding as the root's (so `instanceof`
//      and identity checks agree whichever path a caller imported);
//   2. every exported name, type or value, resolves to the same declaration as
//      the root's export of that name (so moving an import never silently
//      changes a type, the way `@adcp/sdk/types` `CreateMediaBuyRequest` differs
//      from the root's canonical alias);
//   3. the names the issue lists are runtime values, not type-only re-exports.
//
// The module-graph guarantee (no server/ or testing/ modules) lives in
// test/lib/client-entry-graph.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const pkg = require('../../package.json');

/** New subpath → its dist file stem under dist/lib/. */
const NEW_SUBPATHS = {
  './errors': 'entrypoints/errors',
  './version': 'entrypoints/version',
  './registry': 'entrypoints/registry',
  './utils': 'entrypoints/utils',
  './discovery': 'entrypoints/discovery',
  './media-buy': 'entrypoints/media-buy',
  './client/account-changes': 'entrypoints/client-account-changes',
  './client/webhook-stores': 'entrypoints/client-webhook-stores',
};

/** Subpaths whose every export must match the root's (new ones plus the existing focused client). */
const ROOT_MIRROR_SUBPATHS = { ...NEW_SUBPATHS, './client/core': 'client/core' };

/** Runtime values the issue reported as reachable only from the root, by the subpath that now carries them. */
const REQUIRED_RUNTIME_EXPORTS = {
  './errors': [
    'AuthenticationRequiredError',
    'IdempotencyConflictError',
    'IdempotencyExpiredError',
    'VersionUnsupportedError',
    'TaskTimeoutError',
    'ADCPValidationError',
    'adcpErrorToTypedError',
    'isErrorOfType',
    'STANDARD_ERROR_CODES',
    'getErrorRecovery',
    'extractAdcpErrorInfo',
    'isTerminalAdcpError',
    'decideRetry',
  ],
  './version': [
    'ADCP_VERSION',
    'LIBRARY_VERSION',
    'COMPATIBLE_ADCP_VERSIONS',
    'parseAdcpMajorVersion',
    'resolveAdcpVersion',
  ],
  './registry': ['RegistryClient', 'sanitizeStreamText'],
  './utils': [
    'canonicalize',
    'canonicalJsonSha256',
    'isMediaBuyStatus',
    'getAuthoritativeMediaBuyStatus',
    'unwrapProtocolResponse',
    'parseCapabilitiesResponse',
    'brandManifestToBrandReference',
    'MEDIA_BUY_TOOLS',
    'SIGNALS_TOOLS',
    'GOVERNANCE_TOOLS',
    'CREATIVE_TOOLS',
    'EVENT_TRACKING_TOOLS',
    'ACCOUNT_TOOLS',
    'PROTOCOL_TOOLS',
    'BRAND_RIGHTS_TOOLS',
  ],
  './discovery': [
    'canonicalizeAgentUrl',
    'resolveAgentProperties',
    'validateAdAgents',
    'parsePublisherPropertySelector',
    'expandPublisherPropertySelector',
    'expandPublisherPropertySelectors',
    'isCompactPublisherPropertySelector',
    'publisherDomainsCoveredBySelectors',
  ],
  './media-buy': ['preflightUpdateMediaBuy', 'canAddPackages', 'getAvailableActions', 'MediaBuyLifecycleCoordinator'],
  './client/account-changes': [
    'streamAccountChanges',
    'restoreAccountChangeCursor',
    'buildAccountChangeSubscriptionRequest',
  ],
  './client/webhook-stores': ['pgWebhookRegistrationStore', 'cleanupExpiredWebhookRegistrations'],
  './client/core': ['ADCP_STATUS', 'createInMemoryAgentDiscoveryCache'],
};

const specifier = subpath => `@adcp/sdk${subpath.slice(1)}`;

function assertMirrorsRoot(root, subpath, mod) {
  const names = Object.keys(mod).filter(name => name !== 'default' && name !== '__esModule');
  assert.ok(names.length > 0, `${subpath} exposes no runtime exports`);
  for (const name of names) {
    assert.ok(name in root, `${subpath} exports ${name}, which @adcp/sdk does not`);
    assert.strictEqual(mod[name], root[name], `${subpath} ${name} is not the root's binding`);
  }
}

describe('runtime subpaths mirror the package root', () => {
  it('every runtime export is the root binding (CommonJS)', () => {
    const root = require('@adcp/sdk');
    for (const subpath of Object.keys(ROOT_MIRROR_SUBPATHS)) {
      assertMirrorsRoot(root, subpath, require(specifier(subpath)));
    }
  });

  it('every runtime export is the root binding (ESM)', async () => {
    const root = await import('@adcp/sdk');
    for (const subpath of Object.keys(ROOT_MIRROR_SUBPATHS)) {
      assertMirrorsRoot(root, subpath, await import(specifier(subpath)));
    }
  });

  it('carries the issue #3664 names as runtime values, not type-only re-exports', async () => {
    for (const [subpath, names] of Object.entries(REQUIRED_RUNTIME_EXPORTS)) {
      const cjs = require(specifier(subpath));
      const esm = await import(specifier(subpath));
      for (const name of names) {
        assert.notStrictEqual(cjs[name], undefined, `${subpath} (require) is missing runtime ${name}`);
        assert.notStrictEqual(esm[name], undefined, `${subpath} (import) is missing runtime ${name}`);
      }
    }
  });

  it('keeps instanceof working across root and subpath imports', async () => {
    for (const [root, errors] of [
      [require('@adcp/sdk'), require('@adcp/sdk/errors')],
      [await import('@adcp/sdk'), await import('@adcp/sdk/errors')],
    ]) {
      const fromSubpath = new errors.AuthenticationRequiredError('https://seller.example/mcp');
      assert.ok(fromSubpath instanceof root.AuthenticationRequiredError);
      assert.ok(fromSubpath instanceof root.ADCPError);
      assert.ok(root.isErrorOfType(fromSubpath, errors.AuthenticationRequiredError));

      const typed = errors.adcpErrorToTypedError({ code: 'IDEMPOTENCY_CONFLICT', message: 'replayed' }, 'key-1');
      assert.ok(typed instanceof root.IdempotencyConflictError);
      const fromRoot = root.adcpErrorToTypedError({ code: 'IDEMPOTENCY_EXPIRED', message: 'expired' }, 'key-2');
      assert.ok(fromRoot instanceof errors.IdempotencyExpiredError);
    }
  });

  it('keeps the focused entry points off the server and testing helpers', () => {
    for (const subpath of Object.keys(ROOT_MIRROR_SUBPATHS)) {
      const mod = require(specifier(subpath));
      assert.equal(mod.createAdcpServer, undefined, `${subpath} exports createAdcpServer`);
      assert.equal(mod.testAgent, undefined, `${subpath} exports testAgent`);
    }
  });

  it('publishes both export conditions, declarations, and a typesVersions entry for each new subpath', () => {
    for (const [subpath, stem] of Object.entries(NEW_SUBPATHS)) {
      assert.deepStrictEqual(pkg.exports[subpath], {
        import: { types: `./dist/lib/${stem}.d.mts`, default: `./dist/lib/${stem}.mjs` },
        require: { types: `./dist/lib/${stem}.d.ts`, default: `./dist/lib/${stem}.js` },
      });
      assert.deepStrictEqual(pkg.typesVersions['*'][subpath.slice(2)], [`dist/lib/${stem}.d.ts`]);
      for (const ext of ['.mjs', '.js', '.d.mts', '.d.ts']) {
        const file = path.join(REPO_ROOT, 'dist/lib', `${stem}${ext}`);
        assert.ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} must exist`);
      }
    }
  });
});

// Resolve every export of a declaration file to the symbol that declares it.
function declaredExports(checker, sourceFile, ts) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert.ok(moduleSymbol, `${sourceFile.fileName} is not a module`);
  const out = new Map();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    out.set(exported.escapedName, target);
  }
  return out;
}

for (const flavor of [
  { label: 'CommonJS (.d.ts)', ext: '.d.ts' },
  { label: 'ESM (.d.mts)', ext: '.d.mts' },
]) {
  it(`every subpath export resolves to the same declaration as the root's (${flavor.label})`, () => {
    const ts = require('typescript');
    const rootFile = path.join(REPO_ROOT, 'dist/lib', `index${flavor.ext}`);
    const subpathFiles = Object.fromEntries(
      Object.entries(ROOT_MIRROR_SUBPATHS).map(([subpath, stem]) => [
        subpath,
        path.join(REPO_ROOT, 'dist/lib', `${stem}${flavor.ext}`),
      ])
    );
    const program = ts.createProgram([rootFile, ...Object.values(subpathFiles)], {
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    });
    const checker = program.getTypeChecker();
    const rootExports = declaredExports(checker, program.getSourceFile(rootFile), ts);
    const rootRuntime = require('@adcp/sdk');

    const problems = [];
    for (const [subpath, file] of Object.entries(subpathFiles)) {
      const exports = declaredExports(checker, program.getSourceFile(file), ts);
      const runtime = require(specifier(subpath));
      assert.ok(exports.size > 0, `${subpath} declares no exports`);
      for (const [name, target] of exports) {
        if (!target.declarations?.length) problems.push(`${subpath} ${name}: unresolved`);
        else if (!rootExports.has(name)) problems.push(`${subpath} ${name}: not exported by @adcp/sdk`);
        else if (rootExports.get(name) !== target) {
          problems.push(`${subpath} ${name}: a different declaration than the root's ${name}`);
        } else if (rootRuntime[name] !== undefined && runtime[name] === undefined) {
          // A runtime value on the root must not be a type-only re-export here.
          problems.push(`${subpath} ${name}: type-only, but a runtime value on @adcp/sdk`);
        }
      }
    }
    assert.deepStrictEqual(problems, []);
  });
}

for (const fixture of ['root-canonical-aliases.ts', 'root-canonical-aliases.mts']) {
  it(`pins the root canonical type aliases: CreateMediaBuyRequest, Product, PackageRequest (${fixture})`, () => {
    const { spawnSync } = require('node:child_process');
    const compiled = spawnSync(
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--skipLibCheck',
        `test/fixtures/types/${fixture}`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 }
    );
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  });
}
