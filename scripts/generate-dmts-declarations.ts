#!/usr/bin/env tsx
/**
 * TL;DR: we ship the library in two module formats (.mjs / .js), and each
 * format needs its own matching set of type files. Our build tools only produce
 * the type files for one format; the tool that would produce the other set
 * can't handle a project this large. So this script produces the missing set.
 * Delete it once the build can generate both natively.
 *
 * Emit ESM-format type declarations (`.d.mts`) alongside the `.d.ts` files
 * produced by `tsc --emitDeclarationOnly`.
 *
 * The package is `type: commonjs`, so a `.d.ts` is interpreted as a CJS-format
 * declaration. When a consumer resolves the package through the `import`
 * condition (real ESM, `moduleResolution: node16`/`bundler`), TypeScript then
 * types the `.mjs` runtime file with that CJS `.d.ts` — attw flags this as
 * "masquerading as CJS" (FalseCJS). Shipping a parallel `.d.mts` for the
 * `import` condition gives ESM consumers an ESM-format declaration, so the
 * runtime format and the declaration format agree.
 *
 * ESM declaration resolution requires explicit relative specifiers, so this is
 * the declaration-layer companion to the runtime import-fixers in
 * `tsup.config.ts`: it normally copies each `.d.ts` to `.d.mts` and appends the
 * module extension to every relative `from`/`import(...)` specifier — `.mjs`
 * for a file, `/index.mjs` for a directory — resolving each against the built
 * dist tree (the bytes that actually ship). The multi-MiB generated
 * declarations in {@link ESM_FACADE_DECLARATIONS} are the exception: their ESM
 * file is a one-line facade over the canonical CJS declaration instead of a
 * byte-for-byte duplicate, which would otherwise double their share of the
 * published tarball.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Optional first argument: the dist directory to process (default `dist/lib`, the SDK layout).
// `packages/reporting-storage` passes `dist`.
const DIST_LIB = path.resolve(process.cwd(), process.argv[2] ?? 'dist/lib');

function collectDeclarationFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDeclarationFiles(full));
    } else if (entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// The per-tool type slices under `dist/lib/types/` are reached only through the
// types-only `./types/*` wildcard export (no `import`/`require` condition), so
// they never resolve as ESM and a `.d.mts` for them is dead weight (~5.5 MB).
// Skip them, keyed off the authoritative per-tool manifest.
function wildcardOnlySlices(): Set<string> {
  const indexPath = path.join(DIST_LIB, 'types', 'per-tool-index.json');
  if (!existsSync(indexPath)) return new Set();
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    tools: Record<string, { subpath: string }>;
  };
  return new Set(Object.values(index.tools).map(t => path.join(DIST_LIB, 'types', `${path.basename(t.subpath)}.d.ts`)));
}

// Generated declarations whose `.d.mts` is `export * from './<name>.js';`
// rather than a copy. The Zod declaration is tens of MiB because TypeScript
// expands the inferred schema shapes; the protocol and registry type modules
// are 0.5-2.7 MiB of interfaces and type aliases each. Copying all four cost
// about 1.2 MB of the packed tarball. The type-only entries must stay free of
// value declarations and package imports, so ESM and CJS consumers resolve the
// exact same structural types through the facade.
const ESM_FACADE_DECLARATIONS: ReadonlyArray<{ file: string; typeOnly: boolean }> = [
  { file: 'types/schemas.generated.d.ts', typeOnly: false },
  { file: 'types/core.generated.d.ts', typeOnly: true },
  { file: 'types/tools.generated.d.ts', typeOnly: true },
  { file: 'registry/types.generated.d.ts', typeOnly: true },
];

function hasDefaultExport(source: string): boolean {
  return (
    /^\s*export\s+default\b/m.test(source) ||
    /^\s*export\s*=\s*/m.test(source) ||
    /\bexport\s*\{[^}]*\bdefault\b[^}]*\}/m.test(source)
  );
}

