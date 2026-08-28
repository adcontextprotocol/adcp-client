#!/usr/bin/env node
/**
 * Clean-room dual-format smoke test for the publish artifact.
 *
 * `check:package` (publint + attw) reads the export map statically; this
 * script proves the packed tarball actually loads. It packs the package,
 * installs the tarball plus its required peerDependencies pinned to their
 * range floors into a throwaway directory in the OS temp dir, then loads
 * package entry points through both a real ESM `import` and a real CJS
 * `require`, asserting each exposes a known runtime symbol. It also compiles
 * the exact schema surface through both declaration formats and runs a modern
 * MCP negotiation under Bun, whose ESM/CJS interoperability differs from Node's.
 * A pnpm resolver pass enforces the same seven-day minimum release age used by
 * security-conscious adopters, and the npm runtime pass pins selected direct
 * dependencies to their declared compatibility floors.
 *
 * Why a temp dir outside the repo: installing inside the workspace would let
 * the monorepo dedupe peers against the repo's own node_modules, so a missing
 * or too-low peer floor would be masked. A fresh dir under os.tmpdir() with
 * its own package.json gives an honest npm resolution — the same one a
 * downstream consumer gets. This is what would have caught the @a2a-js/sdk
 * peer-floor bug (^0.3.4 declared while the code needs >=0.3.13).
 *
 * Requires a prior `npm run build:lib` — it packs whatever is in dist/.
 * Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageSize } from './check-package-size.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Lowest version a semver range accepts (first `||` clause, operators stripped). */
