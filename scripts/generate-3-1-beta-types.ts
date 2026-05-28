#!/usr/bin/env tsx
/**
 * Generate TypeScript request/response interfaces from the cached AdCP
 * 3.1.0-beta.7 schema bundle. Output: `src/lib/types/v3-1-beta/tools.generated.ts`.
 *
 * The SDK's primary type surface (`src/lib/types/tools.generated.ts`) is
 * pinned to the GA `ADCP_VERSION` (3.0.x). The v3-1-beta surface is an
 * opt-in parallel tree consumers import explicitly to type the wholesale-feed
 * sync additions (`if_wholesale_feed_version`, `wholesale_feed_version`,
 * `cache_scope`, `unchanged`, `wholesale_feed_webhooks`,
 * `core/wholesale-feed-event.json`, `core/wholesale-feed-webhook.json`).
 *
 * Mirrors the v2.5 pipeline: one mega-schema compile, strip-if-then-else
 * before `json-schema-to-typescript` (Ajv enforces conditionals at runtime),
 * dedupe numbered duplicates (`Foo` / `Foo1` from re-referenced enums).
 *
 * Refresh by running:
 *   npm run sync-schemas:3.1-beta
 *   npm run generate-types:3.1-beta
 *
 * CI's "validate generated files in sync" gate runs both, so a forgotten
 * regeneration after a schema refresh fails the build before it ships.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { compile } from 'json-schema-to-typescript';
import { removeArrayLengthConstraints } from './schema-utils';
import {
  applyCodegenSchemaWorkarounds,
  enforceStrictSchema,
  promoteConditionalParamProperties,
  removeNumberedTypeDuplicates,
} from './generate-types';

const REPO_ROOT = path.join(__dirname, '..');
const BETA_VERSION = '3.1.0-beta.7';
const BETA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache', BETA_VERSION);
const OUTPUT_DIR = path.join(REPO_ROOT, 'src/lib/types/v3-1-beta');
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
 * Resolve a schema $ref to a path in the cached beta bundle. The bundle ships
 * with refs already normalized to `/schemas/${BETA_VERSION}/...`; this just
 * strips the leading version segment so the relative path resolves against
 * the cache root.
 */
function refToCachePath(ref: string): string {
  let rel = ref;
  if (rel.startsWith('/schemas/')) {
    rel = rel.slice('/schemas/'.length);
    const firstSlash = rel.indexOf('/');
    if (firstSlash > 0) {
      const head = rel.slice(0, firstSlash);
      if (/^v\d+(\.\d+)?$/.test(head) || /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/.test(head)) {
        rel = rel.slice(firstSlash + 1);
      }
    }
  }
  return path.join(BETA_CACHE_DIR, rel);
}

function loadSchema(ref: string): any {
  const filePath = refToCachePath(ref);
  if (!existsSync(filePath)) {
    throw new Error(`3.1-beta schema not found at ${filePath} (ref: ${ref})`);
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
  const indexPath = path.join(BETA_CACHE_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(
      `3.1-beta schema cache missing at ${BETA_CACHE_DIR}. Run \`npm run sync-schemas:3.1-beta\` to populate.`
    );
  }
  const index: SchemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (!index.adcp_version.startsWith('3.1.')) {
    throw new Error(`3.1-beta cache reports adcp_version=${index.adcp_version} — expected 3.1.x.`);
  }
  console.log(`📥 3.1-beta cache: ${index.adcp_version}`);

  const tools: ToolDef[] = [];
  const seen = new Set<string>();
  for (const [protocol, info] of Object.entries(index.schemas ?? {})) {
    if (!info?.tasks) continue;
    for (const [taskName, taskRefs] of Object.entries(info.tasks)) {
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

const refResolver = {
  canRead: true,
  read: (file: { url: string }) => {
    const url = file.url;
    if (!url.startsWith('/schemas/')) {
      return Promise.reject(new Error(`Cannot resolve non-spec $ref: ${url}`));
    }
    try {
      return Promise.resolve(stripIfThenElse(enforceStrictSchema(removeArrayLengthConstraints(loadSchema(url)))));
    } catch (err) {
      return Promise.reject(err);
    }
  },
};

/**
 * Rewrite intra-schema `$ref` paths (`#/oneOf/...`, `#/definitions/...`,
 * `#/properties/...`) so they resolve correctly inside the mega-schema
 * wrapper. When a schema is packaged at `mega.definitions[<Name>]`, its
 * original `#` points at the mega-schema root — not its own root — so
 * `#/definitions/claim_entry` resolves to the mega's definitions (which
 * don't have a `claim_entry`) instead of the schema's local ones.
 *
 * Prefix every intra-schema ref with `#/definitions/<Name>` so resolution
 * lands back inside the tool's bundled subtree. Idempotent on refs that
 * already start with `#/definitions/<Name>/`.
 */
function reseatLocalRefs(node: unknown, wrapperName: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) reseatLocalRefs(item, wrapperName);
    return;
  }
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === 'string' && ref.startsWith('#') && !ref.startsWith('/')) {
    if (ref === '#') {
      obj.$ref = `#/definitions/${wrapperName}`;
    } else if (ref.startsWith('#/')) {
      const tail = ref.slice(2);
      const alreadyReseated = tail.startsWith(`definitions/${wrapperName}/`);
      if (!alreadyReseated) {
        obj.$ref = `#/definitions/${wrapperName}/${tail}`;
      }
    }
  }
  for (const key of Object.keys(obj)) {
    reseatLocalRefs(obj[key], wrapperName);
  }
}

/**
 * Promote root-level `required` field names into every `oneOf` branch.
 *
 * Discriminated-union schemas (notably `core/catalog-event.json`) declare
 * fields like `payload` as root-required but list only the discriminator
 * (`event_type`) in each branch's local `required`. `json-schema-to-typescript`
 * treats each branch independently and emits the field as optional in the
 * branch type. When the wrapper is intersected with the branch union, TS
 * gives `payload: {}` (root-required) intersected with `payload?: BranchShape`
 * (branch-optional) → `payload: {}` — the load-bearing branch-specific shape
 * is lost.
 *
 * Promoting root-required into branch-required makes each branch emit the
 * field non-optional, so the intersection narrows to the branch shape and
 * discriminated-union safety survives codegen.
 *
 * Idempotent: a field already in a branch's required[] stays put. Applied
 * recursively so nested oneOf/$defs (e.g., `$defs/appliesTo`) carry the
 * same property.
 */
function propagateRootRequiredIntoOneOfBranches(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) propagateRootRequiredIntoOneOfBranches(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.oneOf) && Array.isArray(obj.required)) {
    const rootRequired = obj.required as string[];
    for (const branch of obj.oneOf) {
      if (branch === null || typeof branch !== 'object') continue;
      const b = branch as Record<string, unknown>;
      const existing = Array.isArray(b.required) ? (b.required as string[]) : [];
      const merged = Array.from(new Set([...existing, ...rootRequired]));
      b.required = merged;
    }
  }
  for (const key of Object.keys(obj)) {
    propagateRootRequiredIntoOneOfBranches(obj[key]);
  }
}

