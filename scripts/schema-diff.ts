#!/usr/bin/env tsx
/**
 * Wire-level JSON-schema diff between two snapshots of schemas/cache/.
 *
 * Usage:
 *   npm run schema-diff                      # previous sync vs current (schemas/cache/latest.previous/ → latest/)
 *   npm run schema-diff -- <dirA> <dirB>     # compare two schema-cache directories
 *
 * Output groups findings by the wire-level change they represent, so a reader can
 * judge interop risk without reading 700 lines of generated TS:
 *   - renamed fields (object lost prop A, gained prop B with equal subschema)
 *   - new/removed properties
 *   - required-set changes
 *   - additionalProperties flips
 *   - oneOf arm count / const discriminator changes
 *   - enum additions/removals
 *   - new/removed schema files
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_LIVE = path.join(REPO_ROOT, 'schemas/cache/latest');

// `schemas/cache/latest` is a symlink to the real versioned directory when
// `ADCP_VERSION` is pinned (e.g. `3.0.0`) — sync-schemas writes the snapshot
// next to the real dir (`schemas/cache/3.0.0.previous`), not next to the
// symlink. Follow the symlink so the default before/after pair is correct
// whether `ADCP_VERSION` is pinned or `latest`.
function resolveDefaultPrev(): string {
  try {
    const real = realpathSync(DEFAULT_LIVE);
    return `${real}.previous`;
  } catch {
    return `${DEFAULT_LIVE}.previous`;
  }
}

interface Finding {
  path: string;
  pointer: string;
  kind:
    | 'file-added'
    | 'file-removed'
    | 'field-renamed'
    | 'field-added'
    | 'field-removed'
    | 'required-added'
    | 'required-removed'
    | 'additional-props-tightened'
    | 'additional-props-loosened'
    | 'const-changed'
    | 'enum-added'
    | 'enum-removed'
    | 'type-changed'
    | 'oneof-arms-changed';
  detail: string;
}

function main(): void {
  const args = process.argv.slice(2);
  let fromDir: string;
  let toDir: string;
  let fromLabel: string;
  let toLabel: string;

  if (args.length === 0) {
    const defaultPrev = resolveDefaultPrev();
    if (!isDir(defaultPrev)) {
      fatal(
        `No previous-sync snapshot found at ${defaultPrev}. ` +
          `Run \`npm run sync-schemas\` to produce one on the next sync, ` +
          `or pass two directories explicitly: \`npm run schema-diff -- <from> <to>\`.`
      );
    }
    fromDir = defaultPrev;
    toDir = DEFAULT_LIVE;
    fromLabel = path.relative(REPO_ROOT, defaultPrev);
    toLabel = 'schemas/cache/latest';
  } else if (args.length === 2) {
    fromDir = path.resolve(args[0]);
    toDir = path.resolve(args[1]);
    fromLabel = args[0];
    toLabel = args[1];
  } else {
    fatal('Expected 0 args (previous-sync vs current) or 2 args (two directories).');
  }

  if (!isDir(fromDir)) fatal(`Not a directory: ${fromDir}`);
  if (!isDir(toDir)) fatal(`Not a directory: ${toDir}`);

  const findings: Finding[] = [];
  const fromFiles = new Map(listJsonFiles(fromDir).map(f => [f, path.join(fromDir, f)]));
  const toFiles = new Map(listJsonFiles(toDir).map(f => [f, path.join(toDir, f)]));

  if (fromFiles.size === 0 && toFiles.size === 0) {
    fatal(`Both directories contain no .json files — wrong paths?\n  from: ${fromDir}\n  to:   ${toDir}`);
  }

  for (const [rel, absFrom] of fromFiles) {
    if (!toFiles.has(rel)) {
      findings.push({ path: rel, pointer: '', kind: 'file-removed', detail: 'schema removed' });
      continue;
    }
    const absTo = toFiles.get(rel)!;
    diffSchema(rel, '', readJson(absFrom), readJson(absTo), findings);
  }
  for (const [rel] of toFiles) {
    if (!fromFiles.has(rel)) {
      findings.push({ path: rel, pointer: '', kind: 'file-added', detail: 'schema added' });
    }
  }

  printReport(fromLabel, toLabel, fromDir, toDir, findings);
}

function readAdcpVersion(dir: string): string | undefined {
  try {
    const raw = readFileSync(path.join(dir, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.adcp_version === 'string') return parsed.adcp_version;
  } catch {
    // index.json missing or malformed — schema trees without it still diff fine.
  }
  return undefined;
}

function fatal(msg: string): never {
  console.error(`schema-diff: ${msg}`);
  process.exit(2);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listJsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

function readJson(abs: string): any {
  return JSON.parse(readFileSync(abs, 'utf8'));
}

/**
 * Walk two schemas in parallel, emitting wire-level findings. Only surfaces changes
 * that affect JSON payloads on the wire — ignores descriptions, titles, $id, examples.
 */
