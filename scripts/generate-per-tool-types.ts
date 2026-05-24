#!/usr/bin/env tsx
/**
 * Emit a self-contained `.d.ts` slice per AdCP tool, so adopters who
 * only need one tool's types pay a fraction of the cost of importing
 * the full `@adcp/sdk` surface.
 *
 * Measured: an adopter tsc against the `sync_accounts` slice peaks
 * at ~50 MB; against the full surface it OOMs at 4 GB. ~95× memory
 * reduction, ~25× wall-clock speedup.
 *
 * Strategy:
 *   1. Parse `tools.generated.d.ts`, `core.generated.d.ts`, and
 *      `enums.generated.d.ts` into a name→declaration map.
 *   2. For each AdCP tool, BFS-walk dependencies starting from
 *      `{Pascal}Request`, `{Pascal}Response`, and any
 *      `{Pascal}Success` / `{Pascal}Error` / `{Pascal}Submitted`
 *      variants present in the source.
 *   3. Emit each slice as a self-contained `.d.ts` at
 *      `dist/lib/types/<tool>.d.ts` (kebab-case filename). No
 *      cross-slice imports — an adopter loads exactly one slice and
 *      nothing else.
 *   4. Emit `dist/lib/types/per-tool-index.json` mapping spec
 *      snake_case names to subpaths so LLM-coded adopters can
 *      discover the surface without filesystem-walking.
 *
 * Adopters opt in via subpath imports:
 *
 *     import type { SyncAccountsRequest } from '@adcp/sdk/types/sync-accounts';
 *
 * The root `@adcp/sdk` re-export remains the full surface; nothing
 * about the published API changes for adopters who don't opt in.
 *
 * @public
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const DIST_TYPES = path.join(REPO_ROOT, 'dist', 'lib', 'types');
// Per-tool slices live under `dist/lib/types/` (not a subdir) so the
// subpath import reads as `@adcp/sdk/types/<tool>` — the spec name
// adopters already think in.
const OUT_DIR = DIST_TYPES;

/**
 * Convert an AdCP tool name (`sync_accounts`) to the PascalCase prefix
 * the codegen uses for its request/response types (`SyncAccounts`).
 *
 * Exported because `check-adopter-types-narrow.ts` needs the same
 * mapping to build adopter import statements — duplicating the
 * carve-outs across two files would let them drift.
 *
 * Two carve-outs match the upstream codegen's exact naming:
 *   - `adcp` segments uppercase to `AdCP` (e.g. `get_adcp_capabilities`
 *     → `GetAdCPCapabilities`).
 *   - `si_` prefixes uppercase to `SI` (e.g. `si_get_offering` →
 *     `SIGetOffering`). The sponsored-intelligence tools were
 *     intentionally upper-cased upstream to mirror the spec's
 *     acronym-style naming.
 */
export function toolNameToPascal(toolName: string): string {
  const segments = toolName.split('_');
  return segments
    .map((seg, idx) => {
      if (seg === 'adcp') return 'AdCP';
      if (idx === 0 && seg === 'si') return 'SI';
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    })
    .join('');
}

