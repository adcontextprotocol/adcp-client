#!/usr/bin/env node
/**
 * Clean-room dual-format smoke test for the publish artifact.
 *
 * `check:package` (publint + attw) reads the export map statically; this
 * script proves the packed tarball actually loads. It packs the package,
 * installs the tarball plus its required peerDependencies pinned to their
 * range floors into a throwaway directory in the OS temp dir, then loads
 * `@adcp/sdk`, `@adcp/sdk/enums`, and `@adcp/sdk/server` through both a real
 * ESM `import` and a real CJS `require`, asserting each exposes a known runtime
 * symbol. It also runs a modern MCP negotiation under Bun, whose ESM/CJS
 * interoperability differs from Node's.
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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  console.log(`   → ${tgz}`);

  console.log(`📥 Installing tarball + peer floors:\n   ${peerFloors.join('\n   ')}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarballPath, ...peerFloors], {
    cwd: tmpDir,
    stdio: 'inherit',
  });

  // Cover the barrel, a zod-free enum entry, and the server subpath — the last
  // adds real ESM/CJS load coverage of the @a2a-js/sdk peer through a dedicated
  // entrypoint rather than relying on whatever the barrel happens to re-export.
  const cases = [
    { specifier: '@adcp/sdk', symbol: 'EventTypeValues' },
    { specifier: '@adcp/sdk/enums', symbol: 'EventTypeValues' },
    { specifier: '@adcp/sdk/server', symbol: 'A2AInvocationError' },
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