function diffSchema(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  if (!isObject(a) || !isObject(b)) return;

  diffProperties(file, pointer, a, b, out);
  diffRequired(file, pointer, a, b, out);
  diffAdditionalProperties(file, pointer, a, b, out);
  diffConst(file, pointer, a, b, out);
  diffEnum(file, pointer, a, b, out);
  diffType(file, pointer, a, b, out);
  diffCombinator(file, pointer, a, b, 'oneOf', out);
  diffCombinator(file, pointer, a, b, 'anyOf', out);
  diffCombinator(file, pointer, a, b, 'allOf', out);

  // Recurse into nested subschemas that can appear on the wire.
  if (isObject(a.items) && isObject(b.items)) {
    diffSchema(file, `${pointer}/items`, a.items, b.items, out);
  }
}

function diffProperties(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  const ap = isObject(a.properties) ? a.properties : null;
  const bp = isObject(b.properties) ? b.properties : null;
  if (!ap && !bp) return;

  const aKeys = new Set(ap ? Object.keys(ap) : []);
  const bKeys = new Set(bp ? Object.keys(bp) : []);
  const removed = [...aKeys].filter(k => !bKeys.has(k));
  const added = [...bKeys].filter(k => !aKeys.has(k));

  // Rename heuristic: removed prop matches an added prop by deep-equal subschema (ignoring description).
  const matchedRemovals = new Set<string>();
  const matchedAdds = new Set<string>();
  for (const r of removed) {
    for (const ad of added) {
      if (matchedAdds.has(ad)) continue;
      if (!schemasEquivalent(ap![r], bp![ad])) continue;
      // Guard against false-positive pairings on the most common trivial shape
      // (bare `{"type":"string"}` props). Only pair when the shared subschema
      // carries a discriminator or is structurally distinctive.
      if (!isDistinctiveSubschema(ap![r])) continue;
      out.push({
        path: file,
        pointer: `${pointer}/properties`,
        kind: 'field-renamed',
        detail: `${r} → ${ad}`,
      });
      matchedRemovals.add(r);
      matchedAdds.add(ad);
      break;
    }
  }
  for (const r of removed)
    if (!matchedRemovals.has(r))
      out.push({
        path: file,
        pointer: `${pointer}/properties/${r}`,
        kind: 'field-removed',
        detail: `removed property ${r}`,
      });
  for (const ad of added)
    if (!matchedAdds.has(ad))
      out.push({
        path: file,
        pointer: `${pointer}/properties/${ad}`,
        kind: 'field-added',
        detail: `new property ${ad}`,
      });

  // Recurse into shared properties.
  for (const k of aKeys) {
    if (bKeys.has(k)) diffSchema(file, `${pointer}/properties/${k}`, ap![k], bp![k], out);
  }
}