/** Convert `sync_accounts` → `sync-accounts` (subpath/filename form). */
export function toolNameToKebab(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

interface ExportInfo {
  name: string;
  kind: 'interface' | 'type' | 'enum';
  body: string;
  sourceFile: string;
}

/**
 * Parse a `.d.ts` file into a map of export-name → declaration. Each
 * declaration includes the leading JSDoc block.
 *
 * The parser is intentionally line-oriented rather than full AST — it
 * only needs to identify top-level `export interface | type | enum`
 * boundaries. Brace-balanced for interfaces/enums; semicolon-terminated
 * at depth 0 for type aliases.
 */
function parseExports(filePath: string): Map<string, ExportInfo> {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const exports = new Map<string, ExportInfo>();

  let i = 0;
  while (i < lines.length) {
    // Skip past JSDoc block immediately preceding an export. The closing
    // `*/` is matched anywhere on the line (not just end-of-line) so a
    // single-line JSDoc like `/** brief */ export interface X` parses
    // correctly. Without that flexibility, the JSDoc would be silently
    // dropped from the slice when the upstream emitter ever changed
    // formatting style.
    let jsdocStart = -1;
    if (/^\s*\/\*\*/.test(lines[i] ?? '')) {
      let j = i;
      while (j < lines.length && !(lines[j] ?? '').includes('*/')) j++;
      if (j < lines.length) {
        let k = j + 1;
        while (k < lines.length && (lines[k] ?? '').trim() === '') k++;
        if (k < lines.length && /^export /.test(lines[k] ?? '')) {
          jsdocStart = i;
          i = k;
        }
      }
    }

    const headerMatch = (lines[i] ?? '').match(/^export (interface|type|enum) (\w+)/);
    if (!headerMatch) {
      i++;
      continue;
    }
    const kind = headerMatch[1] as 'interface' | 'type' | 'enum';
    const name = headerMatch[2];
    const blockStart = jsdocStart >= 0 ? jsdocStart : i;

    let blockEnd = i;
    if (kind === 'interface' || kind === 'enum') {
      // Brace-balanced.
      let depth = 0;
      let started = false;
      outer: for (let line = i; line < lines.length; line++) {
        for (const ch of lines[line] ?? '') {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
            if (started && depth === 0) {
              blockEnd = line;
              break outer;
            }
          }
        }
      }
    } else {
      // Type alias — first `;` at brace/paren/bracket depth 0. Strip
      // line comments (`type Foo = Bar; // note`) and block comments
      // (JSDoc inside object bodies) per line before scanning, so
      // braces/brackets inside prose don't perturb the depth counter
      // and trailing comments don't mask the `;` terminator. Template-
      // literal types aren't currently emitted by upstream codegen —
      // if they ever appear, this parser will need backtick-aware
      // depth tracking.
      let depth = 0;
      let inBlockComment = false;
      let found = false;
      for (let line = i; line < lines.length; line++) {
        let s = lines[line] ?? '';
        // Drop line comments.
        s = s.replace(/\/\/.*$/, '');
        // Drop block-comment content per-line (`/* ... */` and `/** ... */`),
        // both single-line and across the multi-line span tracked by
        // `inBlockComment`.
        if (inBlockComment) {
          const close = s.indexOf('*/');
          if (close === -1) {
            s = '';
          } else {
            s = s.slice(close + 2);
            inBlockComment = false;
          }
        }
        s = s.replace(/\/\*[\s\S]*?\*\//g, '');
        const openIdx = s.indexOf('/*');
        if (openIdx !== -1) {
          s = s.slice(0, openIdx);
          inBlockComment = true;
        }
        for (const ch of s) {
          if (ch === '{' || ch === '(' || ch === '[') depth++;
          else if (ch === '}' || ch === ')' || ch === ']') depth--;
        }
        if (depth === 0 && /;\s*$/.test(s)) {
          blockEnd = line;
          found = true;
          break;
        }
      }
      if (!found) {
        i++;
        continue;
      }
    }

    const body = lines.slice(blockStart, blockEnd + 1).join('\n');
    exports.set(name, { name, kind, body, sourceFile: filePath });
    i = blockEnd + 1;
  }

  return exports;
}

/**
 * TS built-ins / library globals that show up in declaration bodies but
 * never need to be in a slice. Keeping the list tight avoids
 * accidentally skipping real spec types (which all have AdCP-style
 * PascalCase names).
 */
const BUILTIN_IDENTIFIERS = new Set([
  // Global constructors / well-known objects.
  'Array',
  'Date',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Function',
  'Symbol',
  'JSON',
  'Math',
  'Buffer',
  'NodeJS',
  'URL',
  'URLSearchParams',
  // Iteration protocol + errors (any future codegen output that
  // references these should resolve to the lib.d.ts versions, not
  // get flagged as missing slice deps).
  'Iterable',
  'AsyncIterable',
  'Iterator',
  'IteratorResult',
  'AsyncIterator',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  // Utility types.
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Record',
  'Exclude',
  'Extract',
  'ReturnType',
  'Parameters',
  'NonNullable',
  'Awaited',
  'Uppercase',
  'Lowercase',
  'Capitalize',
  'Uncapitalize',
  // Single-letter generic placeholders that survive header parses.
  'I',
  'T',
  'K',
  'V',
  'U',
]);

/**
 * Strip JSDoc blocks (between `/**` and `* /`) and line comments
 * before scanning for identifiers, so prose words like "Bearer" or
 * "SHA256" don't get treated as type references.
 */
function stripComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments incl. JSDoc
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

/**
 * Walk the dependency closure of a seed set of type names, returning
 * the set of all transitively-referenced exports.
 */
function closure(allExports: Map<string, ExportInfo>, seeds: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (allExports.has(s)) queue.push(s);
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const info = allExports.get(name);
    if (!info) continue;

    const scannable = stripComments(info.body);
    const re = /\b([A-Z][A-Za-z0-9_]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(scannable)) !== null) {
      const ref = match[1];
      if (ref === name) continue;
      if (BUILTIN_IDENTIFIERS.has(ref)) continue;
      if (visited.has(ref)) continue;
      if (allExports.has(ref)) queue.push(ref);
    }
  }
  return visited;
}

