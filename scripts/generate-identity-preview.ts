#!/usr/bin/env tsx
/**
 * Generate the experimental AdCP 3.3 identity preview from pinned draft
 * schemas, offline. The stable wire pin and the generated 3.2 type tree are
 * intentionally untouched.
 *
 * Inputs: `schemas/identity-preview/**` (byte-identical copies of upstream
 * draft schemas at the commits in `UPSTREAM.json`), plus the pinned 3.2.4
 * cache for stable dependencies. The two buyer onboarding slots in trust.json
 * are an explicit composition of independent P5/P6 drafts, matching
 * adcp-client-python#1502.
 *
 * Outputs (checked in):
 *   - src/lib/types/experimental-identity.generated.ts — TypeScript types.
 *   - src/lib/signing/trust/identity-schema-bundle.generated.ts — the
 *     composed bundle without annotations, for runtime validation.
 *
 *   npx tsx scripts/generate-identity-preview.ts            # write
 *   npx tsx scripts/generate-identity-preview.ts --check    # verify in sync
 *   npx tsx scripts/generate-identity-preview.ts --verify-upstream ../adcp
 *       # confirm each vendored source equals `git show <commit>:<path>`
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile } from 'json-schema-to-typescript';
import { format, resolveConfig } from 'prettier';
import { removeNumberedTypeDuplicates } from './generate-types';

const ROOT = path.join(__dirname, '..');
const PREVIEW = path.join(ROOT, 'schemas/identity-preview');
// Stable dependencies resolve against the SDK's pinned wire release.
const STABLE = path.join(ROOT, 'schemas/cache', readFileSync(path.join(ROOT, 'ADCP_VERSION'), 'utf8').trim());
const TYPES_OUT = path.join(ROOT, 'src/lib/types/experimental-identity.generated.ts');
const BUNDLE_OUT = path.join(ROOT, 'src/lib/signing/trust/identity-schema-bundle.generated.ts');
const ENTRIES = [
  'core/agent-onboarding.json',
  'core/buyer-onboarding-posture.json',
  'core/principal-relationship.json',
  'trust/v1/trust.json',
];
const ANNOTATIONS = new Set(['description', 'enumDescriptions', 'examples', 'title', '$comment', '$schema', 'default']);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function key(schemaPath: string): string {
  return schemaPath.replace(/\.json$/, '').replace(/[/-]/g, '_');
}

function buildBundle(): JsonObject {
  const definitions: JsonObject = {};
  const visited = new Set<string>();
  const load = (schemaPath: string): void => {
    if (visited.has(schemaPath)) return;
    visited.add(schemaPath);
    const preview = path.join(PREVIEW, schemaPath);
    const source = existsSync(preview) ? preview : path.join(STABLE, schemaPath);
    if (!existsSync(source)) throw new Error(`Missing schema ${schemaPath}; run npm run schemas:ensure`);
    const schema = JSON.parse(readFileSync(source, 'utf8')) as JsonObject;
    if (schemaPath === 'trust/v1/trust.json') {
      const defs = schema.definitions as JsonObject;
      const agentProfiles = (defs.agent as JsonObject).properties as JsonObject;
      for (const profiles of [agentProfiles.profiles as JsonObject, defs.record_profiles as JsonObject]) {
        const adcp = ((profiles.allOf as JsonObject[])[1]!.properties as JsonObject).adcp as JsonObject;
        (adcp.properties as JsonObject).onboarding = { $ref: '/schemas/core/buyer-onboarding-posture.json' };
      }
    }
    const walk = (value: Json): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== 'object') return;
      delete value.$id;
      const ref = value.$ref;
      if (typeof ref === 'string') {
        if (ref.startsWith('#')) {
          value.$ref = `#/definitions/${key(schemaPath)}${ref.slice(1)}`;
        } else {
          const [target, fragment] = ref.split('#') as [string, string | undefined];
          let relative = target.split('/schemas/')[1]!;
          if (relative.startsWith('v3/') || /^\d/.test(relative)) relative = relative.slice(relative.indexOf('/') + 1);
          load(relative);
          value.$ref = `#/definitions/${key(relative)}${fragment ? `/${fragment.replace(/^\//, '')}` : ''}`;
        }
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(schema);
    definitions[key(schemaPath)] = schema;
  };
  ENTRIES.forEach(load);
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'IdentityPreview',
    definitions,
    anyOf: ENTRIES.map(entry => ({ $ref: `#/definitions/${key(entry)}` })),
  };
}

/**
 * Runtime view: annotations removed, and `uniqueItems` removed because Ajv
 * checks it pairwise for items behind `$ref`/`anyOf` (quadratic on a 2 MiB
 * record). `validateTrustRecord` checks uniqueness of roles, protocols and
 * scopes with a Set instead.
 */