function diffRequired(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  const ar = new Set<string>(Array.isArray(a.required) ? a.required : []);
  const br = new Set<string>(Array.isArray(b.required) ? b.required : []);
  if (ar.size === 0 && br.size === 0) return;
  for (const k of br)
    if (!ar.has(k))
      out.push({
        path: file,
        pointer,
        kind: 'required-added',
        detail: `${k} is now required`,
      });
  for (const k of ar)
    if (!br.has(k))
      out.push({
        path: file,
        pointer,
        kind: 'required-removed',
        detail: `${k} is no longer required`,
      });
}

function diffAdditionalProperties(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  const av = normalizeAdditionalProps(a.additionalProperties);
  const bv = normalizeAdditionalProps(b.additionalProperties);
  if (av === bv) return;
  if (av && !bv)
    out.push({
      path: file,
      pointer,
      kind: 'additional-props-tightened',
      detail: 'additionalProperties: true → false (unknown fields now rejected)',
    });
  else if (!av && bv)
    out.push({
      path: file,
      pointer,
      kind: 'additional-props-loosened',
      detail: 'additionalProperties: false → true (unknown fields now allowed)',
    });
}

function normalizeAdditionalProps(v: unknown): boolean {
  if (v === false) return false;
  return true; // absent, true, or subschema — all permit unknown fields
}

function diffConst(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  if ('const' in a || 'const' in b) {
    if (a.const !== b.const) {
      out.push({
        path: file,
        pointer,
        kind: 'const-changed',
        detail: `const: ${JSON.stringify(a.const)} → ${JSON.stringify(b.const)}`,
      });
    }
  }
}

function diffEnum(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  const ae = Array.isArray(a.enum) ? new Set(a.enum) : null;
  const be = Array.isArray(b.enum) ? new Set(b.enum) : null;
  if (!ae && !be) return;
  if (ae && !be) {
    out.push({
      path: file,
      pointer,
      kind: 'enum-removed',
      detail: `enum constraint removed (was ${JSON.stringify([...ae])})`,
    });
    return;
  }
  if (!ae && be) {
    out.push({
      path: file,
      pointer,
      kind: 'enum-added',
      detail: `enum constraint added (${JSON.stringify([...be])})`,
    });
    return;
  }
  for (const v of be!)
    if (!ae!.has(v)) out.push({ path: file, pointer, kind: 'enum-added', detail: `value ${JSON.stringify(v)}` });
  for (const v of ae!)
    if (!be!.has(v)) out.push({ path: file, pointer, kind: 'enum-removed', detail: `value ${JSON.stringify(v)}` });
}

function diffType(file: string, pointer: string, a: any, b: any, out: Finding[]): void {
  if (a.type === undefined && b.type === undefined) return;
  const at = JSON.stringify(a.type);
  const bt = JSON.stringify(b.type);
  if (at !== bt)
    out.push({
      path: file,
      pointer,
      kind: 'type-changed',
      detail: `type: ${at} → ${bt}`,
    });
}

function diffCombinator(
  file: string,
  pointer: string,
  a: any,
  b: any,
  keyword: 'oneOf' | 'anyOf' | 'allOf',
  out: Finding[]
): void {
  const aa = Array.isArray(a[keyword]) ? a[keyword] : null;
  const bb = Array.isArray(b[keyword]) ? b[keyword] : null;
  if (!aa && !bb) return;
  const aLen = aa?.length ?? 0;
  const bLen = bb?.length ?? 0;
  if (aLen !== bLen) {
    out.push({
      path: file,
      pointer,
      kind: 'oneof-arms-changed',
      detail: `${keyword} arms: ${aLen} → ${bLen}`,
    });
  }
  // Recurse into matched arms by position (rough but good enough for wire-level signal).
  const shared = Math.min(aLen, bLen);
  for (let i = 0; i < shared; i++) {
    diffSchema(file, `${pointer}/${keyword}/${i}`, aa![i], bb![i], out);
  }
}

/**
 * True if two subschemas would accept the same JSON payloads (ignoring documentation).
 * Used only for rename detection, so we compare a conservative projection of keys.
 */