/**
 * Strip `if`/`then`/`else` conditional gates before handing schemas to
 * `json-schema-to-typescript`. The codegen's conditional support produces
 * unusable union expansions for the gates that AdCP 3.1 introduces
 * (`unchanged: true ⇒ products omitted`, `discovery_mode: 'wholesale' ⇒
 * signal_spec/signal_ids banned`). Ajv enforces the conditionals at runtime;
 * the generated TypeScript surface collapses to all-optional, which is the
 * least-surprise shape for callers who would otherwise face
 * `Type 'Foo' is missing the following properties from type 'Bar': ...`
 * cascades.
 *
 * Documented in memory feedback_strip_if_then_before_jsts — same workaround
 * the rest of the SDK applies. Mutates in place and returns the same node.
 */
function stripIfThenElse<T>(node: T): T {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripIfThenElse(item);
    return node;
  }
  const obj = node as Record<string, unknown>;
  promoteConditionalParamProperties(obj);
  delete obj.if;
  delete obj.then;
  delete obj.else;
  // `dependencies` (draft-07 key-dependency form) gates one field's presence
  // on another's; jsts emits it as an intersection that breaks for the
  // `if_pricing_version requires if_wholesale_feed_version` rule. Ajv enforces it.
  delete obj.dependencies;
  for (const key of Object.keys(obj)) {
    stripIfThenElse(obj[key]);
  }
  return node;
}

/**
 * Load standalone JSON schemas under `core/` so wholesale-feed webhook payloads
 * and their event union are reachable as standalone exports
 * even though no task points at them via `index.schemas[*].tasks`.
 */
function loadStandaloneCoreSchemas(): Array<{ name: string; schema: any }> {
  const out: Array<{ name: string; schema: any }> = [];
  const coreDir = path.join(BETA_CACHE_DIR, 'core');
  if (!existsSync(coreDir)) return out;
  // Wholesale-feed event/webhook schemas are not reachable via the tasks
  // index. Hand-pick them so the parallel type surface includes
  // `WholesaleFeedEvent` / `WholesaleFeedWebhook` without inflating the
  // codegen output with every `core/` primitive.
  const targets = ['wholesale-feed-event.json', 'wholesale-feed-webhook.json'];
  for (const file of targets) {
    const full = path.join(coreDir, file);
    if (!existsSync(full)) continue;
    const schema = JSON.parse(readFileSync(full, 'utf8'));
    const base = path.basename(file, '.json');
    const name = base
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    out.push({ name, schema });
  }
  return out;
}

/**
 * Widen `[k: string]: T;` index signatures to `[k: string]: T | undefined;`
 * when the surrounding object literal also declares optional named properties
 * of type `T`. TypeScript flags `audience_size?: ForecastRange` colliding
 * with `[k: string]: ForecastRange` (TS2411) because the optional property
 * could be `undefined` but the index signature can't.
 *
 * `json-schema-to-typescript`'s `strictIndexSignatures` option handles this
 * for top-level emitted interfaces but not for inline anonymous objects
 * (e.g., `ForecastPoint.metrics: { ... [k: string]: ForecastRange }`).
 * Post-process the generated output as a workaround.
 *
 * The transform is conservative: only widens lines matching
 * `<indent>[k: string]: <TypeName>;` (anchored to the index-signature shape).
 * Doesn't touch comments, string literals, or other generated constructs.
 */