function stripAnnotations(value: Json, parentKey?: string): Json {
  if (Array.isArray(value)) return value.map(item => stripAnnotations(item));
  if (!value || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const [name, child] of Object.entries(value)) {
    // Under `properties` / `definitions`, keys are names, not keywords.
    const isNameMap = parentKey === 'properties' || parentKey === 'definitions' || parentKey === 'patternProperties';
    if (!isNameMap && (ANNOTATIONS.has(name) || name.startsWith('x-') || name === 'uniqueItems')) continue;
    out[name] = stripAnnotations(child, name);
  }
  return out;
}

/**
 * Stable AdCP 3.2 dependencies the preview references. Types reuse the SDK's
 * existing generated names instead of re-emitting them.
 */
const STABLE_TYPES: Record<string, string> = {
  core_brand_ref: 'BrandReference',
  core_ext: 'ExtensionObject',
  enums_billing_party: 'BillingParty',
  enums_right_use: 'RightUse',
  enums_right_type: 'RightType',
};

/**
 * Typing view: drop presence-only `anyOf` constraints and `not`, which
 * json-schema-to-typescript cannot represent and would collapse the trust
 * record to an index signature, and point stable dependencies at the SDK's
 * existing 3.2 types. Validation keeps the full bundle (the runtime output).
 */
function forTypes(value: Json): Json {
  if (Array.isArray(value)) return value.map(forTypes);
  if (!value || typeof value !== 'object') return value;
  const ref = value.$ref;
  if (typeof ref === 'string') {
    const target = /^#\/definitions\/([a-z0-9_]+)$/.exec(ref)?.[1];
    if (target && STABLE_TYPES[target]) {
      return {
        tsType: STABLE_TYPES[target],
        ...(typeof value.description === 'string' && { description: value.description }),
      };
    }
  }
  const out: JsonObject = {};
  for (const [name, child] of Object.entries(value)) {
    if (name === 'not') continue;
    if (
      name === 'anyOf' &&
      Array.isArray(child) &&
      child.every(member => !!member && typeof member === 'object' && Object.keys(member).join() === 'required')
    ) {
      continue;
    }
    out[name] = forTypes(child);
  }
  return out;
}