// tsc emits top-level statements at column 0, so anchoring there skips
// interface members such as a schema's `enum?: string[]` and JSDoc text.
function hasValueOrPackageDependency(source: string): boolean {
  return (
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum|namespace|module)\b/m.test(
      source
    ) || /^(?:import|export)\b[^;]*\bfrom\s*['"][^.'"][^'"]*['"]/m.test(source)
  );
}

function writeEsmFacade(file: string, source: string, typeOnly: boolean): void {
  const name = path.basename(file, '.d.ts');
  if (hasDefaultExport(source)) {
    throw new Error(`${name}.d.ts has an export that the ESM facade would omit`);
  }
  if (typeOnly && hasValueOrPackageDependency(source)) {
    throw new Error(`${name}.d.ts is no longer type-only; give it a full ESM declaration or review the facade`);
  }
  if (!existsSync(file.replace(/\.d\.ts$/, '.js'))) {
    throw new Error(`${name}.js is missing; build runtime files before declarations`);
  }
  writeFileSync(file.replace(/\.d\.ts$/, '.d.mts'), `export * from './${name}.js';\n`);
}

// Resolve a relative specifier against the dist tree and return the ESM form.
// A specifier that already carries a JS/JSON extension is normalised (`.js` →
// `.mjs`); an extensionless one becomes `<spec>.mjs` for a file or
// `<spec>/index.mjs` for a directory. Anything that resolves to neither is
// left untouched (bare packages, or specifiers we can't classify).
function toEsmSpecifier(spec: string, fromDir: string): string {
  const extMatch = spec.match(/\.(mjs|cjs|js|json|node|wasm)$/);
  if (extMatch) {
    return extMatch[1] === 'js' ? spec.replace(/\.js$/, '.mjs') : spec;
  }
  const abs = path.resolve(fromDir, spec);
  if (existsSync(`${abs}.d.ts`)) return `${spec}.mjs`;
  if (existsSync(path.join(abs, 'index.d.ts'))) return `${spec}/index.mjs`;
  return spec;
}

// Rewrite the specifier in every real `from '...'` / `import('...')` clause.
// The leading alternative consumes block and line comments whole and returns
// them untouched, so relative paths inside JSDoc `@example` blocks are left
// alone (rewriting them would corrupt the shipped documentation examples).
function rewriteSpecifiers(code: string, fromDir: string): string {
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]+)\3/g;
  return code.replace(pattern, (match, comment, pre, quote, spec) => {
    if (comment !== undefined) return comment;
    return `${pre}${quote}${toEsmSpecifier(spec, fromDir)}${quote}`;
  });
}

function main(): void {
  if (!existsSync(DIST_LIB) || !statSync(DIST_LIB).isDirectory()) {
    throw new Error(`dist/lib not found at ${DIST_LIB}; run the declaration emit (tsc) first`);
  }

  const skip = wildcardOnlySlices();
  const declarations = collectDeclarationFiles(DIST_LIB).filter(f => !skip.has(f));
  const facades = new Map(ESM_FACADE_DECLARATIONS.map(entry => [path.join(DIST_LIB, entry.file), entry.typeOnly]));
  let written = 0;
  for (const file of declarations) {
    const source = readFileSync(file, 'utf8');
    const typeOnly = facades.get(file);
    if (typeOnly !== undefined) {
      writeEsmFacade(file, source, typeOnly);
      written++;
      continue;
    }
    // The declaration map points at the `.d.ts`; drop the reference rather than
    // ship a `.d.mts` whose sourceMappingURL resolves to the wrong file.
    const withoutMap = source.replace(/\n?\/\/# sourceMappingURL=.*\.d\.ts\.map\s*$/, '\n');
    const rewritten = rewriteSpecifiers(withoutMap, path.dirname(file));
    const target = file.replace(/\.d\.ts$/, '.d.mts');
    writeFileSync(target, rewritten);
    written++;
  }
  console.log(`✅ Emitted ${written} .d.mts declaration(s) alongside .d.ts`);
}

main();
