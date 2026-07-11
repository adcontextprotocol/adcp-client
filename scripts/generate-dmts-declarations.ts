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
 * `tsup.config.ts`: it copies each `.d.ts` to `.d.mts` and appends the module
 * extension to every relative `from`/`import(...)` specifier — `.mjs` for a
 * file, `/index.mjs` for a directory — resolving each against the built dist
 * tree (the bytes that actually ship).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const DIST_LIB = path.resolve(process.cwd(), 'dist/lib');

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
  let written = 0;
  for (const file of declarations) {
    const source = readFileSync(file, 'utf8');
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
