#!/usr/bin/env tsx
/**
 * Generate TypeScript request/response interfaces from the cached AdCP v2.5
 * schema bundle. Output: `src/lib/types/v2-5/tools.generated.ts`.
 *
 * Why a separate script: the existing `generate-types.ts` is wired to the
 * primary AdCP version (v3 today, via `LATEST_CACHE_DIR`). v2.5 is a frozen
 * target with a smaller surface (14 tools across 3 protocols, no async
 * response variants). Forking the generation pipeline keeps the v3 generator
 * fast and lets v2.5 ship with its own output file that adapter code can
 * import without colliding with the v3 type names.
 *
 * The generated file is checked in. Refresh by running:
 *   npm run sync-schemas:v2.5     # if you bumped SOURCE_SHA
 *   npm run generate-types:v2.5
 *
 * CI's "validate generated files in sync" step runs both, so a forgotten
 * regeneration after a schema refresh fails the build before it ships.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { compile } from 'json-schema-to-typescript';
import { removeArrayLengthConstraints } from './schema-utils';
import { enforceStrictSchema, removeNumberedTypeDuplicates } from './generate-types';

const REPO_ROOT = path.join(__dirname, '..');
const V25_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache/v2.5');
const OUTPUT_DIR = path.join(REPO_ROOT, 'src/lib/types/v2-5');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'tools.generated.ts');

interface TaskRef {
  request?: { $ref?: string };
  response?: { $ref?: string };
}

interface DomainEntry {
  schemas?: Record<string, { $ref?: string }>;
  tasks?: Record<string, TaskRef>;
}

interface SchemaIndex {
  adcp_version: string;
  schemas: Record<string, DomainEntry>;
}

/**
 * Resolve a v2.5 schema $ref like `/schemas/v1/media-buy/get-products-request.json`
 * (or `/schemas/2.5.3/...`) to a path inside the cached v2.5 bundle.
 *
 * v2.5 schemas use `/schemas/v1/<domain>/<file>` refs internally, but the
 * cache layout is `schemas/cache/v2.5/<domain>/<file>` (no `v1` prefix).
 * Strip the leading `/schemas/<version>/` segment and resolve relative to
 * the bundle root.
 */
function refToCachePath(ref: string): string {
  let rel = ref;
  if (rel.startsWith('/schemas/')) {
    rel = rel.slice('/schemas/'.length);
    // Strip a leading version segment when present. v2.5 schemas typically
    // ref unversioned paths (`/schemas/core/product.json`) but a few legacy
    // refs carry `v1` (`/schemas/v1/...`) or a stable semver
    // (`/schemas/2.5.3/...`). Only consume the first segment when it matches
    // one of those shapes — never when it's a domain name like `core`.
    const firstSlash = rel.indexOf('/');
    if (firstSlash > 0) {
      const head = rel.slice(0, firstSlash);
      if (/^v\d+(\.\d+)?$/.test(head) || /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(head)) {
        rel = rel.slice(firstSlash + 1);
      }
    }
  }
  return path.join(V25_CACHE_DIR, rel);
}