async function render(): Promise<{ types: string; bundle: string }> {
  const bundle = buildBundle();
  const upstream = JSON.parse(readFileSync(path.join(PREVIEW, 'UPSTREAM.json'), 'utf8')) as {
    sources: Record<string, { pr: number; commit: string }>;
  };
  const provenance = Object.entries(upstream.sources)
    .map(([file, source]) => ` *   ${file} — adcp#${source.pr} @ ${source.commit.slice(0, 12)}`)
    .join('\n');
  const header = `/* eslint-disable */
/**
 * EXPERIMENTAL — AdCP 3.3 agent identity preview types. Generated by
 * scripts/generate-identity-preview.ts from pinned draft schemas; do not edit.
 * These drafts may change before the 3.3 release and are independent of the
 * SDK's 3.2 wire pin. Import the curated names from
 * \`./experimental-identity\` instead of this file.
 *
 * Sources (schemas/identity-preview/UPSTREAM.json):
${provenance}
 */
`;
  const typing = forTypes(JSON.parse(JSON.stringify(bundle))) as JsonObject;
  // Definitions only stable dependencies reach (brand-ref's asset tree) are
  // replaced above; drop them so they are not re-emitted as types.
  const used = new Set<string>();
  const collect = (value: Json): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    const target = typeof value.$ref === 'string' ? /^#\/definitions\/([a-z0-9_]+)/.exec(value.$ref)?.[1] : undefined;
    if (target && !used.has(target)) {
      used.add(target);
      collect((typing.definitions as JsonObject)[target]!);
    }
    for (const child of Object.values(value)) collect(child);
  };
  collect(typing.anyOf!);
  typing.definitions = Object.fromEntries(
    Object.entries(typing.definitions as JsonObject).filter(([name]) => used.has(name))
  );
  const compiled = await compile(typing, 'IdentityPreview', {
    bannerComment: '',
    additionalProperties: false,
    strictIndexSignatures: true,
    unreachableDefinitions: true,
    declareExternallyReferenced: true,
    style: { semi: true, singleQuote: true },
  });
  const prettierConfig = (await resolveConfig(TYPES_OUT)) ?? {};
  const body = removeNumberedTypeDuplicates(compiled);
  // Import only the stable 3.2 types the generated declarations reference.
  const referenced = Object.values(STABLE_TYPES)
    .filter(name => new RegExp(`\\b${name}\\b`).test(body))
    .sort();
  const imports = referenced.length ? `import type { ${referenced.join(', ')} } from './core.generated';\n\n` : '';
  const types = await format(header + imports + body, {
    ...prettierConfig,
    parser: 'typescript',
    filepath: TYPES_OUT,
  });
  const bundleSource = `/* eslint-disable */
/**
 * EXPERIMENTAL — composed AdCP 3.3 identity preview schema bundle, without
 * annotations, for runtime validation. Generated by
 * scripts/generate-identity-preview.ts; do not edit.
 */
export const IDENTITY_PREVIEW_SCHEMA_BUNDLE: {
  readonly definitions: Readonly<Record<string, Record<string, unknown>>>;
  readonly [keyword: string]: unknown;
} = ${JSON.stringify(stripAnnotations(bundle))};
`;
  const bundleFormatted = await format(bundleSource, { ...prettierConfig, parser: 'typescript', filepath: BUNDLE_OUT });
  return { types, bundle: bundleFormatted };
}

function verifyUpstream(repo: string): void {
  const upstream = JSON.parse(readFileSync(path.join(PREVIEW, 'UPSTREAM.json'), 'utf8')) as {
    sources: Record<string, { commit: string }>;
  };
  for (const [file, source] of Object.entries(upstream.sources)) {
    const remote = execFileSync('git', ['-C', repo, 'show', `${source.commit}:static/schemas/source/${file}`]);
    const local = readFileSync(path.join(PREVIEW, file));
    if (!remote.equals(local)) throw new Error(`${file} differs from ${source.commit}`);
  }
  console.log(`Verified ${Object.keys(upstream.sources).length} vendored schemas against ${repo}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const upstreamIndex = args.indexOf('--verify-upstream');
  if (upstreamIndex >= 0) {
    verifyUpstream(args[upstreamIndex + 1] ?? '../adcp');
    return;
  }
  const { types, bundle } = await render();
  if (args.includes('--check')) {
    const stale = [
      [TYPES_OUT, types],
      [BUNDLE_OUT, bundle],
    ].filter(([file, content]) => !existsSync(file!) || readFileSync(file!, 'utf8') !== content);
    if (stale.length > 0) {
      console.error(`Identity preview outputs are stale: ${stale.map(([f]) => path.relative(ROOT, f!)).join(', ')}`);
      console.error('Run: npx tsx scripts/generate-identity-preview.ts');
      process.exit(1);
    }
    console.log('Identity preview outputs are in sync');
    return;
  }
  writeFileSync(TYPES_OUT, types);
  writeFileSync(BUNDLE_OUT, bundle);
  console.log(`Wrote ${path.relative(ROOT, TYPES_OUT)} and ${path.relative(ROOT, BUNDLE_OUT)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