function widenIndexSignaturesOnAnonymousObjects(src: string): string {
  // The TS2411 collision only fires when the same line block already has
  // `?: <TypeName>` declarations of the SAME type as the index signature.
  // Rather than parse, just widen every concrete-typed `[k: string]: T;`
  // — semantically these are already optional-by-iteration (a key may not
  // be present), so the widening is a faithful representation. Don't touch
  // `[k: string]: unknown;` or `[k: string]: any;` — those are already
  // permissive enough.
  return src.replace(/(\[k: string\]:\s+)([A-Z][\w.]*(?:\[\])?);/g, '$1$2 | undefined;');
}

/**
 * `json-schema-to-typescript` collapses the `sync_accounts.accounts[]` oneOf
 * mode arms to `{ [k: string]: unknown | undefined }` because the beta schema
 * uses conditional constraints to distinguish provisioning vs settings-update
 * mode. AJV still enforces those conditionals at runtime; this restores the
 * opt-in TS surface so beta adopters can type account notification updates.
 */
function tightenSyncAccountsModeTypes(src: string): string {
  const provisioning = `export interface ProvisioningMode {
  brand: BrandReference;
  operator: string;
  billing: BillingParty;
  account?: never;
  billing_entity?: BusinessEntity;
  payment_terms?: PaymentTerms;
  sandbox?: boolean;
  preferred_reporting_protocol?: CloudStorageProtocol;
  notification_configs?: NotificationConfig[];
  ext?: ExtensionObject;
}`;
  const settingsUpdate = `export interface SettingsUpdateMode {
  account: AccountReference;
  brand?: never;
  operator?: never;
  billing?: never;
  billing_entity?: BusinessEntity;
  payment_terms?: PaymentTerms;
  notification_configs?: NotificationConfig[];
  ext?: ExtensionObject;
}`;

  let replacements = 0;
  let next = src.replace(/export interface ProvisioningMode \{\n\s+\[k: string\]: unknown \| undefined;\n\}/, () => {
    replacements += 1;
    return provisioning;
  });
  next = next.replace(/export interface SettingsUpdateMode \{\n\s+\[k: string\]: unknown \| undefined;\n\}/, () => {
    replacements += 1;
    return settingsUpdate;
  });
  if (replacements === 0) {
    return next;
  }
  if (replacements !== 2) {
    throw new Error(`Expected to rewrite sync_accounts mode interfaces exactly twice, rewrote ${replacements} times.`);
  }
  return next;
}

async function main(): Promise<void> {
  console.log('🔧 Generating AdCP 3.1-beta TypeScript types...');
  const tools = loadTools();
  const standalone = loadStandaloneCoreSchemas();
  console.log(`📦 ${tools.length} tools + ${standalone.length} standalone schemas to compile`);

  const definitions: Record<string, any> = {};
  const properties: Record<string, any> = {};
  const pack = (name: string, raw: any): void => {
    const prepped = stripIfThenElse(
      enforceStrictSchema(removeArrayLengthConstraints(applyCodegenSchemaWorkarounds(raw, name)))
    );
    propagateRootRequiredIntoOneOfBranches(prepped);
    reseatLocalRefs(prepped, name);
    definitions[name] = prepped;
    properties[name] = { $ref: `#/definitions/${name}` };
  };
  for (const tool of tools) {
    if (tool.request) pack(`${tool.typeBaseName}Request`, tool.request);
    if (tool.response) pack(`${tool.typeBaseName}Response`, tool.response);
  }
  for (const { name, schema } of standalone) pack(name, schema);

  const megaSchema = {
    title: 'AdCPV31BetaTools',
    type: 'object',
    properties,
    additionalProperties: false,
    definitions,
  };

  console.log(`🔧 Compiling as one mega-schema (${Object.keys(definitions).length} definitions)...`);
  const compiled = await compile(megaSchema, 'AdCPV31BetaTools', {
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

  // Drop the wrapper interface — implementation detail of the codegen.
  const wrapperPattern = /export interface AdCPV31BetaTools \{[\s\S]*?\n\}\n*/;
  let body = compiled.replace(wrapperPattern, '').trim();
  body = removeNumberedTypeDuplicates(body);
  body = widenIndexSignaturesOnAnonymousObjects(body);
  body = tightenSyncAccountsModeTypes(body);

  const banner = `// AdCP ${BETA_VERSION} tool request/response types — DO NOT EDIT
// Generated from schemas/cache/${BETA_VERSION}/ via scripts/generate-3-1-beta-types.ts
// Refresh with: npm run sync-schemas:3.1-beta && npm run generate-types:3.1-beta
`;
  const output = `${banner}\n${body}\n`;

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

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