function rangeFloor(range) {
  const firstClause = range.split('||')[0].trim();
  const match = firstClause.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  if (!match) {
    throw new Error(`Cannot determine version floor for range: "${range}"`);
  }
  return match[0];
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// Pin every REQUIRED peer to its floor, so the smoke test resolves the exact
// minimums the export map promises — not whatever higher version npm would
// otherwise pick. Optional peers (peerDependenciesMeta) are skipped: no tested
// subpath loads them, so installing them adds only weight and registry-flake
// surface without adding load coverage.
const optionalPeers = pkg.peerDependenciesMeta ?? {};
const peerFloors = Object.entries(pkg.peerDependencies ?? {})
  .filter(([name]) => !optionalPeers[name]?.optional)
  .map(([name, range]) => `${name}@${rangeFloor(range)}`);

let tmpDir;
try {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'adcp-verify-'));
  console.log(`🧪 Clean-room dir: ${tmpDir}`);

  // A private package.json makes npm treat tmpDir as the project root, so it
  // never walks up into the repo's workspace.
  writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'adcp-verify-consumer', version: '1.0.0', private: true }, null, 2)
  );

  console.log('📏 Auditing publish size...');
  checkPackageSize(REPO_ROOT);

  // Pack into the temp dir and locate the .tgz on disk. We deliberately do NOT
  // parse `npm pack --json` stdout: npm runs the `prepare` lifecycle during
  // pack and its banner pollutes stdout (even with --ignore-scripts on some npm
  // versions), which breaks JSON parsing. Reading the emitted file sidesteps it.
  console.log('📦 Packing tarball...');
  run('npm', ['pack', '--pack-destination', tmpDir, '--ignore-scripts', '--loglevel=error'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const tgz = readdirSync(tmpDir).find(f => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no .tgz in ${tmpDir}`);
  const tarballPath = path.join(tmpDir, tgz);
  const tarballBytes = statSync(tarballPath).size;
  console.log(`   → ${tgz}`);
  console.log(`   ${(tarballBytes / 1024 / 1024).toFixed(1)} MiB`);

  // Reproduce pnpm consumers that quarantine newly-published dependency
  // versions. The SDK prerelease itself and the security-motivated jose floor
  // are explicit exceptions; every other direct/transitive resolution must
  // have aged for seven days. This catches fresh transitive floors that a
  // manifest-only timestamp check cannot see.
  const releaseAgeDir = path.join(tmpDir, 'release-age-consumer');
  mkdirSync(releaseAgeDir);
  writeFileSync(
    path.join(releaseAgeDir, 'package.json'),
    JSON.stringify(
      {
        name: 'adcp-release-age-consumer',
        version: '1.0.0',
        private: true,
        dependencies: { '@adcp/sdk': `file:${tarballPath}` },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(releaseAgeDir, 'pnpm-workspace.yaml'),
    ['minimumReleaseAge: 10080', 'minimumReleaseAgeExclude:', "  - '@adcp/sdk'", "  - 'jose@6.2.10'", ''].join('\n')
  );
  console.log('🕰️  pnpm seven-day minimum-release-age resolution:');
  run('pnpm', ['install', '--lockfile-only', '--frozen-lockfile=false'], {
    cwd: releaseAgeDir,
    stdio: 'inherit',
  });
  console.log('  packed artifact resolves without admitting unapproved fresh dependencies');

  const packedPaths = new Set(run('tar', ['-tf', tarballPath]).trim().split('\n'));
  const requiredGuides = [
    'package/docs/migration-12-to-14.md',
    'package/docs/migration-13-to-14.md',
    'package/docs/migration-12-to-13.md',
    'package/MIGRATION-v8.md',
  ];
  for (const guide of requiredGuides) {
    if (!packedPaths.has(guide)) throw new Error(`packed migration guide is missing: ${guide}`);
  }
  const packedMcpResponses = [...packedPaths].filter(
    packedPath =>
      packedPath.includes('/schemas-data/') && packedPath.includes('/mcp/') && /-response\.json$/.test(packedPath)
  );
  if (packedMcpResponses.length > 0) {
    throw new Error(`packed MCP discovery assets include response schemas: ${packedMcpResponses[0]}`);
  }
  console.log('   migration guides referenced by README are present');

  const runtimeFloors = ['tldts@7.0.0'];
  console.log(`📥 Installing tarball + runtime/peer floors:\n   ${[...runtimeFloors, ...peerFloors].join('\n   ')}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarballPath, ...runtimeFloors, ...peerFloors], {
    cwd: tmpDir,
    stdio: 'inherit',
  });
  const installedTldtsVersion = JSON.parse(
    readFileSync(path.join(tmpDir, 'node_modules', 'tldts', 'package.json'), 'utf8')
  ).version;
  if (installedTldtsVersion !== '7.0.0') {
    throw new Error(`expected tldts compatibility floor 7.0.0, got ${installedTldtsVersion}`);
  }
  console.log('  tldts compatibility floor 7.0.0 installed');

  // Cover the barrel, a zod-free enum entry, and the server subpath — the last
  // adds real ESM/CJS load coverage of the @a2a-js/sdk peer through a dedicated
  // entrypoint rather than relying on whatever the barrel happens to re-export.
  const cases = [
    { specifier: '@adcp/sdk', symbol: 'EventTypeValues' },
    { specifier: '@adcp/sdk/enums', symbol: 'EventTypeValues' },
    { specifier: '@adcp/sdk/server', symbol: 'A2AInvocationError' },
    { specifier: '@adcp/sdk/signing/server', symbol: 'resolveAgent' },
    { specifier: '@adcp/sdk/testing', symbol: 'mergeSeedProductLegacy' },
    { specifier: '@adcp/sdk/schemas', symbol: 'CreativeAssetSchema' },
  ];

  // Shared by both generated smoke modules. A function declaration (not an
  // arrow) so it hoists above the ESM import statements that call it.
  const assertSource = [
    'function assertion(m, symbol) {',
    '  if (Object.keys(m).length === 0) {',
    '    throw new Error("module exposed no exports");',
    '  }',
    '  if (m[symbol] === undefined) {',
    '    throw new Error(symbol + " export is missing");',
    '  }',
    '}',
    '',
  ].join('\n');

  // ESM: real `import` of every case in one module.
  const esmBody = cases
    .map(
      (c, i) =>
        `import * as m${i} from '${c.specifier}';\nassertion(m${i}, '${c.symbol}');\nconsole.log('  ESM ${c.specifier} → ${c.symbol} ok');`
    )
    .join('\n');
  writeFileSync(path.join(tmpDir, 'smoke.mjs'), `${assertSource}${esmBody}\n`);

  // CJS: real `require` of every case in one module.
  const cjsBody = cases
    .map(
      (c, i) =>
        `const m${i} = require('${c.specifier}');\nassertion(m${i}, '${c.symbol}');\nconsole.log('  CJS ${c.specifier} → ${c.symbol} ok');`
    )
    .join('\n');
  writeFileSync(path.join(tmpDir, 'smoke.cjs'), `${assertSource}${cjsBody}\n`);

  console.log('🔍 ESM import:');
  run('node', ['smoke.mjs'], { cwd: tmpDir, stdio: 'inherit' });
  console.log('🔍 CJS require:');
  run('node', ['smoke.cjs'], { cwd: tmpDir, stdio: 'inherit' });

  // The publish artifact omits expanded bundled JSON files and restores them
  // from one Brotli archive per wire version. Exercise all archive-backed
  // consumers from the installed tarball, where source-tree fallback is
  // impossible, and assert the protocol-authored bundled ID survives.
  writeFileSync(
    path.join(tmpDir, 'smoke-schema-archive.cjs'),
    [
      "const { validateRequest } = require('./node_modules/@adcp/sdk/dist/lib/validation/index.js');",
      "const { loadRequestSchema } = require('./node_modules/@adcp/sdk/dist/lib/conformance/schemaLoader.js');",
      "const { getToolsWithErrorArm } = require('./node_modules/@adcp/sdk/dist/lib/server/error-arm-tools.js');",
      "const invalid = validateRequest('get_products', {}, '3.2.0-beta.8');",
      "if (invalid.valid || !invalid.issues.some(issue => issue.pointer === '/buying_mode')) {",
      "  throw new Error('runtime validator did not load the archived get_products schema');",
      '}',
      "const schema = loadRequestSchema('get_products', { version: '3.2.0-beta.8' });",
      "if (!schema.$id?.includes('/bundled/media-buy/get-products-request.json')) {",
      '  throw new Error(`conformance loader returned the wrong archived schema ID: ${schema.$id}`);',
      '}',
      "const errorArmTools = getToolsWithErrorArm('3.2.0-beta.8');",
      "if (!errorArmTools.has('create_media_buy')) {",
      "  throw new Error('server error-arm discovery did not load the archived response schemas');",
      '}',
    ].join('\n')
  );
  console.log('🗜️  Archived offline schemas:');
  run('node', ['smoke-schema-archive.cjs'], { cwd: tmpDir, stdio: 'inherit' });
  console.log('  validation, conformance, and server discovery load schemas from the packed archives');

  const schemaTypeSmoke = [
    "import { CreativeAssetSchema } from '@adcp/sdk/schemas';",
    "import type { z } from 'zod';",
    '',
    'type IsAny<T> = 0 extends 1 & T ? true : false;',
    'type Input = z.input<typeof CreativeAssetSchema>;',
    'type Output = z.output<typeof CreativeAssetSchema>;',
    'const schemaIsNotAny: IsAny<typeof CreativeAssetSchema> = false;',
    'const shapeIsNotAny: IsAny<typeof CreativeAssetSchema.shape> = false;',
    'const inputIsNotAny: IsAny<Input> = false;',
    'const outputIsNotAny: IsAny<Output> = false;',
    'const creativeId = CreativeAssetSchema.shape.creative_id;',
    'const idOnly = CreativeAssetSchema.pick({ creative_id: true });',
    'const parse = (input: Input): Output => CreativeAssetSchema.parse(input);',
    'void [schemaIsNotAny, shapeIsNotAny, inputIsNotAny, outputIsNotAny, creativeId, idOnly, parse];',
    '',
  ].join('\n');
  writeFileSync(path.join(tmpDir, 'smoke-types.mts'), schemaTypeSmoke);
  writeFileSync(path.join(tmpDir, 'smoke-types.cts'), schemaTypeSmoke);
  console.log('🔬 TypeScript Node16 declarations (ESM + CJS):');
  // The generated declaration is 43 MiB and full dependency re-checking
  // exceeds an 8 GiB heap. build:lib already checks its source graph; this
  // consumer check resolves the packed bridge and instantiates its public
  // schema types while skipping diagnostics internal to dependency .d.ts files.
  const typecheckArgs = [
    '--max-old-space-size=8192',
    path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'Node16',
    '--moduleResolution',
    'Node16',
  ];
  // Compile each format in its own process. Loading both copies of this exact
  // 43 MiB inferred type graph at once can exceed an 8 GiB heap.
  for (const fixture of ['smoke-types.mts', 'smoke-types.cts']) {
    run(process.execPath, [...typecheckArgs, fixture], { cwd: tmpDir, stdio: 'inherit' });
  }
  console.log('  exact schema types resolve through both declaration formats');

  // Bun selects a different conditional-export path for dual ESM/CJS
  // dependencies than Node. Exercise the packed artifact through a real MCP
  // initialize + tool call so protocol modules retain the createRequire shim
  // needed by Bun's MCP dependency loading.
  writeFileSync(
    path.join(tmpDir, 'smoke.mcp.mjs'),
    [
      "import { createServer } from 'node:http';",
      "import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';",
      "import { toNodeHandler } from '@modelcontextprotocol/node';",
      "import { callMCPTool, closeMCPConnections } from '@adcp/sdk';",
      '',
      'const handler = createMcpHandler(() => {',
      "  const server = new McpServer({ name: 'package-smoke', version: '1.0.0' });",
      "  server.registerTool('echo', { description: 'Echo a fixed result' }, async () => ({",
      "    content: [{ type: 'text', text: 'ok' }],",
      '  }));',
      '  return server;',
      "}, { legacy: 'reject' });",
      'const nodeHandler = toNodeHandler(handler);',
      'const httpServer = createServer((req, res) => void nodeHandler(req, res));',
      "await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });",
      'try {',
      '  const address = httpServer.address();',
      "  if (!address || typeof address === 'string') throw new Error('server did not bind');",
      '  const result = await callMCPTool(',
      '    `http://127.0.0.1:${address.port}/mcp`,',
      "    'echo', {}, undefined, [], {}, undefined, undefined, { requestTimeoutMs: 5_000 }",
      '  );',
      "  if (result.content?.[0]?.text !== 'ok') throw new Error(`unexpected MCP result: ${JSON.stringify(result)}`);",
      '} finally {',
      '  await closeMCPConnections();',
      '  await handler.close();',
      '  await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));',
      '}',
    ].join('\n')
  );
  console.log('🔥 Bun MCP negotiation:');
  run('npx', ['--yes', 'bun@1.3.8', 'smoke.mcp.mjs'], { cwd: tmpDir, stdio: 'inherit' });
  console.log('  Bun ESM negotiation through @adcp/sdk ok');

  // The modern MCP server consumes the adopter's Zod peer. Zod 4.1 satisfies
  // our declared range but predates `~standard.jsonSchema`; exercise a real
  // packed AdCP server at that exact floor so tools/list cannot silently
  // regress to `{ properties: {} }` while source tests use a newer Zod.
  writeFileSync(
    path.join(tmpDir, 'smoke.mcp-schema.mjs'),
    [
      "import { createRequire } from 'node:module';",
      "import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
      "import { InMemoryStateStore, serve } from '@adcp/sdk';",
      "import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';",
      '',
      'const require = createRequire(import.meta.url);',
      "const zodVersion = require('zod/package.json').version;",
      "if (zodVersion !== '4.1.5') throw new Error(`expected the Zod peer floor 4.1.5, got ${zodVersion}`);",
      'const httpServer = serve(',
      '  () => createAdcpServer({',
      "    name: 'package-schema-smoke',",
      "    version: '1.0.0',",
      '    stateStore: new InMemoryStateStore(),',
      '  }),',
      '  { port: 0, onListening: () => {} }',
      ');',
      "await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listening ? resolve() : httpServer.once('listening', resolve); });",
      'const address = httpServer.address();',
      "if (!address || typeof address === 'string') throw new Error('AdCP server did not bind');",
      'const client = new Client(',
      "  { name: 'package-schema-client', version: '1.0.0' },",
      "  { versionNegotiation: { mode: { pin: '2026-07-28' } } }",
      ');',
      'try {',
      '  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));',
      '  const listed = await client.listTools();',
      '  const discoveryBytes = Buffer.byteLength(JSON.stringify(listed.tools));',
      '  if (discoveryBytes > 1024 * 1024) throw new Error(`default tools/list is ${discoveryBytes} bytes; budget is 1 MiB`);',
      '  if (listed.tools.some(tool => tool.outputSchema !== undefined)) throw new Error("default tools/list must remain input-only");',
      "  const capabilities = listed.tools.find(tool => tool.name === 'get_adcp_capabilities');",
      '  if (!capabilities?.inputSchema?.properties?.protocols) throw new Error(`empty AdCP input schema at Zod ${zodVersion}: ${JSON.stringify(capabilities?.inputSchema)}`);',
      '} finally {',
      '  await client.close().catch(() => {});',
      '  await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));',
      '}',
    ].join('\n')
  );
  console.log('🧩 Modern AdCP tools/list at Zod peer floor:');
  run('node', ['smoke.mcp-schema.mjs'], { cwd: tmpDir, stdio: 'inherit' });
  console.log('  bundled AdCP input schemas survive Zod 4.1.5');

  // `@adcp/sdk/enums` is documented as a lean, zod-free entry point safe for
  // browser bundlers. Bundling it with `--platform=browser` catches
  // Node-only imports (`node:url`/`node:path`/`node:module`, etc.) that
  // esbuild's `--platform=node` and plain `node` execution above wouldn't —
  // this is what would have caught adcp#2364 (an unconditional ESM banner
  // dragging Node built-ins into every `.mjs`, including pure-data ones).
  console.log('🌐 Browser bundle check (--platform=browser) for @adcp/sdk/enums:');
  writeFileSync(
    path.join(tmpDir, 'smoke.browser.mjs'),
    [
      "import { EventTypeValues } from '@adcp/sdk/enums';",
      "if (EventTypeValues.length === 0) throw new Error('EventTypeValues is empty');",
    ].join('\n')
  );
  run(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild'),
    ['smoke.browser.mjs', '--bundle', '--format=esm', '--platform=browser', '--outfile=smoke.browser.out.js'],
    { cwd: tmpDir, stdio: 'inherit' }
  );
  console.log('  browser bundle of @adcp/sdk/enums ok');

  console.log(
    '\n✅ Package loads in Node and Bun with peer floors satisfied, negotiates MCP, and browser-bundles cleanly.'
  );
} catch (err) {
  console.error('\n❌ Package verification failed:');
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  // The tarball lives inside tmpDir, so removing the dir removes it too.
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}