/**
 * Discover the AdCP tool list from the source manifest. Tools are
 * camel-cased there but kebab-cased in the schema cache; the official
 * name is the snake_case form used in tool definitions.
 */
function loadToolList(): string[] {
  // tools.generated.ts has `// <tool_name> parameters` markers — that's
  // the most authoritative list, and it filters out v2.5 / experimental
  // tools that aren't in the current AdCP surface.
  const toolsGeneratedTs = path.join(REPO_ROOT, 'src', 'lib', 'types', 'tools.generated.ts');
  if (!existsSync(toolsGeneratedTs)) {
    throw new Error(`Cannot find ${toolsGeneratedTs}. Run \`npm run build:lib\` first.`);
  }
  const text = readFileSync(toolsGeneratedTs, 'utf8');
  const tools = new Set<string>();
  const re = /^\/\/ ([a-z][a-z0-9_]*) parameters$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tools.add(m[1]);
  }
  return [...tools].sort();
}

/**
 * For a given tool, emit a `.d.ts` slice containing every type the
 * tool's request and response reference transitively.
 */
function emitToolSlice(
  toolName: string,
  allExports: Map<string, ExportInfo>,
  diagnostics: { missing: Map<string, Set<string>>; emitted: Map<string, number> }
): void {
  const pascal = toolNameToPascal(toolName);
  // Seed set: the two canonical entry points plus the common variant
  // names. Anything that doesn't exist in `allExports` is silently
  // skipped — different tools have different sub-shapes.
  const candidateSeeds = [
    `${pascal}Request`,
    `${pascal}Response`,
    `${pascal}Success`,
    `${pascal}Error`,
    `${pascal}Submitted`,
  ];
  const seeds = candidateSeeds.filter(s => allExports.has(s));
  if (seeds.length === 0) {
    diagnostics.missing.set(toolName, new Set(candidateSeeds));
    return;
  }

  const slice = closure(allExports, seeds);
  // Stable order: seeds first (entry-point types adopters expect at
  // the top of the file), then alphabetical for the rest.
  const ordered = [...seeds.filter(n => slice.has(n)), ...[...slice].filter(n => !seeds.includes(n)).sort()];

  const header =
    `// AUTO-GENERATED — DO NOT EDIT.\n` +
    `// Per-tool .d.ts slice for \`${toolName}\`. Built from the published\n` +
    `// \`tools.generated.d.ts\` + \`core.generated.d.ts\` + \`enums.generated.d.ts\`\n` +
    `// by \`scripts/generate-per-tool-types.ts\`.\n` +
    `//\n` +
    `// Self-contained: imports nothing from the broader SDK. Adopters who\n` +
    `// import only this slice pay a fraction of the tsc cost of pulling in\n` +
    `// \`@adcp/sdk\` root — useful when strict + skipLibCheck:false adopters\n` +
    `// hit memory pressure on the full surface.\n` +
    `\n`;

  const body = ordered.map(n => allExports.get(n)!.body).join('\n\n') + '\n';

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${toolNameToKebab(toolName)}.d.ts`);
  writeFileSync(outPath, header + body);
  diagnostics.emitted.set(toolName, ordered.length);
}

/**
 * Emit a manifest listing every per-tool slice that shipped, so
 * agentic adopters (LLMs reading the SDK's `.d.ts` files as context)
 * can discover the surface without filesystem-walking
 * `node_modules/@adcp/sdk/dist/lib/types/`. The manifest also maps
 * the spec-canonical snake_case tool name to the kebab-case subpath
 * — LLMs trained on the spec will instinctively type `sync_accounts`,
 * not `sync-accounts`, so the manifest is what they reach for to
 * resolve the import.
 *
 * Manifest shape:
 * ```
 * {
 *   "version": "<ADCP_VERSION>",
 *   "tools": {
 *     "<snake_case>": {
 *       "subpath": "@adcp/sdk/types/<kebab>",
 *       "exports": ["FooRequest", "FooResponse", ...]
 *     }
 *   }
 * }
 * ```
 */
function emitToolIndex(allExports: Map<string, ExportInfo>, emitted: Map<string, number>): void {
  const adcpVersion = readFileSync(path.join(REPO_ROOT, 'ADCP_VERSION'), 'utf8').trim();
  type ToolEntry = { subpath: string; exports: string[] };
  const tools: Record<string, ToolEntry> = {};
  for (const toolName of emitted.keys()) {
    const pascal = toolNameToPascal(toolName);
    const kebab = toolNameToKebab(toolName);
    const candidates = [
      `${pascal}Request`,
      `${pascal}Response`,
      `${pascal}Success`,
      `${pascal}Error`,
      `${pascal}Submitted`,
    ];
    tools[toolName] = {
      subpath: `@adcp/sdk/types/${kebab}`,
      exports: candidates.filter(c => allExports.has(c)),
    };
  }
  const manifest = {
    $comment:
      'Index of per-tool .d.ts slices shipped under @adcp/sdk/types/<tool>. Agentic adopters use this to resolve spec snake_case tool names to the kebab-case subpath.',
    version: adcpVersion,
    tools,
  };
  writeFileSync(path.join(OUT_DIR, 'per-tool-index.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function main(): void {
  console.log('[per-tool-types] reading .d.ts sources...');
  const sources = [
    path.join(DIST_TYPES, 'tools.generated.d.ts'),
    path.join(DIST_TYPES, 'core.generated.d.ts'),
    path.join(DIST_TYPES, 'enums.generated.d.ts'),
  ];
  for (const f of sources) {
    if (!existsSync(f)) {
      console.error(`[per-tool-types] missing ${f} — run \`npm run build:lib\` first.`);
      process.exit(1);
    }
  }

  const allExports = new Map<string, ExportInfo>();
  for (const file of sources) {
    const parsed = parseExports(file);
    for (const [name, info] of parsed) {
      // Earlier files win — `tools.generated` is the canonical place
      // for tool request/response types; `core.generated` is the
      // canonical place for shared schemas. Conflicts shouldn't happen
      // (per-domain codegen output should be disjoint at the export-
      // name level), so log when they do — it's a drift signal worth
      // surfacing.
      const existing = allExports.get(name);
      if (existing) {
        // Compare stripped + trimmed bodies so that JSDoc-only divergence
        // (same type emitted from two JSON Schema sources with different
        // descriptions) does not produce a false-positive warning.
        // Structural type drift still triggers the warn.
        // TODO: root-cause fix — seed generateToolTypes with generatedCoreTypes
        // so shared schemas (PurchaseType, AudienceConstraints, …) are not
        // re-emitted in tools.generated.ts in the first place.
        // Tracked in adcp-client#1976.
        if (stripComments(existing.body).trim() !== stripComments(info.body).trim()) {
          console.warn(
            `[per-tool-types] export-name collision (different bodies): \`${name}\` defined ` +
              `in both ${path.relative(REPO_ROOT, existing.sourceFile)} and ` +
              `${path.relative(REPO_ROOT, info.sourceFile)} — keeping the earlier one`
          );
        }
        continue;
      }
      allExports.set(name, info);
    }
  }
  console.log(`[per-tool-types] parsed ${allExports.size} exports total`);

  const tools = loadToolList();
  console.log(`[per-tool-types] discovered ${tools.length} tools`);

  const diagnostics = {
    missing: new Map<string, Set<string>>(),
    emitted: new Map<string, number>(),
  };
  for (const tool of tools) {
    emitToolSlice(tool, allExports, diagnostics);
  }

  console.log(`[per-tool-types] emitted ${diagnostics.emitted.size}/${tools.length} slices`);
  if (diagnostics.emitted.size > 0) {
    const sliceCounts = [...diagnostics.emitted.entries()].map(([k, v]) => `${k}=${v}`);
    console.log(`[per-tool-types] slice symbol counts (sample): ${sliceCounts.slice(0, 5).join(', ')}...`);
  }
  if (diagnostics.missing.size > 0) {
    console.warn(
      `[per-tool-types] ${diagnostics.missing.size} tool(s) had no canonical entry-point types; skipped: ` +
        [...diagnostics.missing.keys()].join(', ')
    );
  }

  emitToolIndex(allExports, diagnostics.emitted);
  console.log(`[per-tool-types] wrote per-tool-index.json (${diagnostics.emitted.size} entries)`);

  // Also list what's in OUT_DIR for visibility.
  const out = readdirSync(OUT_DIR).filter(
    f =>
      f.endsWith('.d.ts') &&
      !f.startsWith('tools.') &&
      !f.startsWith('core.') &&
      !f.startsWith('enums.') &&
      !f.startsWith('manifest.') &&
      !f.startsWith('schemas.')
  );
  console.log(`[per-tool-types] OUT_DIR now contains ${out.length} per-tool slices`);
}

if (require.main === module) {
  main();
}

export const __test__ = { stripComments };