function loadSchema(ref: string): any {
  const filePath = refToCachePath(ref);
  if (!existsSync(filePath)) {
    throw new Error(`v2.5 schema not found at ${filePath} (ref: ${ref})`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function methodNameFromTaskName(taskName: string): string {
  return taskName.replace(/-/g, '_');
}

function pascalCase(taskName: string): string {
  return taskName
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

interface ToolDef {
  protocol: string;
  taskName: string;
  methodName: string;
  typeBaseName: string;
  request?: any;
  response?: any;
}

function loadTools(): ToolDef[] {
  const indexPath = path.join(V25_CACHE_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`v2.5 schema cache missing at ${V25_CACHE_DIR}. Run \`npm run sync-schemas:v2.5\` to populate.`);
  }
  const index: SchemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (!index.adcp_version?.startsWith('2.5.')) {
    throw new Error(`v2.5 cache reports adcp_version=${index.adcp_version} — expected 2.5.x.`);
  }
  console.log(`📥 v2.5 cache: ${index.adcp_version}`);

  const tools: ToolDef[] = [];
  const seen = new Set<string>();
  for (const [protocol, info] of Object.entries(index.schemas ?? {})) {
    if (!info?.tasks) continue;
    for (const [taskName, taskRefs] of Object.entries(info.tasks)) {
      // De-dupe across protocols (e.g., list-creative-formats lives in both
      // media-buy and creative). First occurrence wins.
      if (seen.has(taskName)) continue;
      seen.add(taskName);
      const tool: ToolDef = {
        protocol,
        taskName,
        methodName: methodNameFromTaskName(taskName),
        typeBaseName: pascalCase(taskName),
      };
      if (taskRefs.request?.$ref) {
        try {
          tool.request = loadSchema(taskRefs.request.$ref);
        } catch (err) {
          console.warn(`⚠️  ${taskName}: request schema unloadable — ${(err as Error).message}`);
        }
      }
      if (taskRefs.response?.$ref) {
        try {
          tool.response = loadSchema(taskRefs.response.$ref);
        } catch (err) {
          console.warn(`⚠️  ${taskName}: response schema unloadable — ${(err as Error).message}`);
        }
      }
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * `compile()` $ref resolver pointed at the v2.5 cache. v2.5 schemas
 * cross-reference each other (e.g., create-media-buy-request → package-request,
 * package-request → core/format-id), and `compile()` will dereference them
 * inline without this resolver.
 */
const refResolver = {
  canRead: true,
  read: (file: { url: string }) => {
    const url = file.url;
    if (!url.startsWith('/schemas/')) {
      return Promise.reject(new Error(`Cannot resolve non-spec $ref: ${url}`));
    }
    try {
      return Promise.resolve(enforceStrictSchema(removeArrayLengthConstraints(loadSchema(url))));
    } catch (err) {
      return Promise.reject(err);
    }
  },
};

async function compileSchema(name: string, schema: any): Promise<string> {
  const prepped = enforceStrictSchema(removeArrayLengthConstraints(schema));
  return compile(prepped, name, {
    bannerComment: '',
    style: { semi: true, singleQuote: true },
    additionalProperties: false,
    strictIndexSignatures: true,
    $refOptions: {
      resolve: {
        cache: refResolver,
      },
    },
  });
}

/**
 * Drop duplicate top-level type/interface/const declarations across compiled
 * tools — `compile()` re-emits shared types (e.g. `BrandID`, `FormatID`,
 * multi-line union aliases like `AssetContentType`) per call.
 *
 * Strategy: split the input into "blocks" delimited by blank lines. Each
 * block contains optionally a leading JSDoc plus one declaration. Identify
 * the declaration's name and whether the block has been seen before. First
 * occurrence wins.
 *
 * This is safer than line-by-line brace counting, which mishandles
 * multi-line union types (`export type Foo =\n  | 'a'\n  | 'b';`) that
 * have no braces but span many lines.
 */
function dedupeExports(allCode: string): string {
  const blocks = splitTopLevelBlocks(allCode);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const name = extractDeclName(block);
    if (name === undefined) {
      out.push(block);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(block);
  }
  return out.join('\n\n');
}

/**
 * Split TypeScript source into top-level blocks (declarations + their
 * leading JSDoc). Blank lines outside braces / quotes / template literals
 * delimit blocks. Tracks `{` `}` `"` `'` `\`` so a blank line inside a
 * multi-line type body or string literal doesn't split it.
 */
function splitTopLevelBlocks(src: string): string[] {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let braceDepth = 0;
  let inString: string | null = null;
  let inComment = false;
  for (const line of lines) {
    // Track multi-line block comments / strings outside the simple
    // delimiter check below. Block comments: count /* ... */ pairs.
    // String literals: only matter when they span lines, which AdCP
    // schemas don't produce — so we can keep this simple.
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (inComment) {
        if (ch === '*' && next === '/') {
          inComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        inComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        i++;
        continue;
      }
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      i++;
    }

    if (line.trim() === '' && braceDepth === 0 && !inComment && !inString) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trimEnd());
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n').trimEnd());
  return blocks;
}

/** Extract the export name from a block, or undefined if it isn't an export. */
function extractDeclName(block: string): string | undefined {
  // Skip leading JSDoc (`/** ... */`) and find the first non-comment line.
  const lines = block.split('\n');
  let inJsDoc = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith('/**') && !stripped.endsWith('*/')) {
      inJsDoc = true;
      continue;
    }
    if (inJsDoc) {
      if (stripped.endsWith('*/')) inJsDoc = false;
      continue;
    }
    if (stripped.startsWith('//')) continue;
    if (stripped.startsWith('/**') && stripped.endsWith('*/')) continue;
    if (stripped === '') continue;
    const m =
      stripped.match(/^export\s+interface\s+(\w+)/) ||
      stripped.match(/^export\s+type\s+(\w+)/) ||
      stripped.match(/^export\s+const\s+(\w+)/) ||
      stripped.match(/^export\s+enum\s+(\w+)/);
    return m?.[1];
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log('🔧 Generating AdCP v2.5 TypeScript types...');
  const tools = loadTools();
  console.log(`📦 ${tools.length} tools to compile`);

  // Build a single mega-schema with each tool's request/response under
  // `definitions`, then run `compile()` once. This sidesteps the duplicate-
  // type problem that per-tool compilation produces (each call independently
  // re-emits `BrandID`, `FormatID`, `AssetContentType`, etc.). With one
  // compile pass and shared definitions, json-schema-to-typescript
  // deduplicates internally.
  const definitions: Record<string, any> = {};
  const properties: Record<string, any> = {};
  for (const tool of tools) {
    if (tool.request) {
      const name = `${tool.typeBaseName}Request`;
      definitions[name] = enforceStrictSchema(removeArrayLengthConstraints(tool.request));
      properties[name] = { $ref: `#/definitions/${name}` };
    }
    if (tool.response) {
      const name = `${tool.typeBaseName}Response`;
      definitions[name] = enforceStrictSchema(removeArrayLengthConstraints(tool.response));
      properties[name] = { $ref: `#/definitions/${name}` };
    }
  }

  // The mega-wrapper itself becomes a type (`AdCPV25Tools`); we strip it
  // from the output so consumers only see the per-tool exports they care
  // about.
  const megaSchema = {
    title: 'AdCPV25Tools',
    type: 'object',
    properties,
    additionalProperties: false,
    definitions,
  };

  console.log(
    `🔧 Compiling ${tools.length} tools as one mega-schema (${Object.keys(definitions).length} definitions)...`
  );
  const compiled = await compile(megaSchema, 'AdCPV25Tools', {
    bannerComment: '',
    style: { semi: true, singleQuote: true },
    additionalProperties: false,
    strictIndexSignatures: true,
    $refOptions: {
      resolve: {
        cache: refResolver,
      },
    },
  });

  // Drop the wrapper type — it's an implementation detail for the codegen.
  const wrapperPattern = /export interface AdCPV25Tools \{[\s\S]*?\n\}\n*/;
  let body = compiled.replace(wrapperPattern, '').trim();

  // json-schema-to-typescript emits Foo, Foo1, Foo2 for the same enum/type when
  // it's referenced from multiple places. Collapse the numbered duplicates
  // back to the canonical name so downstream code (and autocomplete) sees one
  // export per concept.
  body = removeNumberedTypeDuplicates(body);

  const banner = `// AdCP v2.5 tool request/response types — DO NOT EDIT
// Generated from schemas/cache/v2.5/ via scripts/generate-v2-5-types.ts
// Refresh with: npm run sync-schemas:v2.5 && npm run generate-types:v2.5
`;
  const output = `${banner}\n${body}\n`;

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write only when content changes — keeps mtime stable for incremental builds.
  const stripBanner = (s: string) => s.replace(/\/\/ Generated from .*\n/, '');
  const existing = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : '';
  if (stripBanner(existing) === stripBanner(output)) {
    console.log(`✅ ${OUTPUT_FILE} is up to date`);
    return;
  }
  writeFileSync(OUTPUT_FILE, output);
  console.log(`📁 Wrote ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
