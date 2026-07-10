import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { defineConfig } from 'tsup';
import { fixImportsPlugin } from 'esbuild-fix-imports-plugin';

// Companion to `fixImportsPlugin`: that plugin rewrites static `from '...'` and
// `require('...')` specifiers, but not dynamic `import('...')`. Under
// `bundle: false` those stay extensionless, so a lazy `await import('../x')`
// throws ERR_MODULE_NOT_FOUND at runtime. Mirror the same fix for dynamic
// imports — append the format extension, or `/index` for a directory target.
// (Kept as dynamic imports rather than converted to static, so the heavy
// modules they load stay out of the eager graph and remain tree-shakeable.)
function fixDynamicImportExtensions() {
  return {
    name: 'fix-dynamic-import-extensions',
    setup(build: import('esbuild').PluginBuild) {
      const ext = build.initialOptions.format === 'esm' ? '.mjs' : '.js';
      build.onEnd(result => {
        for (const file of result.outputFiles ?? []) {
          if (!file.path.endsWith(ext)) continue;
          // bundle:false preserves the tree, so the output file maps 1:1 to a
          // source file; resolve specifiers against the source dir.
          const srcDir = nodePath.dirname(
            file.path.replace(
              `${nodePath.sep}dist${nodePath.sep}lib${nodePath.sep}`,
              `${nodePath.sep}src${nodePath.sep}lib${nodePath.sep}`
            )
          );
          const code = Buffer.from(file.contents).toString('utf8');
          const next = code.replace(/import\(\s*(["'])(\.[^"']+)\1\s*\)/g, (match, quote, spec) => {
            if (/\.(mjs|cjs|js|json|node|wasm)$/.test(spec)) return match;
            const abs = nodePath.resolve(srcDir, spec);
            if (existsSync(`${abs}.ts`)) return `import(${quote}${spec}${ext}${quote})`;
            if (existsSync(nodePath.join(abs, 'index.ts'))) return `import(${quote}${spec}/index${ext}${quote})`;
            return match;
          });
          if (next !== code) file.contents = Buffer.from(next);
        }
      });
    },
  };
}

// Build the library as a tree-shakeable dual package.
//
// `bundle: false` transpiles each source module 1:1 (no bundling, no chunks),
// so the output mirrors the source tree exactly. That keeps three things
// correct with zero extra work:
//   1. a consumer's bundler tree-shakes across the preserved module graph when
//      it imports from a public entry (importing one symbol stays lean),
//   2. the CLI and internal tooling that deep-`require` dist paths still
//      resolve, and
//   3. the `__dirname`-based schema-data lookups keep their original directory
//      depth (each module stays at its own path).
//
// `fixImportsPlugin` (see tsup#1240) supplies what `bundle: false` leaves out:
// it appends the correct extension to relative imports, rewrites directory
// imports to `/index`, and resolves tsconfig path aliases. Its alias step is
// neutralised by pointing the build at a paths-free tsconfig (below), because
// the only `paths` entry (`structured-headers`) is a typecheck-only pin to the
// package's CJS type file and must stay a bare external import at runtime.
// Declarations are emitted separately by `tsc --emitDeclarationOnly`.
export default defineConfig({
  entry: ['src/lib/**/*.ts', '!src/lib/**/*.test.ts', '!src/lib/**/*.d.ts', '!src/lib/**/*.type-checks.ts'],
  outDir: 'dist/lib',
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'node',
  bundle: false,
  // A paths-free tsconfig so the import-fixer's alias resolution is a no-op.
  // The only `paths` entry (`structured-headers`) is a typecheck-only pin;
  // at runtime it must stay a bare external import, not a rewritten path.
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  dts: false,
  // Not tsup's `shims: true`: with many entries it emits `__dirname` once in a
  // shared chunk (resolving to the chunk's dir, not each module's). The banner
  // below is inlined into every ESM file, so `import.meta.url` — and therefore
  // `__dirname` — is correct per file. CJS keeps the native globals.
  shims: false,
  esbuildOptions(options, context) {
    if (context.format === 'esm') {
      options.banner = {
        js: [
          "import { fileURLToPath as __adcpFileURLToPath } from 'node:url';",
          "import { dirname as __adcpDirname } from 'node:path';",
          "import { createRequire as __adcpCreateRequire } from 'node:module';",
          'const __filename = __adcpFileURLToPath(import.meta.url);',
          'const __dirname = __adcpDirname(__filename);',
          'const require = __adcpCreateRequire(import.meta.url);',
        ].join('\n'),
      };
    }
  },
  // ESM → .mjs (the `import` condition), CJS → .js (the `require` condition and
  // the CLI's `require('../dist/lib/...')`). The package stays `type: commonjs`.
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  esbuildPlugins: [fixImportsPlugin(), fixDynamicImportExtensions()],
});