function schemasEquivalent(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * A subschema is "distinctive" enough to drive a rename match if it carries a
 * discriminator (`enum`/`const`/`format`/`pattern`/`$ref`), has nested
 * structure (`properties`/`items`/`oneOf`/`anyOf`/`allOf`), or sets at least
 * three non-documentation keys. Prevents false pairings on the trivial
 * `{"type":"string"}` shape that's common across unrelated string fields.
 */
function isDistinctiveSubschema(v: unknown): boolean {
  if (!isObject(v)) return false;
  const keys = Object.keys(v).filter(k => !COMPARE_IGNORE.has(k));
  if (keys.length >= 3) return true;
  return keys.some(k =>
    ['enum', 'const', 'format', 'pattern', '$ref', 'properties', 'items', 'oneOf', 'anyOf', 'allOf'].includes(k)
  );
}

const COMPARE_IGNORE = new Set(['description', 'title', 'examples', '$comment', 'x-accessibility']);

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>)
    .filter(k => !COMPARE_IGNORE.has(k))
    .sort();
  return `{${keys.map(k => `${k}:${canonicalize((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function printReport(fromLabel: string, toLabel: string, fromDir: string, toDir: string, findings: Finding[]): void {
  const fromVersion = readAdcpVersion(fromDir);
  const toVersion = readAdcpVersion(toDir);
  const fromVer = fromVersion ? ` (adcp_version: ${fromVersion})` : '';
  const toVer = toVersion ? ` (adcp_version: ${toVersion})` : '';

  console.log(`# Schema wire-diff`);
  console.log(``);
  console.log(`- **from**: \`${fromLabel}\`${fromVer}`);
  console.log(`- **to**: \`${toLabel}\`${toVer}`);
  console.log(``);

  if (findings.length === 0) {
    console.log('No wire-level changes.');
    return;
  }

  const groups: Record<Finding['kind'], string> = {
    'field-renamed': 'Renamed fields (heuristic: same subschema under a new name)',
    'required-added': 'Newly required fields (potential wire breaker for old clients)',
    'additional-props-tightened': 'additionalProperties tightened (unknown fields now rejected)',
    'field-removed': 'Removed fields',
    'enum-removed': 'Removed enum values',
    'const-changed': 'Changed const discriminators',
    'type-changed': 'Changed JSON types',
    'oneof-arms-changed': 'Changed oneOf arm count (discriminated-union shape)',
    'required-removed': 'Fields no longer required (backward-compatible loosening)',
    'additional-props-loosened': 'additionalProperties loosened',
    'field-added': 'New fields (optional unless listed in required-added)',
    'enum-added': 'Added enum values',
    'file-added': 'New schema files',
    'file-removed': 'Removed schema files',
  };

  const byKind = new Map<Finding['kind'], Finding[]>();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind)!.push(f);
  }
  for (const kind of Object.keys(groups) as Finding['kind'][]) {
    const items = byKind.get(kind);
    if (!items?.length) continue;
    console.log(`## ${groups[kind]} (${items.length})`);
    console.log(``);
    items.sort((x, y) => x.path.localeCompare(y.path) || x.pointer.localeCompare(y.pointer));
    for (const f of items) {
      const loc = f.pointer ? `${f.path}${f.pointer}` : f.path;
      console.log(`- \`${loc}\` — ${f.detail}`);
    }
    console.log(``);
  }

  const breakerKinds: Finding['kind'][] = [
    'field-renamed',
    'field-removed',
    'required-added',
    'additional-props-tightened',
    'const-changed',
    'type-changed',
    'enum-removed',
    'oneof-arms-changed',
    'file-removed',
  ];
  const breakerCount = findings.filter(f => breakerKinds.includes(f.kind)).length;
  console.log(`_Summary: ${findings.length} wire-level changes, ${breakerCount} potentially breaking._`);
}

main();
