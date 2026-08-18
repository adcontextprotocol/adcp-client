#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import path from 'path';
import { injectJsdocConstraints, removeArrayLengthConstraints } from './schema-utils';
import { resolveSchemaRefInCache, schemaRefToCacheRelativePath } from './schema-cache-ref';

// Write file only if content differs (excluding timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  // Extract content without timestamp for comparison
  const contentWithoutTimestamp = (content: string) => {
    return content.replace(/\/\/ Generated at: .*?\n/, '// Generated at: [TIMESTAMP]\n');
  };

  let hasChanged = true;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf8');
    const existingWithoutTimestamp = contentWithoutTimestamp(existingContent);
    const newWithoutTimestamp = contentWithoutTimestamp(newContent);

    if (existingWithoutTimestamp === newWithoutTimestamp) {
      hasChanged = false;
    }
  }

  if (hasChanged) {
    writeFileSync(filePath, newContent);
  }

  return hasChanged;
}

// Schema cache configuration
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const LATEST_CACHE_DIR = path.join(SCHEMA_CACHE_DIR, 'latest');

// Core AdCP schemas to generate
const ADCP_CORE_SCHEMAS = ['media-buy', 'creative-asset', 'product', 'targeting', 'property', 'mcp-webhook-payload'];

// Additional standalone schemas (not in core/ directory)
// NOTE: 'adagents' commented out due to duplicate PropertyIdentifierTypes causing TS errors
// The adagents schema re-declares types that are already in property schema
const STANDALONE_SCHEMAS: string[] = []; // ['adagents']

// Compile these canonical documents before broad aggregate roots. In a large
// root, json-schema-to-typescript can emit the first occurrence of a shared
// type from a validation-only overlay (allOf/anyOf) and permanently keep that
// weakened occurrence during deduplication. The standalone documents are the
// authoritative public shapes and must win first-definition ownership.
const PRIORITY_CANONICAL_SCHEMAS = [
  // Explicit extension bags intentionally keep their index signature. Compile
  // the canonical map before any named open object that happens to reference
  // it so first-definition deduplication cannot replace it with a closed
  // structural interface.
  'core/ext.json',
  // Compile this source-compatibility-sensitive named interface directly.
  // When first reached transitively through a large aggregate, jsts can
  // retain the wire schema's open-object signatures on CreativeBrief and its
  // nested named fields before the strict resolver gets to normalize them.
  'core/creative-brief.json',
  // Compile direct constraint-bearing roots before forecast/tool schemas that
  // reference them. json-schema-to-typescript does not reliably preserve
  // injected @pattern tags when the first declaration originates through a
  // transitive $ref.
  'core/brand-ref.json',
  'core/business-entity.json',
  'core/platform-extension-ref.json',
  'core/delivery-metrics.json',
  'core/measurement-terms.json',
  'core/publisher-property-selector.json',
  'core/forecast-point.json',
  'core/targeting-overlay-support.json',
  'core/targeting-overlay-requirements.json',
  'core/delivery-metric-aggregate.json',
  'core/cancellation-policy.json',
  'media-buy/package-update.json',
  'core/creative-approval-scope.json',
  'core/warning-resource.json',
  'formats/canonical/image.json',
  // Canonical overlays refine CanonicalFormatBase.slots with annotation-only
  // defaults. Compile the normalized standalone documents before bundled MCP
  // roots can claim these names from their lossy dereferenced copies, where
  // the local slots annotation is represented as Record<string, unknown>.
  'formats/canonical/html5.json',
  'formats/canonical/display_tag.json',
  'formats/canonical/image_carousel.json',
  'formats/canonical/video_hosted.json',
  'formats/canonical/video_vast.json',
  'formats/canonical/audio_hosted.json',
  'formats/canonical/audio_daast.json',
  'formats/canonical/sponsored_placement.json',
  'formats/canonical/native_in_feed.json',
  'formats/canonical/responsive_creative.json',
  'formats/canonical/agent_placement.json',
  // Present in the signed 3.2 manifest but omitted from index.json's legacy
  // governance task aggregation. Keep its public validators available until
  // the index and manifest converge upstream.
  'property/validate-property-delivery-request.json',
  'property/validate-property-delivery-response.json',
] as const;

const PRIORITY_CANONICAL_TYPE_NAMES = new Set([
  'ExtensionObject',
  'CreativeBrief',
  'BrandReference',
  'BusinessEntity',
  'PlatformExtensionReference',
  'DeliveryMetrics',
  'MeasurementTerms',
  'PublisherPropertySelector',
  'ForecastPoint',
  'TargetingOverlaySupport',
  'TargetingOverlayRequirements',
  'DeliveryMetricAggregate',
  'CancellationPolicy',
  'PackageUpdate',
  'ScopedCreativeApproval',
  'WarningAffectedResource',
  'CanonicalFormatImage',
  'CanonicalFormatHTML5Banner',
  'CanonicalFormatDisplayTag',
  'CanonicalFormatImageCarousel',
  'CanonicalFormatHostedVideo',
  'CanonicalFormatVASTVideo',
  'CanonicalFormatHostedAudio',
  'CanonicalFormatDAASTAudio',
  'CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven',
  'CanonicalFormatNativeInFeed',
  'CanonicalFormatResponsiveCreative',
  'CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement',
  'SizeModeMutex',
  'Fixed',
  'MultiSize',
  'Responsive',
  'None',
]);

// Shared schemas that are authoritative in core.generated.ts but are also
// pulled into tool compilation through request/response $refs. Keep them out
// of tools.generated.ts and import references from core.generated.ts instead.
const CORE_AUTHORED_TOOL_SHARED_TYPES = new Set([
  'AccountReference',
  'AssetVariant',
  'AudienceConstraints',
  'BrandReference',
  'CatalogItemDeliveryMetrics',
  'CreativeAsset',
  'ExtensionObject',
  'FormatReferenceStructuredObject',
  'GeoDeliveryMetrics',
  'GetProductsAsyncSubmitted',
  'ImageAsset',
  'KeywordDeliveryMetrics',
  'Provenance',
  'PurchaseType',
  'RightsConstraint',
  ...PRIORITY_CANONICAL_TYPE_NAMES,
]);

const BACKWARD_COMPAT_TYPE_ALIASES: Array<{
  oldName: string;
  newName: string;
  reason: string;
}> = [
  {
    oldName: 'SignalCatalogType',
    newName: 'SignalAvailabilityType',
    reason: 'AdCP 3.1 renamed SignalCatalogType to SignalAvailabilityType.',
  },
  {
    oldName: 'IdentityMatchResponse',
    newName: 'IdentityMatchResponseRouterPublisher',
    reason: 'AdCP 3.1.10 renamed the publisher-facing response to distinguish it from the provider hop.',
  },
  {
    oldName: 'ContextMatchResponse',
    newName: 'ContextMatchResponseRouterPublisher',
    reason: 'AdCP 3.2 names the publisher-facing context-match response by hop.',
  },
  {
    oldName: 'OutcomeMeasurementDeprecated',
    newName: 'OutcomeMeasurement',
    reason: 'SDK 13 exported the 3.1 compatibility name.',
  },
  {
    oldName: 'GetProductsSubmitted',
    newName: 'GetProductsAsyncSubmitted',
    reason: 'AdCP 3.2 shortened the submitted response title; the aggregate schema still emits the legacy nested name.',
  },
  {
    oldName: 'GetSignalsSubmitted',
    newName: 'GetSignalsAsyncSubmitted',
    reason: 'AdCP 3.2 shortened the submitted response title; the aggregate schema still emits the legacy nested name.',
  },
  ...['CreateMediaBuy', 'UpdateMediaBuy', 'SyncCatalogs', 'BuildCreative', 'SyncCreatives'].map(baseName => ({
    oldName: `${baseName}AsyncSubmitted`,
    newName: `${baseName}Submitted`,
    reason: 'AdCP 3.2 shortened submitted response type names.',
  })),
];

// Load schema from cache - handles both /schemas/v1/ and /schemas/X.Y.Z/ paths
function loadCachedSchema(schemaRef: string): any {
  try {
    const relativePath = schemaRefToCacheRelativePath(schemaRef);
    const schemaPath = resolveSchemaRefInCache(LATEST_CACHE_DIR, schemaRef);
    if (!relativePath || !schemaPath || !existsSync(schemaPath)) {
      throw new Error(`Schema not found in cache for ref: ${schemaRef}`);
    }

    let schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

    // Apply deprecated field/enum removal based on schema name
    // Extract schema name from path: core/format.json -> Format
    const fileName = path.basename(relativePath, '.json');
    const schemaName = fileName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

    // Check for deprecated enum values (uses kebab-case file name)
    if (DEPRECATED_ENUM_VALUES[fileName]) {
      schema = removeDeprecatedFields(schema, fileName);
    }

    // Check for deprecated object fields (uses PascalCase schema name)
    if (DEPRECATED_SCHEMA_FIELDS[schemaName]) {
      schema = removeDeprecatedFields(schema, schemaName);
    }

    // Make specified fields optional for backward compat with pre-v3 agents
    if (BACKWARD_COMPAT_OPTIONAL_FIELDS[schemaName]) {
      schema = makeFieldsOptional(schema, BACKWARD_COMPAT_OPTIONAL_FIELDS[schemaName]);
    }

    schema = applyCodegenSchemaWorkarounds(schema, schemaName);

    return schema;
  } catch (error) {
    console.warn(`⚠️  Failed to load cached schema ${schemaRef}:`, error.message);
    return null;
  }
}

// Get cached AdCP version
function getCachedAdCPVersion(): string {
  try {
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    return index.adcp_version || '1.0.0';
  } catch (error) {
    console.warn(`⚠️  Failed to get cached AdCP version:`, error.message);
    return '1.0.0';
  }
}

// AdCP Tool Definitions (based on official ADCP specification)
interface ToolDefinition {
  name: string;
  methodName: string;
  description: string;
  paramsSchema: any;
  responseSchema: any;
  singleAgentOnly?: boolean;
}

/**
 * Rewrite a discriminated `oneOf` whose branches are mutual-exclusion clauses
 * into explicit closed shapes. Without this, json-schema-to-typescript sees a
 * branch with no own `properties`/`type` and falls back to
 * `{ [k: string]: unknown | undefined }`, which is incompatible with closed-shape values
 * returned by typed builders (e.g. `displayRender({...})` cannot satisfy
 * `Format.renders[number]`'s loose first variant). See adcp-client#1325 and
 * adcp-client#1940 (sync_accounts ProvisioningMode/SettingsUpdateMode).
 *
 * Applies when the parent `items`-style schema has a sibling `properties` map
 * and every `oneOf` branch expresses its forbidden-field set in one of two
 * authorial idioms upstream uses:
 *
 *   1. `not: { required: [X, ...] }` — used by `Format.renders[]` etc.
 *   2. `allOf: [{ not: { required: [X] } }, ...]` — used by
 *      `SyncAccountsRequest.accounts[].oneOf[SettingsUpdateMode]` because
 *      `{required:[X,Y,Z]}` matches only when ALL three are present, while
 *      the authorial intent is "none of them may be present" (each field
 *      independently forbidden). The two forms aren't semantically equivalent.
 *   3. `not: { anyOf: [{ required: [X] }, ...] }` — same independent-field
 *      exclusion as (2), authored without an outer `allOf`.
 *
 * Each branch is rewritten to inline the parent's properties (minus those the
 * branch's forbidden-name set excludes), with the branch's own `required`
 * items added to the parent's `required`. The original `oneOf` is retained
 * but each branch is now a complete closed shape — jsts emits a clean union.
 *
 * Idempotent: a second pass over a transformed branch (which now has its own
 * `properties`) is a no-op because the predicate above no longer matches.
 */
function tightenMutualExclusionOneOf(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (!schema.oneOf || !Array.isArray(schema.oneOf)) return schema;
  if (!schema.properties || typeof schema.properties !== 'object') return schema;

  const parentProps = schema.properties as Record<string, any>;
  const parentRequired: string[] = Array.isArray(schema.required) ? [...schema.required] : [];

  // Returns the union of forbidden field names a branch declares — collected
  // from either `not.required` (idiom 1) or every entry of an `allOf` of
  // `{not:{required:[X]}}` clauses (idiom 2). Returns null when the branch
  // carries any other not/allOf shape — preserving the existing strict-bail
  // behavior so Ajv stays the source of truth at runtime.
  const extractBranchForbidden = (branch: any): string[] | null => {
    const forbidden = new Set<string>();
    let sawForbid = false;

    if (branch.not !== undefined) {
      if (!branch.not || typeof branch.not !== 'object') return null;
      const notKeys = Object.keys(branch.not);
      if (notKeys.length === 1 && notKeys[0] === 'required') {
        if (!Array.isArray(branch.not.required) || branch.not.required.length === 0) return null;
        for (const name of branch.not.required) forbidden.add(name);
      } else if (notKeys.length === 1 && notKeys[0] === 'anyOf' && Array.isArray(branch.not.anyOf)) {
        for (const entry of branch.not.anyOf) {
          if (!entry || typeof entry !== 'object') return null;
          const entryKeys = Object.keys(entry);
          if (entryKeys.length !== 1 || entryKeys[0] !== 'required') return null;
          if (!Array.isArray(entry.required) || entry.required.length === 0) return null;
          for (const name of entry.required) forbidden.add(name);
        }
      } else {
        return null;
      }
      sawForbid = true;
    }

    if (branch.allOf !== undefined) {
      if (!Array.isArray(branch.allOf) || branch.allOf.length === 0) return null;
      for (const entry of branch.allOf) {
        if (!entry || typeof entry !== 'object') return null;
        const entryKeys = Object.keys(entry);
        if (entryKeys.length !== 1 || entryKeys[0] !== 'not') return null;
        if (!entry.not || typeof entry.not !== 'object') return null;
        if (!Array.isArray(entry.not.required) || entry.not.required.length === 0) return null;
        if (Object.keys(entry.not).some(k => k !== 'required')) return null;
        for (const name of entry.not.required) forbidden.add(name);
      }
      sawForbid = true;
    }

    return sawForbid && forbidden.size > 0 ? Array.from(forbidden) : null;
  };

  const isMutualExclusionBranch = (branch: any): boolean => {
    if (!branch || typeof branch !== 'object') return false;
    // Branches that already declare their own type/ref/combinator have a
    // closed shape; nothing to tighten.
    if (branch.type || branch.$ref || branch.oneOf || branch.anyOf) return false;
    if (!Array.isArray(branch.required) || branch.required.length === 0) return false;
    return extractBranchForbidden(branch) !== null;
  };

  if (!schema.oneOf.every(isMutualExclusionBranch)) return schema;

  const rewritten = schema.oneOf.map((branch: any) => {
    const branchRequired: string[] = branch.required;
    const forbidden = extractBranchForbidden(branch) as string[];
    const branchOwnProps: Record<string, any> =
      branch.properties && typeof branch.properties === 'object' ? branch.properties : {};
    const newProperties: Record<string, any> = {};
    for (const [key, prop] of Object.entries(parentProps)) {
      if (forbidden.includes(key)) continue;
      // Branch's own property override (e.g. `{const: true}`) wins over parent's.
      newProperties[key] = branchOwnProps[key] ?? prop;
    }
    // Branch-only fields that the parent didn't declare.
    for (const [key, prop] of Object.entries(branchOwnProps)) {
      if (!(key in newProperties)) newProperties[key] = prop;
    }
    const out: Record<string, unknown> = {
      type: 'object',
      properties: newProperties,
      required: Array.from(new Set([...parentRequired, ...branchRequired])),
    };
    // Preserve titled-branch metadata so the emitted TS keeps named
    // interfaces (`ProvisioningMode`, `SettingsUpdateMode`) instead of
    // anonymous union arms.
    if (branch.title) out.title = branch.title;
    if (branch.description) out.description = branch.description;
    return out;
  });

  return { ...schema, oneOf: rewritten };
}

/**
 * Resolve an external `$ref` for the purpose of pre-merging an
 * `allOf: [{ $ref }]` member into its parent. Returns `null` for
 * unresolvable refs (including local `#/$defs/...` refs, which require
 * document context this helper doesn't have). Suppresses the warning that
 * `loadCachedSchema` would emit for unresolvable paths — a miss here just
 * means we leave the `allOf` member in place for jsts to handle.
 */
function resolveAllOfRefForMerge(ref: string): any | null {
  if (!ref || typeof ref !== 'string') return null;
  // Only external schema refs are resolvable through the cache. Local
  // `#/$defs/...` and other fragment-only refs are left to jsts.
  if (!schemaRefToCacheRelativePath(ref)) return null;
  // Suppress the warn from loadCachedSchema for legitimate misses (e.g. a
  // schema path we don't have cached yet). The original `allOf` member stays
  // in place if resolution fails.
  const originalWarn = console.warn;
  console.warn = () => {};
  let raw: any;
  try {
    raw = loadCachedSchema(ref);
  } finally {
    console.warn = originalWarn;
  }
  if (!raw) return null;
  // Apply the same preprocessing the ref resolver uses for normal $ref reads —
  // otherwise minItems/maxItems constraints from the base schema would leak
  // through the merge and resurrect as `@minItems`/tuple types in jsts output.
  const preprocessed = removeArrayLengthConstraints(raw);
  // Normalize the resolved base through the same strict-schema pipeline the
  // parent went through. Without this, a base schema's top-level
  // `additionalProperties: true` (e.g. creative-brief.json, catalog.json)
  // would propagate into the merged shape and emit a
  // `[k: string]: unknown | undefined` index signature on the resulting flat
  // interface — wider than the pre-merge intersection form. Recursion is
  // safe: `loadCachedSchema` reads a fresh JSON document per call (no shared
  // mutable cache), and AdCP schemas aren't cyclic at the `allOf:[{ $ref }]`
  // sibling level, so transitive base resolution terminates.
  return enforceStrictSchema(preprocessed);
}

function inlineAllOfObjectMemberForMerge(member: any): any | null {
  if (!member || typeof member !== 'object' || Array.isArray(member)) return null;
  if (member.type !== 'object') return null;
  if (!member.properties || typeof member.properties !== 'object') return null;

  const unsupported = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'];
  if (unsupported.some(key => member[key] !== undefined)) return null;

  return enforceStrictSchema(member);
}

function isRequiredOnlyAnyOf(anyOf: unknown): boolean {
  return (
    Array.isArray(anyOf) &&
    anyOf.length > 0 &&
    anyOf.every(branch => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return false;
      const keys = Object.keys(branch);
      return keys.length === 1 && keys[0] === 'required' && Array.isArray((branch as any).required);
    })
  );
}

/**
 * Convert the narrow JSON Schema conditional-required pattern used by
 * cancellation fees into a discriminated union that TypeScript and Zod can
 * both preserve.
 *
 * json-schema-to-typescript collapses an object carrying
 * `allOf: [{ if: ..., then: { required: [...] } }]` to an index signature.
 * Simply dropping the conditionals keeps the fields visible, but loses the
 * money-path invariant in generated Zod schemas. When every allOf member is a
 * same-property const check that only adds required fields, expand the enum
 * values into explicit object branches instead. Anything more expressive is
 * left untouched for the existing conservative fallback below.
 */
export function expandConditionalRequiredDiscriminator(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (schema.type !== 'object' || !schema.properties || !Array.isArray(schema.allOf) || schema.allOf.length === 0) {
    return schema;
  }

  let discriminator: string | undefined;
  const requiredByValue = new Map<unknown, Set<string>>();

  for (const member of schema.allOf) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return schema;
    const memberKeys = Object.keys(member);
    if (memberKeys.some(key => !['$comment', 'if', 'then'].includes(key)) || !member.if || !member.then) return schema;

    const condition = member.if;
    const then = member.then;
    if (!condition || typeof condition !== 'object' || !then || typeof then !== 'object') return schema;
    if (Object.keys(condition).some(key => !['properties', 'required'].includes(key))) return schema;
    if (Object.keys(then).some(key => key !== 'required')) return schema;
    if (!condition.properties || typeof condition.properties !== 'object') return schema;

    const conditionEntries = Object.entries(condition.properties);
    if (conditionEntries.length !== 1) return schema;
    const [field, fieldCondition] = conditionEntries[0] as [string, any];
    if (
      !fieldCondition ||
      typeof fieldCondition !== 'object' ||
      Object.keys(fieldCondition).some(key => key !== 'const')
    ) {
      return schema;
    }
    if (!Object.prototype.hasOwnProperty.call(fieldCondition, 'const')) return schema;
    if (!Array.isArray(condition.required) || condition.required.length !== 1 || condition.required[0] !== field) {
      return schema;
    }
    if (
      !Array.isArray(then.required) ||
      then.required.length === 0 ||
      then.required.some((name: unknown) => typeof name !== 'string')
    ) {
      return schema;
    }
    if (then.required.some((name: string) => !Object.prototype.hasOwnProperty.call(schema.properties, name)))
      return schema;
    if (discriminator !== undefined && discriminator !== field) return schema;
    discriminator = field;

    const valueRequired = requiredByValue.get(fieldCondition.const) ?? new Set<string>();
    for (const name of then.required as string[]) valueRequired.add(name);
    requiredByValue.set(fieldCondition.const, valueRequired);
  }

  if (!discriminator || !Array.isArray(schema.required) || !schema.required.includes(discriminator)) return schema;
  const discriminatorSchema = schema.properties[discriminator];
  if (!discriminatorSchema || typeof discriminatorSchema !== 'object' || !Array.isArray(discriminatorSchema.enum))
    return schema;
  if (discriminatorSchema.enum.length === 0) return schema;
  if ([...requiredByValue.keys()].some(value => !discriminatorSchema.enum.includes(value))) return schema;

  const branches = discriminatorSchema.enum.map((value: unknown) => {
    const branchProperties = {
      ...schema.properties,
      [discriminator]: {
        ...discriminatorSchema,
        const: value,
      },
    };
    delete branchProperties[discriminator].enum;
    const branchRequired = [...schema.required, ...(requiredByValue.get(value) ?? [])];
    const branch: Record<string, unknown> = {
      type: 'object',
      properties: branchProperties,
      required: [...new Set(branchRequired)],
    };
    // `additionalProperties: true` on a named structural object is a runtime
    // forward-compatibility rule, not a request for a TypeScript index
    // signature. Copy typed/closed maps and the small set of explicit opaque
    // maps only; otherwise every expanded branch reintroduces the utility-type
    // regression that the strict-schema pass removes.
    if (
      schema.additionalProperties !== undefined &&
      (schema.additionalProperties !== true || shouldPreserveOpenIndexSignature(schema))
    ) {
      branch.additionalProperties = schema.additionalProperties;
    }
    return branch;
  });

  const expanded = { ...schema, oneOf: branches };
  delete expanded.type;
  delete expanded.properties;
  delete expanded.required;
  delete expanded.allOf;
  delete expanded.additionalProperties;
  return expanded;
}

/**
 * json-schema-to-typescript loses parent-level requiredness when an object is
 * refined by property-only anyOf branches. PostalCountrySystem uses this shape
 * to constrain valid country/system pairs, so copy the unconditional parent
 * requirements into every branch before compilation. This is semantics-
 * preserving: the parent required array already applies to every anyOf arm.
 */
export function preservePostalCountrySystemRequiredness(schema: any): any {
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    schema.title !== 'Postal Country System' ||
    !schema.properties ||
    !Array.isArray(schema.required) ||
    !Array.isArray(schema.anyOf) ||
    schema.anyOf.length === 0
  ) {
    return schema;
  }

  const parentRequired = schema.required.filter(
    (field: unknown): field is string =>
      typeof field === 'string' && Object.prototype.hasOwnProperty.call(schema.properties, field)
  );
  if (parentRequired.length === 0) return schema;
  if (
    !schema.anyOf.every(
      (branch: any) =>
        branch && typeof branch === 'object' && !Array.isArray(branch) && branch.properties && !branch.$ref
    )
  ) {
    return schema;
  }

  return {
    ...schema,
    anyOf: schema.anyOf.map((branch: any) => ({
      ...branch,
      required: [...new Set([...parentRequired, ...(Array.isArray(branch.required) ? branch.required : [])])],
    })),
  };
}

function isRequirednessOnlySchema(schema: any): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const keys = Object.keys(schema).filter(key => !['description', '$comment', 'title'].includes(key));
  if (keys.length === 1 && keys[0] === 'required') return Array.isArray(schema.required);
  if (keys.length === 1 && keys[0] === 'not') return isRequirednessOnlySchema(schema.not);
  if (keys.length === 1 && (keys[0] === 'anyOf' || keys[0] === 'allOf')) {
    const members = schema[keys[0]];
    return Array.isArray(members) && members.length > 0 && members.every(isRequirednessOnlySchema);
  }
  if (keys.length > 0 && keys.every(key => key === 'required' || key === 'properties')) {
    if (schema.required !== undefined && !Array.isArray(schema.required)) return false;
    if (schema.properties !== undefined) {
      if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false;
      if (!Object.values(schema.properties).every(isRequirednessOnlySchema)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Drop anyOf members that only conditionally require/forbid already-declared
 * properties. They remain enforced by Ajv from the untouched source schema;
 * keeping them in the emit-only copy makes jsts replace the useful object
 * shape with unions of anonymous index signatures.
 */
function dropValidationOnlyAnyOf(schema: any): any {
  if (
    !schema?.properties ||
    !Array.isArray(schema.anyOf) ||
    schema.anyOf.length === 0 ||
    !schema.anyOf.every(isRequirednessOnlySchema)
  ) {
    return schema;
  }
  const result = { ...schema };
  delete result.anyOf;
  return result;
}

/**
 * Materialize the canonical image/html5/display-tag size mutex. The protocol
 * expresses this as a validation-only allOf member whose branches contain
 * required/not clauses but no properties. jsts therefore emits Fixed,
 * MultiSize, Responsive and None as empty/index-signature shapes. Copying the
 * seven size properties from the containing format gives TypeScript the
 * intended structural union; Ajv still enforces exact mutual exclusion.
 */
function materializeSizeModeMutex(schema: any, parentProperties: Record<string, any>): any {
  if (!schema || schema.title !== 'Size-mode mutex' || !Array.isArray(schema.oneOf)) return schema;
  const sizeFields = ['width', 'height', 'sizes', 'min_width', 'max_width', 'min_height', 'max_height'];
  const available = Object.fromEntries(
    sizeFields.filter(field => parentProperties[field] !== undefined).map(field => [field, parentProperties[field]])
  );
  if (Object.keys(available).length === 0) return schema;

  const rewritten = schema.oneOf.map((branch: any) => {
    const title = branch?.title;
    let fields: string[];
    let required: string[] = [];
    if (title === 'fixed') {
      fields = ['width', 'height'];
      required = fields;
    } else if (title === 'multi-size') {
      fields = ['sizes'];
      required = fields;
    } else if (title === 'responsive') {
      fields = ['min_width', 'max_width', 'min_height', 'max_height'];
    } else if (title === 'none') {
      fields = [];
    } else {
      return branch;
    }
    const properties = Object.fromEntries(
      fields.filter(field => available[field]).map(field => [field, available[field]])
    );
    return {
      ...(title ? { title } : {}),
      ...(branch.description ? { description: branch.description } : {}),
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  });
  return { ...schema, oneOf: rewritten };
}

/**
 * Recursively remove additionalProperties: true from schema to enforce strict typing
 * This prevents [k: string]: unknown in generated TypeScript types
 *
 * EXCEPTIONS: Explicit extension maps and fields whose descriptions contain
 * "must echo this value back unchanged" preserve additionalProperties: true.
 */
function shouldPreserveOpenIndexSignature(schema: any): boolean {
  if (!schema || typeof schema !== 'object' || schema.additionalProperties !== true) return false;

  // `core/ext.json` is intentionally a vendor-keyed extension bag. Its title
  // is canonical and stable across the standalone and bundled schemas.
  if (schema.title === 'Extension Object') return true;

  return (
    typeof schema.description === 'string' &&
    schema.description.toLowerCase().includes('must echo this value back unchanged')
  );
}

export function enforceStrictSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  schema = expandConditionalRequiredDiscriminator(schema);
  schema = preservePostalCountrySystemRequiredness(schema);
  schema = dropValidationOnlyAnyOf(schema);

  // Rewrite mutual-exclusion `oneOf` patterns (e.g. Format.renders[]) into
  // explicit closed-shape branches before any further processing — see
  // {@link tightenMutualExclusionOneOf}. Idempotent on already-rewritten
  // branches.
  schema = tightenMutualExclusionOneOf(schema);

  // Create a shallow copy
  const strictSchema = { ...schema };

  if (strictSchema.properties && Array.isArray(strictSchema.allOf)) {
    strictSchema.allOf = strictSchema.allOf.map((member: any) =>
      materializeSizeModeMutex(member, strictSchema.properties)
    );
  }

  // Check if this field must preserve arbitrary properties (e.g., context fields)
  const mustPreserveProperties = shouldPreserveOpenIndexSignature(strictSchema);

  // Remove additionalProperties if it's true, UNLESS the field must preserve properties
  if (strictSchema.additionalProperties === true && !mustPreserveProperties) {
    delete strictSchema.additionalProperties;
  }

  // Annotation-only nodes — schemas that carry only JSON Schema metadata keywords and no
  // type, ref, combinator, validator, or structural keyword — represent "any JSON value"
  // per JSON Schema semantics. json-schema-to-typescript defaults these to
  // { [k: string]: unknown }, which downstream Zod generation narrows to z.record and
  // rejects scalar values the spec allows (e.g. `check_governance` conditions[].required_value
  // returning a number). Annotate with tsType so the emitted TS is unknown.
  const metadataOnlyKeys = new Set([
    'description',
    'title',
    '$comment',
    'examples',
    'default',
    'deprecated',
    'readOnly',
    'writeOnly',
    '$id',
    '$anchor',
    '$schema',
  ]);
  const allKeys = Object.keys(strictSchema);
  if (allKeys.length > 0 && allKeys.every(k => metadataOnlyKeys.has(k))) {
    strictSchema.tsType = 'unknown';
  }

  // Recursively process nested schemas
  if (strictSchema.properties) {
    strictSchema.properties = Object.fromEntries(
      Object.entries(strictSchema.properties).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  promoteConditionalParamProperties(strictSchema);

  if (strictSchema.patternProperties) {
    strictSchema.patternProperties = Object.fromEntries(
      Object.entries(strictSchema.patternProperties).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  // additionalProperties can be boolean or a schema; only recurse when it's a schema.
  if (strictSchema.additionalProperties && typeof strictSchema.additionalProperties === 'object') {
    strictSchema.additionalProperties = enforceStrictSchema(strictSchema.additionalProperties);
  }

  for (const key of [
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]) {
    if (strictSchema[key] && typeof strictSchema[key] === 'object') {
      strictSchema[key] = enforceStrictSchema(strictSchema[key]);
    }
  }

  // dependentSchemas maps property name → schema. (dependencies in draft-07 may be schema or
  // string[]; only recurse into schema values.)
  for (const key of ['dependentSchemas', 'dependencies']) {
    if (strictSchema[key] && typeof strictSchema[key] === 'object' && !Array.isArray(strictSchema[key])) {
      strictSchema[key] = Object.fromEntries(
        Object.entries(strictSchema[key]).map(([name, value]) => [
          name,
          value && typeof value === 'object' && !Array.isArray(value) ? enforceStrictSchema(value) : value,
        ])
      );
    }
  }

  if (strictSchema.items) {
    if (Array.isArray(strictSchema.items)) {
      strictSchema.items = strictSchema.items.map(enforceStrictSchema);
    } else {
      strictSchema.items = enforceStrictSchema(strictSchema.items);
    }
  }

  // Pre-merge `allOf: [{ $ref }, ...]` members when the parent has its own
  // `properties` or `required` at the same level. json-schema-to-typescript
  // mishandles this pattern (especially inside `oneOf` variants) and emits a
  // broken union `( BaseFields | { variant-specific + duplicated base fields } )`
  // where the intent is an intersection `BaseFields & { variant-specific }`.
  //
  // Resolving the `$ref` at the JSON Schema level lets jsts see a single flat
  // shape and emit a clean discriminated-union variant. We only resolve refs
  // we can load (external `/schemas/...` paths via the cache). Local
  // `#/$defs/...` refs are left in place — without the parent document we
  // can't resolve them here, and the existing post-processors handle the
  // common Individual*Asset alias case.
  //
  // The merged shape loses the named base type alias in the emitted TS
  // (option 2 in the adcp#4510 acceptance criteria: "flattens the allOf into
  // a single merged shape — less ideal but acceptable"). Recovering the
  // intersection form would be a follow-up polish pass.
  //
  // We only apply this merge when the parent already declares its own
  // `properties` or `required` siblings — the `vendor-pricing-option` style
  // (allOf-only at root, no sibling properties) compiles correctly today and
  // is left untouched.
  if (
    Array.isArray(strictSchema.allOf) &&
    (strictSchema.properties || strictSchema.required) &&
    !mustPreserveProperties
  ) {
    const remaining: any[] = [];
    for (const member of strictSchema.allOf) {
      let resolved: any | null = null;
      if (member && typeof member === 'object' && typeof member.$ref === 'string' && Object.keys(member).length === 1) {
        resolved = resolveAllOfRefForMerge(member.$ref);
      } else {
        resolved = inlineAllOfObjectMemberForMerge(member);
      }
      if (resolved) {
        // Variant-level fields win on collision — `properties`, `required`,
        // and `additionalProperties` are merged with variant precedence.
        const resolvedProperties = resolved.properties ?? {};
        const localProperties = strictSchema.properties ?? {};
        strictSchema.properties = { ...resolvedProperties };
        for (const [propertyName, localProperty] of Object.entries(localProperties)) {
          const resolvedProperty = resolvedProperties[propertyName];
          // A sibling declaration in an allOf refines the referenced
          // property; it does not replace structural keywords such as type
          // and items. Canonical image `slots` supplies a local default while
          // the base schema owns its array shape.
          const mergedProperty =
            resolvedProperty &&
            typeof resolvedProperty === 'object' &&
            !Array.isArray(resolvedProperty) &&
            localProperty &&
            typeof localProperty === 'object' &&
            !Array.isArray(localProperty)
              ? { ...resolvedProperty, ...localProperty }
              : localProperty;
          // Annotation-only sibling refinements are marked `tsType: unknown`
          // during the first recursive pass. Once they are merged with a
          // structural base property (for example canonical image `slots`,
          // whose sibling only supplies a default), that marker must not
          // override the base array/object shape.
          if (
            mergedProperty &&
            typeof mergedProperty === 'object' &&
            !Array.isArray(mergedProperty) &&
            resolvedProperty &&
            typeof resolvedProperty === 'object' &&
            !Array.isArray(resolvedProperty) &&
            (resolvedProperty.type || resolvedProperty.$ref || resolvedProperty.items || resolvedProperty.properties) &&
            localProperty &&
            typeof localProperty === 'object' &&
            !Array.isArray(localProperty) &&
            localProperty.tsType === 'unknown'
          ) {
            delete mergedProperty.tsType;
          }
          strictSchema.properties[propertyName] = mergedProperty;
        }
        const mergedRequired = [...(resolved.required ?? []), ...(strictSchema.required ?? [])];
        if (mergedRequired.length > 0) {
          strictSchema.required = [...new Set(mergedRequired)];
        }
        if (strictSchema.additionalProperties === undefined && resolved.additionalProperties !== undefined) {
          strictSchema.additionalProperties = resolved.additionalProperties;
        }
        continue;
      }
      remaining.push(member);
    }
    strictSchema.allOf = remaining;
    if (strictSchema.allOf.length === 0) {
      delete strictSchema.allOf;
    }
    // Re-run property recursion now that we've merged in base properties —
    // they may themselves carry allOf/$ref patterns that need normalizing.
    if (strictSchema.properties) {
      strictSchema.properties = Object.fromEntries(
        Object.entries(strictSchema.properties).map(([key, value]) => [key, enforceStrictSchema(value)])
      );
    }

    // A resolved allOf base may intentionally preserve openness (for example
    // an opaque echo context or ExtensionObject). Once its properties are
    // merged into an ordinary named interface, that inherited flag must be
    // judged against the resulting interface rather than blindly copied.
    // Otherwise allOf silently resurrects `[k: string]: unknown` after the
    // initial strictness pass and breaks Pick/Omit source compatibility.
    if (strictSchema.additionalProperties === true && !shouldPreserveOpenIndexSignature(strictSchema)) {
      delete strictSchema.additionalProperties;
    }
  }

  if (strictSchema.allOf) {
    // Strip allOf members that contain only validation logic TypeScript can't
    // represent. Two cases:
    //   1. `not` constraints — mutual-exclusivity validators (e.g. "not both
    //      feed_field and value"). Keeping them causes json-schema-to-typescript
    //      to emit the full property set once per member, producing duplicate
    //      intersection arms.
    //   2. `if`/`then`/`else` conditionals — JSON Schema 7 conditional
    //      validation (e.g. "if request_type='single' then creative_manifest
    //      is required"). TS can't conditionally require fields based on
    //      another field's discriminator value. Worse, jsts intersects every
    //      branch's properties with `{ [k: string]: unknown }`, producing
    //      `BaseShape & { [k: string]: unknown }` noise that forces adopters
    //      into `as any` casts. These conditionals are still enforced at
    //      runtime by Ajv, which loads the original (unstripped) JSON
    //      schemas — so removing them from the TS-emit path doesn't weaken
    //      validation.
    strictSchema.allOf = strictSchema.allOf
      .filter((member: any) => {
        const keys = Object.keys(member);
        // Recursive normalization turns validation-only conditionals into
        // annotation nodes (`$comment` plus `tsType: unknown`) before their
        // parent reaches this filter. They remain validation-only and must
        // not collapse the enclosing structural type to `unknown`.
        if (member.tsType === 'unknown' && keys.every(k => metadataOnlyKeys.has(k) || k === 'tsType')) {
          return false;
        }
        if (keys.length === 1 && keys[0] === 'not') return false;
        // Conditional validators are exclusively `if` / `then` / `else`.
        // Drop members composed only of those keys.
        if (
          keys.some(k => k === 'if' || k === 'then' || k === 'else') &&
          keys.every(k => k === 'if' || k === 'then' || k === 'else' || metadataOnlyKeys.has(k))
        ) {
          return false;
        }
        // XOR-via-anyOf pattern: a member that is purely `{ anyOf: [...] }`
        // where every branch is a `required`-only object. This is the
        // canonical JSON Schema idiom for "at least one of these fields is
        // present" — combined with a sibling `not` member (already stripped
        // above), it expresses XOR. jsts has no way to model "exactly one of
        // these properties must be set"; keeping the member produces
        // intersections that double the property surface and confuse
        // downstream ts-to-zod. Ajv enforces the constraint at runtime
        // against the unstripped schema. Used by `publisher-property-selector.json`
        // for the `publisher_domain` / `publisher_domains` XOR (adcp#4504).
        if (keys.length === 1 && keys[0] === 'anyOf' && Array.isArray(member.anyOf)) {
          const onlyRequiredBranches = member.anyOf.every((b: any) => {
            if (!b || typeof b !== 'object') return false;
            const bKeys = Object.keys(b);
            return bKeys.length === 1 && bKeys[0] === 'required' && Array.isArray(b.required);
          });
          if (onlyRequiredBranches) return false;
        }
        return true;
      })
      .map(enforceStrictSchema);
    if (strictSchema.allOf.length === 0) {
      delete strictSchema.allOf;
    }
  }

  // Top-level `if` / `then` / `else` (rare but valid JSON Schema 7) — same
  // rationale as above. Strip; Ajv enforces them at runtime against the
  // unstripped schema.
  if (strictSchema.if) delete strictSchema.if;
  if (strictSchema.then) delete strictSchema.then;
  if (strictSchema.else) delete strictSchema.else;

  // Required-only anyOf is the JSON Schema idiom for "at least one of these
  // fields must be present" (for example signal_ref OR deprecated signal_id).
  // TypeScript cannot represent that cleanly; keeping it often makes jsts
  // emit a loose `{ [k: string]: unknown }` union arm. Ajv still enforces the
  // original schema at runtime, so the TS emit path strips the guard.
  if (isRequiredOnlyAnyOf(strictSchema.anyOf)) {
    delete strictSchema.anyOf;
  }

  if (strictSchema.anyOf) {
    strictSchema.anyOf = strictSchema.anyOf.map(enforceStrictSchema);
  }

  if (strictSchema.oneOf) {
    strictSchema.oneOf = strictSchema.oneOf.map(enforceStrictSchema);
  }

  if (strictSchema.definitions) {
    strictSchema.definitions = Object.fromEntries(
      Object.entries(strictSchema.definitions).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  if (strictSchema.$defs) {
    strictSchema.$defs = Object.fromEntries(
      Object.entries(strictSchema.$defs).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  return flattenMutualExclusiveOneOf(strictSchema);
}

function canonicalCodegenJson(value: unknown, keyHint?: string): string {
  // Build-time JSON Schema snippets only need deterministic key order; avoid
  // routing the generator through runtime JCS semantics it does not depend on.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalCodegenJson(item));
    // Schema enum order is authoring noise for our conflict check; stringify
    // first so mixed-type enums like [1, "1"] still sort deterministically.
    if (keyHint === 'enum') items.sort();
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalCodegenJson(obj[key], key)}`)
    .join(',')}}`;
}

/**
 * json-schema-to-typescript strips `if` / `then` before it can infer params
 * declared only inside conditionals. Promote the narrow authorial shape we use
 * today (`allOf[].then.properties.params.properties`) into the root params
 * object, then let Ajv keep enforcing the full conditional schema at runtime.
 *
 * This intentionally does not chase nested `then.allOf`, `else`, `oneOf`, or
 * arbitrary conditional schemas. If upstream starts authoring those shapes,
 * the generator should learn that explicit pattern rather than silently
 * guessing a wider transform.
 */
export function promoteConditionalParamProperties(strictSchema: any): void {
  const params = strictSchema.properties?.params;
  if (!params || typeof params !== 'object' || !params.properties || !Array.isArray(strictSchema.allOf)) return;
  const rootParamKeys = new Set(Object.keys(params.properties));
  const promoted = new Map<string, { value: unknown; memberIndex: number }>();
  for (const [memberIndex, member] of strictSchema.allOf.entries()) {
    const conditionalParams = member?.then?.properties?.params;
    if (!conditionalParams || typeof conditionalParams !== 'object' || !conditionalParams.properties) continue;
    for (const [key, value] of Object.entries(conditionalParams.properties)) {
      if (rootParamKeys.has(key)) {
        continue;
      }
      if (!promoted.has(key)) {
        params.properties[key] = value;
        promoted.set(key, { value, memberIndex });
        continue;
      }
      const existing = promoted.get(key)!;
      if (canonicalCodegenJson(existing.value) !== canonicalCodegenJson(value)) {
        throw new Error(
          `Conflicting conditional params property "${key}" while promoting allOf[${memberIndex}].then.properties.params.properties.${key}; first promoted from allOf[${existing.memberIndex}].then.properties.params.properties.${key}`
        );
      }
    }
  }
}

/**
 * Inline parent `properties` into `oneOf` branches that use the JSON Schema
 * "X xor Y" mutual-exclusivity pattern (`{ required: [X], not: { required:
 * [Y] } }`). Without this, json-schema-to-typescript can't extract each branch
 * as a closed shape — branches with only `required` + `not` (no own type or
 * properties) collapse to `{ [k: string]: unknown }`. The result is unions
 * like `Format.renders[]` whose loose arm rejects the SDK's typed factory
 * builders (`displayRender({...})`) under strict tsc.
 *
 * Detection (conservative): all `oneOf` branches must match a `{ required,
 * not: { required }, properties?, title?, description? }` shape with no other
 * keys. The transform inlines outer `properties` into each branch (minus the
 * fields each branch's `not.required` excludes), promotes outer `required`
 * into each branch, and drops the branch-level `not`. The mutual-exclusivity
 * constraint stays enforced at runtime by Ajv against the unstripped schema —
 * the codegen pass only widens what TypeScript can express.
 *
 * Schemas this affects today: `Format.renders[]`, `sync_plans` plan budget.
 * Both share the same authorial idiom upstream (adcontextprotocol/adcp).
 */
/**
 * Pull a branch's forbidden-field set out of either authorial idiom upstream
 * uses:
 *
 *   1. `not: { required: [X, ...] }` — single not-required clause.
 *   2. `allOf: [{ not: { required: [X] } }, { not: { required: [Y] } }, ...]`
 *      — an allOf of single-key not-required clauses.
 *   3. `not: { anyOf: [{ required: [X] }, ...] }` — same independent-field
 *      exclusion as (2), authored without an outer `allOf`.
 *
 * Returns the union of forbidden names, or `null` if the branch carries any
 * other not/allOf shape we don't recognize (in which case the flattener bails
 * to preserve runtime behavior under Ajv).
 *
 * Idiom (2) appears on `SyncAccountsRequest.accounts[].oneOf[SettingsUpdateMode]`
 * (adcp 3.1.0-beta.3) — its three forbidden fields can't compress into a
 * single `not: {required: [X, Y, Z]}` because `{required:[X,Y,Z]}` matches
 * only when ALL three are present, while the authorial intent is "none of
 * them may be present" (each field independently forbidden).
 */
function extractBranchExcludedNames(branch: any): Set<string> | null {
  const excluded = new Set<string>();
  let sawForbid = false;

  // Form 1: top-level `not: { required: [...] }`
  if (branch.not !== undefined) {
    if (!branch.not || typeof branch.not !== 'object') return null;
    const notKeys = Object.keys(branch.not);
    if (notKeys.length === 1 && notKeys[0] === 'required') {
      if (!Array.isArray(branch.not.required) || branch.not.required.length === 0) return null;
      for (const name of branch.not.required) excluded.add(name);
    } else if (notKeys.length === 1 && notKeys[0] === 'anyOf' && Array.isArray(branch.not.anyOf)) {
      for (const entry of branch.not.anyOf) {
        if (!entry || typeof entry !== 'object') return null;
        const entryKeys = Object.keys(entry);
        if (entryKeys.length !== 1 || entryKeys[0] !== 'required') return null;
        if (!Array.isArray(entry.required) || entry.required.length === 0) return null;
        for (const name of entry.required) excluded.add(name);
      }
    } else {
      return null;
    }
    sawForbid = true;
  }

  // Form 2: `allOf: [{ not: { required: [...] } }, ...]`
  if (branch.allOf !== undefined) {
    if (!Array.isArray(branch.allOf) || branch.allOf.length === 0) return null;
    for (const entry of branch.allOf) {
      if (!entry || typeof entry !== 'object') return null;
      if (Object.keys(entry).length !== 1 || !entry.not) return null;
      if (typeof entry.not !== 'object') return null;
      if (!Array.isArray(entry.not.required) || entry.not.required.length === 0) return null;
      if (Object.keys(entry.not).some(k => k !== 'required')) return null;
      for (const name of entry.not.required) excluded.add(name);
    }
    sawForbid = true;
  }

  return sawForbid && excluded.size > 0 ? excluded : null;
}

function flattenMutualExclusiveOneOf(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.properties || !schema.oneOf || !Array.isArray(schema.oneOf)) return schema;
  const branches = schema.oneOf;
  if (branches.length < 2) return schema;

  const ALLOWED_BRANCH_KEYS = new Set(['required', 'not', 'allOf', 'properties', 'title', 'description']);
  const excludedByBranch: Array<Set<string> | null> = branches.map((b: any) => {
    if (!b || typeof b !== 'object') return null;
    if (!Array.isArray(b.required) || b.required.length === 0) return null;
    if (Object.keys(b).some(k => !ALLOWED_BRANCH_KEYS.has(k))) return null;
    return extractBranchExcludedNames(b);
  });
  if (excludedByBranch.some(s => s === null)) return schema;

  const outerProps = schema.properties as Record<string, any>;
  const outerRequired: string[] = Array.isArray(schema.required) ? schema.required : [];
  // Preserve openness when the parent items schema is intentionally open.
  // SyncAccountsRequest's accounts entries set `additionalProperties: true`
  // because future per-account fields land in the parent properties bag,
  // not in branch-specific shapes. Forcing `additionalProperties: false`
  // on flattened branches would reject any future field until the SDK
  // regenerates — runtime Ajv would still accept it on the unstripped
  // schema, creating wire-vs-type drift.
  const parentAdditional = schema.additionalProperties;

  const newOneOf = branches.map((branch: any, i: number) => {
    const excluded = excludedByBranch[i] as Set<string>;
    const branchOwnProps: Record<string, any> = branch.properties ?? {};
    const branchProps: Record<string, any> = {};
    for (const [name, prop] of Object.entries(outerProps)) {
      if (excluded.has(name)) continue;
      branchProps[name] = branchOwnProps[name] ?? prop;
    }
    // Drop any outer `required` field this branch excluded — keeping it
    // would leave a required key with no matching `properties` entry, which
    // jsts emits as `field: unknown` and Ajv would reject on the unstripped
    // schema anyway.
    const filteredOuterRequired = outerRequired.filter(name => !excluded.has(name));
    const required = Array.from(new Set([...filteredOuterRequired, ...branch.required]));
    const out: Record<string, unknown> = { type: 'object' };
    if (branch.title) out.title = branch.title;
    if (branch.description) out.description = branch.description;
    out.properties = branchProps;
    if (required.length > 0) out.required = required;
    out.additionalProperties = parentAdditional === true ? true : false;
    return out;
  });

  const result = { ...schema, oneOf: newOneOf };
  delete result.properties;
  delete result.required;
  return result;
}

// Load AdCP tool schemas from cache
function loadToolSchema(
  toolName: string,
  taskType:
    | 'media-buy'
    | 'signals'
    | 'creative'
    | 'governance'
    | 'sponsored-intelligence'
    | 'protocol'
    | 'account' = 'media-buy'
): any {
  try {
    console.log(`📥 Loading ${toolName} schema from cache (${taskType})...`);

    // Read refs from the index.json instead of hardcoding paths
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

    const kebabName = toolName.replace(/_/g, '-');
    let requestRef: string | undefined;
    let responseRef: string | undefined;

    // Look up the task in the index to get actual $refs
    if (schemaIndex.schemas?.[taskType]?.tasks?.[kebabName]) {
      const task = schemaIndex.schemas[taskType].tasks[kebabName];
      requestRef = task.request?.$ref;
      responseRef = task.response?.$ref;
    }

    // Fallback: Try media-buy namespace if creative namespace fails
    if ((!requestRef || !responseRef) && taskType === 'creative') {
      console.log(`   ↪️  Trying media-buy namespace for ${toolName}...`);
      if (schemaIndex.schemas?.['media-buy']?.tasks?.[kebabName]) {
        const task = schemaIndex.schemas['media-buy'].tasks[kebabName];
        requestRef = task.request?.$ref;
        responseRef = task.response?.$ref;
      }
    }

    if (!requestRef || !responseRef) {
      throw new Error(`Missing request or response $ref in index for ${toolName}`);
    }

    const requestSchema = loadCachedSchema(requestRef);
    const responseSchema = loadCachedSchema(responseRef);

    if (!requestSchema || !responseSchema) {
      throw new Error(`Failed to load schemas for ${toolName}`);
    }

    // Combine into the expected format
    return {
      description: `Official AdCP ${toolName} tool schema`,
      type: 'object',
      properties: {
        request: requestSchema,
        response: responseSchema,
      },
    };
  } catch (error) {
    console.warn(`⚠️  Could not load schema for ${toolName}:`, error.message);
    return null;
  }
}

// All domains with tasks
const TASK_DOMAINS = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'sponsored-intelligence',
  'protocol',
  'account',
  'compliance',
] as const;
type TaskDomain = (typeof TASK_DOMAINS)[number];

// Deprecated tools that should be excluded from type generation
// These tools are maintained in upstream for backward compatibility but should not be exposed in the public API
const DEPRECATED_TOOLS = new Set([
  'list_authorized_properties', // Replaced by get_adcp_capabilities
  'list_property_features', // Never released
]);

// Deprecated fields to remove from schema during type generation
// Format: { schemaName: ['field1', 'field2'] }
const DEPRECATED_SCHEMA_FIELDS: Record<string, string[]> = {
  Format: ['assets_required', 'preview_image'],
};

// Fields to make optional for backward compatibility with older agent implementations.
// These fields are required in the v3 spec but were absent in v2.5/v2.6 schemas.
// Applies a recursive removal from all 'required' arrays in the named schema.
// Format: { schemaName (PascalCase from filename): ['field1', 'field2'] }
//
// How to identify fields needing this treatment:
//   1. Field is in a `required` array in a v3 JSON schema
//   2. Field did not exist in the corresponding v2 TypeScript type
//   3. Real agents running v2 implementations will not send the field
const BACKWARD_COMPAT_OPTIONAL_FIELDS: Record<string, string[]> = {
  // create_media_buy/update_media_buy: confirmed_at/revision are beta.7
  // additions. Older v3 sellers may still emit the legacy success shape.
  CreateMediaBuyResponse: ['confirmed_at', 'revision'],
  UpdateMediaBuyResponse: ['revision'],
  // get_media_buys: media_buy items
  // total_budget and approval_status are new required fields in v3.
  // beta.7 confirmed_at/revision are handled by applyCodegenSchemaWorkarounds
  // because they are only compat-optional on the media_buys[] item itself;
  // history[].revision must remain required.
  GetMediaBuysResponse: [
    'total_budget', // media_buys[].total_budget - new in v3
    'approval_status', // media_buys[].packages[].creative_approvals[].approval_status - new in v3
  ],
};

// Deprecated schemas that should be excluded entirely
const DEPRECATED_SCHEMAS = new Set([
  'adcp-extension', // Use get_adcp_capabilities tool instead
]);

// Deprecated enum values to filter from specific enum schemas
// Format: { schemaFileName: ['value1', 'value2'] }
const DEPRECATED_ENUM_VALUES: Record<string, string[]> = {
  'task-type': ['list_property_features', 'list_authorized_properties'],
};

// Compatibility enum additions for schema bundles that define async response
// arms before the shared task-type enum catches up.
const FORCED_ENUM_VALUES: Record<string, string[]> = {
  'task-type': ['get_products'],
};

const FORCED_ENUM_SCHEMA_VERSION: Record<string, string> = {
  'task-type': '3.1.0-rc.8',
};

function forcedEnumValuesForSchema(schema: any, schemaName: string): string[] | undefined {
  const forcedEnumValues = FORCED_ENUM_VALUES[schemaName];
  if (!forcedEnumValues) return undefined;

  const requiredVersion = FORCED_ENUM_SCHEMA_VERSION[schemaName];
  const schemaId = typeof schema.$id === 'string' ? schema.$id : '';
  if (requiredVersion && schemaId.includes(requiredVersion)) {
    return forcedEnumValues;
  }

  if (requiredVersion && getCachedAdCPVersion() === requiredVersion) {
    throw new Error(
      `Expected ${schemaName} enum shim for AdCP ${requiredVersion} to apply, but schema $id was ${schemaId || '(missing)'}.`
    );
  }

  return undefined;
}

/**
 * Remove deprecated fields from a schema based on DEPRECATED_SCHEMA_FIELDS config
 * Also handles deprecated enum values
 */
function removeDeprecatedFields(schema: any, schemaName: string): any {
  if (schema.enum && Array.isArray(schema.enum)) {
    let cleaned: any | undefined;
    const forcedEnumValues = forcedEnumValuesForSchema(schema, schemaName);
    if (forcedEnumValues) {
      const missingForcedValues = forcedEnumValues.filter(value => !schema.enum.includes(value));
      if (missingForcedValues.length === 0) {
        throw new Error(
          `Expected ${schemaName} enum shim to add ${forcedEnumValues.join(', ')}, but no values were missing.`
        );
      }
      cleaned = { ...schema };
      cleaned.enum = [...missingForcedValues, ...cleaned.enum];
      if (cleaned.enumDescriptions) {
        cleaned.enumDescriptions = { ...cleaned.enumDescriptions };
        for (const value of forcedEnumValues) {
          if (value === 'get_products' && cleaned.enumDescriptions[value] === undefined) {
            cleaned.enumDescriptions[value] = 'Media-buy domain: Discover or curate advertising products';
          }
        }
      }
    }
    // Handle deprecated enum values
    const enumValuesToRemove = DEPRECATED_ENUM_VALUES[schemaName];
    if (enumValuesToRemove) {
      cleaned = { ...(cleaned ?? schema) };
      cleaned.enum = cleaned.enum.filter((v: string) => !enumValuesToRemove.includes(v));
      // Also clean enumDescriptions if present
      if (cleaned.enumDescriptions) {
        cleaned.enumDescriptions = { ...cleaned.enumDescriptions };
        for (const value of enumValuesToRemove) {
          delete cleaned.enumDescriptions[value];
        }
      }
    }
    if (cleaned) return cleaned;
  }

  const fieldsToRemove = DEPRECATED_SCHEMA_FIELDS[schemaName];
  if (!fieldsToRemove || !schema || typeof schema !== 'object') {
    return schema;
  }

  const cleaned = { ...schema };

  // Remove deprecated fields from properties
  if (cleaned.properties) {
    cleaned.properties = { ...cleaned.properties };
    for (const field of fieldsToRemove) {
      delete cleaned.properties[field];
    }
  }

  // Remove from required array if present
  if (cleaned.required && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((r: string) => !fieldsToRemove.includes(r));
  }

  return cleaned;
}

/**
 * Recursively remove specific field names from all 'required' arrays in a schema.
 * Used for backward compatibility: makes v3-required fields optional so older agents pass validation.
 */
function makeFieldsOptional(schema: any, fieldsToMakeOptional: string[]): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(item => makeFieldsOptional(item, fieldsToMakeOptional));

  const cleaned = { ...schema };

  if (cleaned.required && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((r: string) => !fieldsToMakeOptional.includes(r));
  }

  for (const key of Object.keys(cleaned)) {
    if (typeof cleaned[key] === 'object') {
      cleaned[key] = makeFieldsOptional(cleaned[key], fieldsToMakeOptional);
    }
  }

  return cleaned;
}

function removeRequiredFields(schema: any, fieldsToMakeOptional: string[]): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const cleaned = { ...schema };
  if (Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((r: string) => !fieldsToMakeOptional.includes(r));
  }
  return cleaned;
}

function makeRootFieldsOptional(schema: any, fieldsToMakeOptional: string[]): any {
  const cleaned = removeRequiredFields(schema, fieldsToMakeOptional);
  if (Array.isArray(cleaned.allOf)) {
    cleaned.allOf = cleaned.allOf.map((member: any) => removeRequiredFields(member, fieldsToMakeOptional));
  }
  return cleaned;
}

const GET_MEDIA_BUY_DELIVERY_COMPAT_BREAKDOWNS = [
  {
    property: 'by_catalog_item',
    optionalFields: ['content_id'],
    title: 'Get Media Buy Delivery Catalog Item Metrics',
  },
  {
    property: 'by_keyword',
    optionalFields: ['keyword', 'match_type'],
    title: 'Get Media Buy Delivery Keyword Metrics',
  },
  {
    property: 'by_geo',
    optionalFields: ['geo_level', 'geo_code'],
    title: 'Get Media Buy Delivery Geo Metrics',
  },
  {
    property: 'by_device_type',
    optionalFields: ['device_type'],
    title: 'Get Media Buy Delivery Device Type Metrics',
  },
  {
    property: 'by_device_platform',
    optionalFields: ['device_platform'],
    title: 'Get Media Buy Delivery Device Platform Metrics',
  },
  {
    property: 'by_audience',
    optionalFields: ['audience_id', 'audience_source'],
    title: 'Get Media Buy Delivery Audience Metrics',
  },
  {
    property: 'by_placement',
    optionalFields: ['placement_id'],
    title: 'Get Media Buy Delivery Placement Metrics',
  },
] as const;

/**
 * Keep legacy buyer-side tolerance local to GetMediaBuyDeliveryResponse.
 *
 * The unbundled response points at canonical core metric schemas, while the
 * bundled response has those schemas inlined. Normalize both shapes to unique
 * response-local titles before jsts name de-duplication; otherwise recursively
 * optionalized bundled declarations can win over the strict canonical types.
 */
function isolateGetMediaBuyDeliveryCompatBreakdowns(schema: any): any {
  const cleaned = JSON.parse(JSON.stringify(schema));
  const packageItems = cleaned.properties?.media_buy_deliveries?.items?.properties?.by_package?.items;
  if (!packageItems || typeof packageItems !== 'object' || Array.isArray(packageItems)) return schema;

  const members = [packageItems, ...(Array.isArray(packageItems.allOf) ? packageItems.allOf : [])];
  const packageDetails = members.find((member: any) =>
    GET_MEDIA_BUY_DELIVERY_COMPAT_BREAKDOWNS.some(({ property }) => member?.properties?.[property])
  );
  const breakdownProperties = packageDetails?.properties;
  if (!packageDetails || !breakdownProperties) return schema;

  cleaned.required = removeRequiredFields(cleaned, ['currency']).required;
  packageDetails.required = removeRequiredFields(packageDetails, ['pricing_model', 'rate', 'currency']).required;

  for (const { property, optionalFields, title } of GET_MEDIA_BUY_DELIVERY_COMPAT_BREAKDOWNS) {
    const breakdown = breakdownProperties[property];
    const item = breakdown?.items;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const resolved = typeof item.$ref === 'string' ? loadCachedSchema(item.$ref) : item;
    if (!resolved) continue;
    const compatItem = makeRootFieldsOptional(resolved, [...optionalFields]);
    delete compatItem.$id;
    compatItem.title = title;
    breakdown.items = compatItem;
  }

  return cleaned;
}

/**
 * Targeted schema normalizations for the TypeScript/Zod emit path.
 *
 * These do not edit the cached JSON schemas and should only remove constraints
 * the TS emitter cannot model. Runtime validators still load the original
 * schemas, so conditional invariants remain enforced outside generated types.
 */
export function applyCodegenSchemaWorkarounds(schema: any, schemaName: string): any {
  if (!schema || typeof schema !== 'object') return schema;

  schema = coalesceDefinitionKeywords(schema);

  if (schemaName === 'DeclineProposalsResponse') {
    schema = materializeDeclineProposalsResponseBranches(schema);
  }

  if (schemaName === 'GetMediaBuyDeliveryResponse') {
    return isolateGetMediaBuyDeliveryCompatBreakdowns(schema);
  }

  if (schemaName === 'GetMediaBuysResponse') {
    const item = schema.properties?.media_buys?.items;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const cleanedItem = {
        ...removeRequiredFields(item, ['confirmed_at', 'revision']),
        title: item.title || 'GetMediaBuysResponseMediaBuy',
      };
      // Item-level if/then guards cannot be expressed by the TS emitter. If
      // one appears beside structural allOf members, jsts emits `& unknown`
      // and drops the MediaBuy fields entirely. Remove only the conditional
      // members; keep the structural members (including indicator overlays).
      // Ajv continues to validate the untouched source schema at runtime.
      if (Array.isArray(cleanedItem.allOf)) {
        // The item already carries the complete MediaBuy property set at its
        // root. Fold direct structural overlays (currently indicators) into
        // that root, then remove allOf so nested conditionals inside the
        // duplicated MediaBuy member cannot make jsts discard the base type.
        const structuralProperties = cleanedItem.allOf.reduce(
          (properties: Record<string, unknown>, member: any) => ({
            ...properties,
            ...(member && typeof member === 'object' && !Array.isArray(member) ? member.properties : undefined),
          }),
          {}
        );
        cleanedItem.properties = { ...cleanedItem.properties, ...structuralProperties };
        delete cleanedItem.allOf;
      }
      const packageItems = cleanedItem.properties?.packages?.items;
      if (packageItems && typeof packageItems === 'object' && !Array.isArray(packageItems)) {
        // PackageStatus already declares its complete public field set at the
        // root. Its allOf/dependencies members are runtime-only validation
        // overlays; leaving them in lets jsts emit only the indicator fields.
        const packageStructuralProperties = (packageItems.allOf ?? []).reduce(
          (properties: Record<string, unknown>, member: any) => ({
            ...properties,
            ...(member && typeof member === 'object' && !Array.isArray(member) ? member.properties : undefined),
          }),
          {}
        );
        const cleanedPackageItems = {
          ...packageItems,
          properties: { ...packageItems.properties, ...packageStructuralProperties },
        };
        for (const keyword of ['allOf', 'dependencies', 'not', 'if', 'then', 'else']) {
          delete cleanedPackageItems[keyword];
        }
        cleanedItem.properties.packages = {
          ...cleanedItem.properties.packages,
          items: cleanedPackageItems,
        };
      }
      return {
        ...schema,
        properties: {
          ...schema.properties,
          media_buys: {
            ...schema.properties.media_buys,
            items: cleanedItem,
          },
        },
      };
    }
  }

  return schema;
}

function materializeDeclineProposalsResponseBranches(schema: any): any {
  if (!schema?.properties || !Array.isArray(schema.anyOf) || schema.anyOf.length !== 2) return schema;

  const branches: any[] = [];
  for (const member of schema.anyOf) {
    let overlay = member;
    if (typeof member?.$ref === 'string') {
      overlay = loadCachedSchema(member.$ref);
      if (!overlay?.properties) return schema;
    }
    const branch = {
      type: 'object',
      properties: { ...schema.properties, ...(overlay.properties ?? {}) },
      required: [...new Set([...(schema.required ?? []), ...(overlay.required ?? [])])],
      additionalProperties: schema.additionalProperties ?? false,
    };
    branches.push(branch);
  }

  const result = { ...schema, oneOf: branches };
  delete result.type;
  delete result.properties;
  delete result.required;
  delete result.anyOf;
  delete result.additionalProperties;
  return result;
}

/**
 * json-schema-to-typescript rejects a document containing both draft-07
 * `definitions` and modern `$defs`. Protocol bundles can legitimately contain
 * both after dereferencing. Merge the disjoint maps for the emit-only copy and
 * update local pointers; runtime validation continues to use the untouched
 * signed schema.
 */
export function coalesceDefinitionKeywords(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (!schema.definitions || !schema.$defs) return schema;

  const collisions = Object.keys(schema.definitions).filter(name => name in schema.$defs);
  if (collisions.length > 0) {
    throw new Error(`Cannot merge definitions and $defs with duplicate names: ${collisions.join(', ')}`);
  }

  schema.$defs = { ...schema.definitions, ...schema.$defs };
  delete schema.definitions;

  const rewritePointers = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(rewritePointers);
      return;
    }
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/definitions/')) {
      value.$ref = `#/$defs/${value.$ref.slice('#/definitions/'.length)}`;
    }
    Object.values(value).forEach(rewritePointers);
  };
  rewritePointers(schema);
  return schema;
}

// Load official AdCP tools from cached schema index
function loadOfficialAdCPToolsWithTypes(): {
  mediaBuyTools: string[];
  creativeTools: string[];
  signalsTools: string[];
  governanceTools: string[];
  sponsoredIntelligenceTools: string[];
  protocolTools: string[];
  accountTools: string[];
} {
  try {
    console.log('📥 Loading official AdCP tools from cached schema index...');
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');

    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }

    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    const mediaBuyTools: string[] = [];
    const creativeTools: string[] = [];
    const signalsTools: string[] = [];
    const governanceTools: string[] = [];
    const sponsoredIntelligenceTools: string[] = [];
    const protocolTools: string[] = [];
    const accountTools: string[] = [];
    const complianceTools: string[] = [];

    // Extract tools from each domain's tasks (skipping deprecated tools)
    const extractToolsFromDomain = (domain: string, targetArray: string[]) => {
      const tasks = schemaIndex.schemas?.[domain]?.tasks;
      if (tasks) {
        for (const taskName of Object.keys(tasks)) {
          // Convert kebab-case to snake_case (e.g., "get-products" -> "get_products")
          const toolName = taskName.replace(/-/g, '_');

          // Skip deprecated tools
          if (DEPRECATED_TOOLS.has(toolName)) {
            console.log(`   ⏭️  Skipping deprecated tool: ${toolName}`);
            continue;
          }

          // Also skip if the task is explicitly marked deprecated in the schema
          const task = tasks[taskName];
          if (task.deprecated) {
            console.log(`   ⏭️  Skipping deprecated tool: ${toolName} (marked in schema)`);
            continue;
          }

          targetArray.push(toolName);
        }
      }
    };

    extractToolsFromDomain('media-buy', mediaBuyTools);
    extractToolsFromDomain('creative', creativeTools);
    extractToolsFromDomain('signals', signalsTools);
    extractToolsFromDomain('governance', governanceTools);
    extractToolsFromDomain('sponsored-intelligence', sponsoredIntelligenceTools);
    extractToolsFromDomain('protocol', protocolTools);
    extractToolsFromDomain('account', accountTools);
    extractToolsFromDomain('compliance', complianceTools);

    const totalTools =
      mediaBuyTools.length +
      creativeTools.length +
      signalsTools.length +
      governanceTools.length +
      sponsoredIntelligenceTools.length +
      protocolTools.length +
      accountTools.length +
      complianceTools.length;

    console.log(`✅ Discovered ${totalTools} official AdCP tools:`);
    console.log(`   📈 Media-buy tools: ${mediaBuyTools.join(', ')}`);
    console.log(`   🎨 Creative tools: ${creativeTools.join(', ')}`);
    console.log(`   🎯 Signals tools: ${signalsTools.join(', ')}`);
    console.log(`   🏛️  Governance tools: ${governanceTools.join(', ')}`);
    console.log(`   💬 Sponsored Intelligence tools: ${sponsoredIntelligenceTools.join(', ')}`);
    console.log(`   🔧 Protocol tools: ${protocolTools.join(', ')}`);
    console.log(`   💳 Account tools: ${accountTools.join(', ')}`);
    console.log(`   🧪 Compliance tools: ${complianceTools.join(', ')}`);

    return {
      mediaBuyTools,
      creativeTools,
      signalsTools,
      governanceTools,
      sponsoredIntelligenceTools,
      protocolTools,
      accountTools,
      complianceTools,
    };
  } catch (error) {
    console.warn(`⚠️  Failed to load cached tools, falling back to known tools:`, error.message);
    // Fallback to known tools if the cache fails
    return {
      mediaBuyTools: ['get_products', 'list_creative_formats', 'create_media_buy', 'sync_creatives', 'list_creatives'],
      creativeTools: [],
      signalsTools: [],
      governanceTools: [],
      sponsoredIntelligenceTools: [],
      protocolTools: [],
      accountTools: [],
      complianceTools: [],
    };
  }
}

// Load tool definitions from cached schemas
function loadAdCPTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const processedTools = new Set<string>();

  // Get the official tools list from cached schema index
  const {
    mediaBuyTools,
    creativeTools,
    signalsTools,
    governanceTools,
    sponsoredIntelligenceTools,
    protocolTools,
    accountTools,
    complianceTools,
  } = loadOfficialAdCPToolsWithTypes();

  // Helper to process tools from a domain
  const processToolsFromDomain = (
    toolNames: string[],
    domain:
      | 'media-buy'
      | 'creative'
      | 'signals'
      | 'governance'
      | 'sponsored-intelligence'
      | 'protocol'
      | 'account'
      | 'compliance',
    domainLabel: string,
    singleAgentOnlyTools: string[] = []
  ) => {
    for (const toolName of toolNames) {
      if (processedTools.has(toolName)) {
        console.log(`⏭️  Skipping ${toolName} - already processed`);
        continue;
      }

      const schema = loadToolSchema(toolName, domain as any);
      if (schema) {
        // Convert snake_case to camelCase for method names
        const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

        // Determine single-agent-only tools (transactional operations)
        const singleAgentOnly = singleAgentOnlyTools.includes(toolName);

        tools.push({
          name: toolName,
          methodName,
          description: schema.description || `Execute ${toolName} operation`,
          paramsSchema: schema.properties?.request || {},
          responseSchema: schema.properties?.response || {},
          singleAgentOnly,
        });

        processedTools.add(toolName);
        console.log(`✅ Loaded ${toolName} from cached ${domainLabel} schema`);
      } else {
        console.warn(`⚠️  Skipping ${toolName} - no schema available`);
      }
    }
  };

  // Process all domains
  processToolsFromDomain(mediaBuyTools, 'media-buy', 'media-buy', ['create_media_buy', 'update_media_buy']);
  processToolsFromDomain(creativeTools, 'creative', 'creative');
  processToolsFromDomain(signalsTools, 'signals', 'signals');
  processToolsFromDomain(governanceTools, 'governance', 'governance', [
    'create_property_list',
    'update_property_list',
    'delete_property_list',
    'create_content_standards',
    'update_content_standards',
  ]);
  processToolsFromDomain(sponsoredIntelligenceTools, 'sponsored-intelligence', 'sponsored-intelligence', [
    'si_initiate_session',
    'si_terminate_session',
  ]);
  processToolsFromDomain(protocolTools, 'protocol', 'protocol');
  processToolsFromDomain(accountTools, 'account', 'account');
  processToolsFromDomain(complianceTools, 'compliance', 'compliance');

  return tools;
}

// Load tool schema from any domain
function loadToolSchemaFromDomain(
  toolName: string,
  domain: string,
  schemaIndex: any
): { paramsSchema: any; responseSchema: any } | null {
  const kebabName = toolName.replace(/_/g, '-');

  const task = schemaIndex.schemas?.[domain]?.tasks?.[kebabName];
  if (!task) return null;

  const requestRef = task.request?.$ref;
  const responseRef = task.response?.$ref;

  if (!requestRef || !responseRef) {
    console.warn(`⚠️  Missing refs for ${toolName} in ${domain}`);
    return null;
  }

  const requestSchema = loadCachedSchema(requestRef);
  const responseSchema = loadCachedSchema(responseRef);

  if (!requestSchema || !responseSchema) {
    return null;
  }

  return { paramsSchema: requestSchema, responseSchema };
}

// Load schema from cache by name
function loadCoreSchema(schemaName: string): any {
  try {
    // Read refs from the index.json instead of hardcoding paths
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

    // Look up the schema in the index to get actual $ref
    const schemaRef = schemaIndex.schemas?.core?.schemas?.[schemaName]?.$ref;
    if (!schemaRef) {
      throw new Error(`Schema ${schemaName} not found in index`);
    }

    return loadCachedSchema(schemaRef);
  } catch (error) {
    console.warn(`⚠️  Failed to load core schema ${schemaName}:`, error.message);
    return null;
  }
}

function stripCommentsAndStringLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/g, ' ');
}

function collectExportedTypeNames(typeDefinitions: string): Set<string> {
  const names = new Set<string>();
  const typePattern = /^export (?:type|interface) (\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(typeDefinitions)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function addCoreGeneratedTypeImports(typeDefinitions: string, typeNames: Iterable<string>): string {
  const importNames = new Set<string>();
  let body = typeDefinitions;
  const importPattern = /^import type \{([\s\S]*?)\} from ['"]\.\/core\.generated['"]; ?\n*/gm;

  body = body.replace(importPattern, (_match, imports: string) => {
    for (const name of imports.split(',')) {
      const trimmed = name.trim();
      if (trimmed) importNames.add(trimmed);
    }
    return '';
  });

  for (const name of typeNames) {
    importNames.add(name);
  }

  if (importNames.size === 0) return body;

  const sortedImports = [...importNames].sort();
  const importBlock = `import type {\n${sortedImports.map(name => `  ${name},`).join('\n')}\n} from './core.generated';\n\n`;
  return importBlock + body.trimStart();
}

function addReferencedCoreTypeImports(typeDefinitions: string, coreTypeNames: Set<string>): string {
  if (coreTypeNames.size === 0) return typeDefinitions;

  const locallyDeclaredTypes = collectExportedTypeNames(typeDefinitions);
  const searchable = stripCommentsAndStringLiterals(typeDefinitions);
  const referencedCoreTypes = [...coreTypeNames].filter(name => {
    if (locallyDeclaredTypes.has(name)) return false;
    return new RegExp(`\\b${name}\\b`).test(searchable);
  });

  return addCoreGeneratedTypeImports(typeDefinitions, referencedCoreTypes);
}

function addCoreGeneratedTypeReExports(typeDefinitions: string, typeNames: Iterable<string>): string {
  const reExportNames = [...new Set(typeNames)].sort();
  if (reExportNames.length === 0) return typeDefinitions;

  const exportStatement = `export type { ${reExportNames.join(', ')} } from './core.generated';`;
  if (typeDefinitions.includes(exportStatement)) return typeDefinitions;

  const importPattern = /^import type \{[\s\S]*?\} from ['"]\.\/core\.generated['"]; ?\n*/m;
  const importMatch = typeDefinitions.match(importPattern);
  if (importMatch?.[0]) {
    return typeDefinitions.replace(importPattern, `${importMatch[0]}${exportStatement}\n\n`);
  }

  return `${exportStatement}\n\n${typeDefinitions}`;
}

function addBackwardCompatTypeAliases(typeDefinitions: string): string {
  let output = typeDefinitions;
  for (const { oldName, newName, reason } of BACKWARD_COMPAT_TYPE_ALIASES) {
    if (new RegExp(`^export (?:type|interface) ${oldName}\\b`, 'm').test(output)) continue;
    const declaration = new RegExp(`(export type ${newName} =[\\s\\S]*?;\\n)`, 'm');
    const alias = `/** @deprecated ${reason} */\nexport type ${oldName} = ${newName};\n`;
    if (declaration.test(output)) {
      output = output.replace(declaration, `$1${alias}`);
      continue;
    }
    if (new RegExp(`^export interface ${newName}\\b`, 'm').test(output)) {
      output += `\n${alias}`;
    }
  }
  return output;
}

function hardenTrustedMatchGeneratedTypes(typeDefinitions: string): string {
  let output = typeDefinitions;

  for (const interfaceName of ['IdentityMatchResponseRouterPublisher', 'IdentityMatchResponseProviderRouter']) {
    const start = output.indexOf(`export interface ${interfaceName} {`);
    if (start === -1) continue;
    const end = output.indexOf('\nexport ', start + 1);
    if (end === -1) {
      throw new Error(`Unable to locate generated type boundary after ${interfaceName}.`);
    }
    const block = output.slice(start, end).replace(/^  context\?: ContextObject;\n/m, '');
    output = output.slice(0, start) + block + output.slice(end);
  }

  if (!/^export interface TmpxMacro\b/m.test(output)) {
    output += `
/**
 * @deprecated AdCP 3.1.10 replaced provider-authored macro names with provider-local TMPX slot IDs.
 * Retained for source compatibility with payloads captured before 3.1.10.
 */
export interface TmpxMacro {
  /**
   * @minLength 1
   * @maxLength 64
   * @pattern ^[A-Z][A-Z0-9_]*$
   */
  name: string;
  /**
   * @minLength 1
   * @maxLength 1024
   */
  value: string;
}
`;
  }

  return output;
}

function addCanonicalToolTypeAliases(typeDefinitions: string, tools: ToolDefinition[]): string {
  let output = typeDefinitions;
  const exportedTypes = collectExportedTypeNames(output);
  const aliases: string[] = [];

  const addAlias = (canonical: string) => {
    if (exportedTypes.has(canonical)) return;

    const candidates = [...exportedTypes].filter(name => new RegExp(`^${canonical}[A-Z]\\w+$`).test(name));
    if (candidates.length !== 1) return;

    aliases.push(`export type ${canonical} = ${candidates[0]};`);
    exportedTypes.add(canonical);
  };

  for (const tool of tools) {
    const baseName = methodNameToTypeName(tool.methodName);
    addAlias(`${baseName}Request`);
    addAlias(`${baseName}Response`);
  }

  if (aliases.length === 0) return output;

  output += `\n// Canonical tool aliases for schemas whose titles include domain qualifiers.\n${aliases.join('\n')}\n`;
  return output;
}

async function generateToolTypes(tools: ToolDefinition[], preGeneratedTypes: Set<string> = new Set()) {
  console.log('🔧 Generating tool parameter and response types...');

  let toolTypes = '// Tool Parameter and Response Types\n';
  toolTypes += '// Generated from official AdCP schemas\n\n';

  // Create custom $ref resolver for cached schemas
  const refResolver = {
    canRead: true,
    read: (file: { url: string }) => {
      const url = file.url;
      // Handle any /schemas/ path (versioned or v1)
      if (schemaRefToCacheRelativePath(url)) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema))));
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    },
  };

  // Track generated types to avoid duplicates. Some shared schemas are owned by
  // core.generated.ts but are reached through tool request/response $refs; seed
  // this set to keep those declarations out of tools.generated.ts.
  const generatedTypes = new Set<string>(preGeneratedTypes);
  const allGeneratedCode: string[] = [];

  for (const tool of tools) {
    try {
      // Generate parameter types
      if (tool.paramsSchema) {
        const paramTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request`;
        // Process schema: remove additionalProperties and minItems constraints
        const strictParamsSchema = enforceStrictSchema(
          removeArrayLengthConstraints(injectJsdocConstraints(tool.paramsSchema))
        );
        const paramTypes = await compile(strictParamsSchema, paramTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        const filteredParamTypes = filterDuplicateTypeDefinitions(paramTypes, generatedTypes);
        if (filteredParamTypes.trim()) {
          allGeneratedCode.push(`// ${tool.name} parameters\n${filteredParamTypes}`);
        }
      }

      // Generate response types
      if (tool.responseSchema) {
        const responseTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response`;
        // Process schema: remove additionalProperties and minItems constraints
        const strictResponseSchema = enforceStrictSchema(
          removeArrayLengthConstraints(injectJsdocConstraints(tool.responseSchema))
        );
        const responseTypes = await compile(strictResponseSchema, responseTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        const filteredResponseTypes = filterDuplicateTypeDefinitions(responseTypes, generatedTypes);
        if (filteredResponseTypes.trim()) {
          allGeneratedCode.push(`// ${tool.name} response\n${filteredResponseTypes}`);
        }
      }

      console.log(`✅ Generated types for ${tool.name}`);
    } catch (error) {
      console.error(`❌ Failed to generate types for ${tool.name}:`, error.message);
    }
  }

  toolTypes += allGeneratedCode.join('\n\n') + '\n';

  return toolTypes;
}

/**
 * Remove index signature types generated from oneOf schemas.
 *
 * json-schema-to-typescript generates types like:
 *   export type Foo = Foo1 & Foo2;
 *   export type Foo2 = { [k: string]: unknown };
 *
 * When the JSON Schema has additionalProperties: false but uses oneOf with only
 * required constraints, the library incorrectly creates an index signature type.
 *
 * This function:
 * 1. Identifies types that are pure index signatures: { [k: string]: unknown }
 * 2. Removes those type definitions
 * 3. Removes references to them from intersection types (Foo1 & Foo2 becomes Foo1)
 * 4. Cleans up inline index signature objects in intersection types
 */
function removeIndexSignatureTypes(typeDefinitions: string): string {
  // Find all types that are pure index signatures
  // Pattern: export type TypeName = { [k: string]: unknown };
  // or: export type TypeName = {\n  [k: string]: unknown;\n};
  const indexSigTypePattern = /export type (\w+) = \{\s*\[k: string\]: unknown;?\s*\};?/g;
  const indexSigTypes = new Set<string>();

  let match;
  while ((match = indexSigTypePattern.exec(typeDefinitions)) !== null) {
    indexSigTypes.add(match[1]);
  }

  let result = typeDefinitions;

  if (indexSigTypes.size > 0) {
    console.log(`🧹 Removing ${indexSigTypes.size} index signature types: ${Array.from(indexSigTypes).join(', ')}`);

    // Remove the index signature type definitions
    for (const typeName of indexSigTypes) {
      // Remove single-line pattern
      result = result.replace(
        new RegExp(`export type ${typeName} = \\{\\s*\\[k: string\\]: unknown;?\\s*\\};?\\n?`, 'g'),
        ''
      );
      // Remove multi-line pattern
      result = result.replace(
        new RegExp(`export type ${typeName} = \\{\\n\\s*\\[k: string\\]: unknown;\\n\\};?\\n?`, 'g'),
        ''
      );
    }

    // Remove references to these types from intersection types
    // Pattern: Type1 & IndexSigType becomes Type1
    // Pattern: IndexSigType & Type1 becomes Type1
    for (const typeName of indexSigTypes) {
      // Remove " & TypeName" (when it comes after)
      result = result.replace(new RegExp(` & ${typeName}(?=[;\\s])`, 'g'), '');
      // Remove "TypeName & " (when it comes before)
      result = result.replace(new RegExp(`${typeName} & `, 'g'), '');
    }
  }

  // Also remove inline index signature objects from intersections
  // Pattern: & {\n  [k: string]: unknown;\n}
  result = result.replace(/\s*&\s*\{\s*\[k:\s*string\]:\s*unknown;?\s*\}/gm, '');

  // Clean up malformed type aliases that end with semicolon followed by & (from incomplete removal)
  // Pattern: export type Foo = Bar;\n & {...} -> export type Foo = Bar;
  result = result.replace(/;\s*\n\s*&\s*\{[^}]*\}/gm, ';');

  // Clean up any remaining orphaned & at the start of lines
  result = result.replace(/;\s*\n\s*&/gm, ';');

  return result;
}

/**
 * Fix typed index signatures that are incompatible with optional properties.
 *
 * When a JSON Schema has typed additionalProperties (e.g. { $ref: "ForecastRange" })
 * alongside optional named properties, json-schema-to-typescript generates:
 *   grps?: ForecastRange;
 *   [k: string]: ForecastRange;
 *
 * TypeScript requires the index signature to be compatible with ALL named properties.
 * Optional properties are `Type | undefined`, so the index signature must also include
 * `| undefined`. This function detects such cases and adds `| undefined`.
 */
function fixTypedIndexSignatures(typeDefinitions: string): string {
  // Match typed index signatures (not `unknown`) that lack `| undefined`
  // Pattern: `[k: string]: SomeType;` where SomeType is NOT `unknown` and NOT already `| undefined`
  // NOTE: This regex only handles single-line type annotations. Multi-line unions,
  // array types (SomeType[]), and object types ({}) are not matched. Currently those
  // cases get | undefined from json-schema-to-typescript natively.
  return typeDefinitions.replace(
    /(\[k: string\]: )(\w[\w\s|&<>,]*?)(?<!\| undefined)(;\s*\n\s*\})/g,
    (match, prefix, type, suffix) => {
      // Only add | undefined if the type is not already `unknown`
      if (type.trim() === 'unknown') return match;
      return `${prefix}${type} | undefined${suffix}`;
    }
  );
}

const POSTAL_AREA_SUPPORT_INDEX_TYPE =
  "('zip' | 'zip_plus_four' | 'outward' | 'full' | 'fsa' | 'plz' | 'code_postal' | 'postcode' | 'cep' | 'pin' | 'postal_code' | 'custom')[]";

/**
 * AdCP 3.1.0-rc.10 models PostalAreaSupport with explicit country keys and
 * deprecated legacy boolean keys, plus a narrower catch-all for future country
 * keys. TypeScript index signatures apply to matching named properties, so the
 * generated uppercase-country catch-all is widened enough to include explicit
 * country fields without also allowing arbitrary lowercase boolean keys.
 * Runtime Zod generation restores the schema's propertyNames rule and narrower
 * catch-all.
 */
function widenPostalAreaSupportIndexSignature(typeDefinitions: string): string {
  return typeDefinitions.replace(
    /(export interface (?:ExternalCore1)?PostalAreaSupport \{[\s\S]*?\n)\s+\[k: string\]: (?:\['postal_code' \| 'custom', \.\.\.\('postal_code' \| 'custom'\)\[]\]|\('postal_code' \| 'custom'\)\[]) \| undefined;\n(\})/g,
    '$1  [country: `${Uppercase<string>}`]: ' + `${POSTAL_AREA_SUPPORT_INDEX_TYPE} | undefined;\n$2`
  );
}

/** Widen boolean feature maps for the one structured 3.2 capability value. */
function widenMediaBuyFeaturesIndexSignature(typeDefinitions: string): string {
  return typeDefinitions.replace(
    /(export interface (?:ExternalCore1)?(?:Canonical)?MediaBuyFeatures \{[\s\S]*?bidding_policy\?: (\w*BiddingPolicyCapability);[\s\S]*?)\[k: string\]: boolean \| undefined;/g,
    '$1[k: string]: boolean | $2 | undefined;'
  );
}

/**
 * The source ForecastRange oneOf only encodes required-field combinations;
 * both emitted branches are otherwise empty index signatures. Keeping that
 * redundant union makes TypeScript form an enormous cartesian product at use
 * sites. The optional fields remain exact here; runtime schemas retain the
 * low/high-or-mid invariant from the signed JSON Schema.
 */
function simplifyForecastRange(typeDefinitions: string): string {
  const start = typeDefinitions.indexOf('export type ForecastRange = ');
  if (start === -1) return typeDefinitions;
  const nextDeclaration = /\nexport (?:type|interface) \w+/g;
  nextDeclaration.lastIndex = start + 'export type ForecastRange = '.length;
  const nextMatch = nextDeclaration.exec(typeDefinitions);
  if (!nextMatch) throw new Error('simplifyForecastRange: unable to locate next type boundary');
  const end = nextMatch.index;
  const replacement = `export interface ForecastRange {
  /** Conservative (low-end) forecast value. */
  low?: number;
  /** Expected (most likely) forecast value. */
  mid?: number;
  /** Optimistic (high-end) forecast value. */
  high?: number;
  [k: string]: unknown | undefined;
}`;
  return typeDefinitions.slice(0, start) + replacement + typeDefinitions.slice(end);
}

function namePostalAreaCountryBranch(typeDefinitions: string): string {
  return typeDefinitions.replace(
    /(export interface )PostalArea1(\s*\{[\s\S]*?\n\})/,
    [
      '$1PostalCountryArea$2',
      '/**',
      ' * Re-export of `PostalCountryArea` under the legacy codegen artifact name.',
      ' *',
      ' * @deprecated Use `PostalCountryArea` from `@adcp/sdk/types`. Slated for removal in the next major.',
      ' */',
      'export type PostalArea1 = PostalCountryArea;',
    ].join('\n')
  );
}

/** Give get_products' business-rejection status a stable non-numbered name. */
function nameGetProductsRejectedStatus(typeDefinitions: string, required = false): string {
  const interfaces = [...typeDefinitions.matchAll(/export interface GetProductsRejected\s*\{[\s\S]*?\n\}/g)];
  if (interfaces.length === 0 && !required) return typeDefinitions;
  if (interfaces.length !== 1) {
    throw new Error(
      `nameGetProductsRejectedStatus: expected one GetProductsRejected interface, found ${interfaces.length}`
    );
  }

  const interfaceSource = interfaces[0][0];
  const statusProperties = [...interfaceSource.matchAll(/^(\s*status:\s*)(TaskStatus\d+)(\s*;\s*)$/gm)];
  if (statusProperties.length !== 1) {
    throw new Error(
      `nameGetProductsRejectedStatus: expected one numbered status property, found ${statusProperties.length}`
    );
  }

  const numberedName = statusProperties[0][2];
  if (numberedName !== 'TaskStatus2' && /\bTaskStatus2\b/.test(typeDefinitions)) {
    throw new Error(
      `nameGetProductsRejectedStatus: cannot preserve TaskStatus2 because it is already assigned while ` +
        `GetProductsRejected uses ${numberedName}`
    );
  }
  const declarationPattern = new RegExp(`^export type ${numberedName} = 'rejected';$`, 'gm');
  const declarations = [...typeDefinitions.matchAll(declarationPattern)];
  const references = typeDefinitions.match(new RegExp(`\\b${numberedName}\\b`, 'g')) ?? [];
  if (declarations.length !== 1 || references.length !== 2) {
    throw new Error(
      `nameGetProductsRejectedStatus: expected one declaration and two references for ${numberedName}, ` +
        `found ${declarations.length} and ${references.length}`
    );
  }

  const rewrittenInterface = interfaceSource.replace(
    statusProperties[0][0],
    `${statusProperties[0][1]}GetProductsRejectedStatus${statusProperties[0][3]}`
  );
  const stableDeclaration = [
    "export type GetProductsRejectedStatus = 'rejected';",
    '/**',
    ' * Re-export of `GetProductsRejectedStatus` under the legacy codegen artifact name.',
    ' *',
    ' * @deprecated Use `GetProductsRejectedStatus` from `@adcp/sdk/types`. Slated for removal in the next major.',
    ' */',
    'export type TaskStatus2 = GetProductsRejectedStatus;',
  ].join('\n');

  return typeDefinitions.replace(interfaceSource, rewrittenInterface).replace(declarationPattern, stableDeclaration);
}

/**
 * Align optional TypeScript properties with Zod .nullish() behavior.
 *
 * json-schema-to-typescript generates `property?: Type` (accepts undefined).
 * But the Zod schemas use .nullish() (accepts null | undefined) because real-world
 * JSON APIs send explicit null for absent optional fields.
 *
 * Without this alignment, server handlers that echo Zod-parsed input back
 * (e.g., params.context → response.context) hit type errors:
 *   Type 'X | null | undefined' is not assignable to type 'X | undefined'
 *
 * This converts `property?: Type` to `property?: Type | null` for consistency.
 */
function alignOptionalWithNullish(typeDefinitions: string): string {
  let result = typeDefinitions;

  // 1. Convert optional properties: `name?: Type` → `name?: Type | null`
  result = result.replace(/^(\s+\w+\?:\s*)(.+?)(;\s*)$/gm, (match, prefix, type, suffix) => {
    if (type.includes('| null')) return match;
    if (type.trim() === 'undefined') return match;
    return `${prefix}${type} | null${suffix}`;
  });

  // 2. Align index signatures with optional properties:
  //    `[k: string]: Type | undefined` → `[k: string]: Type | null | undefined`
  result = result.replace(/(\[k: string\]: )(.+?)( \| undefined)(;\s*)$/gm, (match, prefix, type, undef, suffix) => {
    if (type.includes('| null')) return match;
    return `${prefix}${type} | null${undef}${suffix}`;
  });

  return result;
}

// Remove numbered type duplicates like EventType1, Catalog1 that are identical to EventType, Catalog.
// The json-schema-to-typescript compiler appends numbers when it encounters the same $ref multiple
// times within a single compilation unit. We replace all references to the numbered variant with
// the canonical name and remove the duplicate definition.
function removeNumberedTypeDuplicatesOnce(
  typeDefinitions: string,
  skipWarnings: Set<string>
): { result: string; collapsed: Array<{ numbered: string; base: string }>; mismatched: string[] } {
  const typeBodyMap = new Map<string, string>();
  const numberedTypes: Array<{ numbered: string; base: string }> = [];
  const mismatched: string[] = [];

  // Match all export type/interface blocks.
  // Note: {[^}]*} stops at the first } so interfaces with nested objects (e.g. assets: {...})
  // get a truncated body. This means those interfaces will never match as duplicates — they are
  // silently skipped. In practice this is acceptable because the generated numbered duplicates
  // (SignalID1, EventType1, etc.) are all union types that use the =[^;]+; branch, which works
  // correctly. Interface duplicates with nested objects (e.g. CreativeManifest1) pre-exist in
  // the upstream generator output and are not regressed by this function.
  const typePattern = /^(export (?:type|interface) (\w+)(?:[^{=]*?)(?:\{[^}]*\}|=[^;]+;))/gm;
  let match;
  while ((match = typePattern.exec(typeDefinitions)) !== null) {
    const [, fullDef, name] = match;
    typeBodyMap.set(name, fullDef.replace(/\s+/g, ' ').trim());
  }

  for (const [name] of typeBodyMap) {
    const numberedMatch = name.match(/^(.+?)(\d+)$/);
    if (numberedMatch) {
      const [, base] = numberedMatch;
      if (typeBodyMap.has(base)) {
        const numberedBody = (typeBodyMap.get(name) ?? '').replace(new RegExp(`\\b${name}\\b`, 'g'), base);
        const baseBody = typeBodyMap.get(base) ?? '';
        if (numberedBody === baseBody) {
          numberedTypes.push({ numbered: name, base });
        } else {
          mismatched.push(name);
          if (!skipWarnings.has(name)) {
            console.warn(`⚠️  Skipping ${name}→${base}: body mismatch (may have nested object types)`);
            skipWarnings.add(name);
          }
        }
      }
    }
  }

  let result = typeDefinitions;
  for (const { numbered, base } of numberedTypes) {
    result = result.replace(new RegExp(`\\b${numbered}\\b`, 'g'), base);
  }

  return { result, collapsed: numberedTypes, mismatched };
}

export function removeNumberedTypeDuplicates(typeDefinitions: string): string {
  // Iterate: a first-pass mismatch is often caused by nested numbered references
  // (e.g. CatalogFieldMapping2 references ExtensionObject32; once ExtensionObject32
  // is collapsed to ExtensionObject, CatalogFieldMapping2's body matches the base).
  const skipWarnings = new Set<string>();
  let current = typeDefinitions;
  const allCollapsed: Array<{ numbered: string; base: string }> = [];
  for (let pass = 0; pass < 10; pass++) {
    const { result, collapsed } = removeNumberedTypeDuplicatesOnce(current, skipWarnings);
    if (collapsed.length === 0) break;
    allCollapsed.push(...collapsed);
    current = result;
  }

  if (allCollapsed.length === 0) return typeDefinitions;

  console.log(
    `🔢 Deduplicating ${allCollapsed.length} numbered type(s): ${allCollapsed.map(t => `${t.numbered}→${t.base}`).join(', ')}`
  );

  return filterDuplicateTypeDefinitions(current, new Set<string>());
}

function removeNumberedCoreTypeDuplicates(typeDefinitions: string, coreTypeNames: Set<string>): string {
  const locallyDeclaredTypes = collectExportedTypeNames(typeDefinitions);
  const numberedCoreTypes = [...locallyDeclaredTypes]
    .map(name => {
      const numberedMatch = name.match(/^(.+?)(\d+)$/);
      const base = numberedMatch?.[1];
      return base ? { numbered: name, base } : null;
    })
    .filter((entry): entry is { numbered: string; base: string } => entry !== null && coreTypeNames.has(entry.base));

  // Base-name duplicates must be removed even when this generation happens
  // not to contain a numbered sibling. Otherwise a bundled tool schema can
  // redeclare (and weaken) a priority canonical such as
  // `CanonicalFormatImage`, defeating the core-generated import.
  if (numberedCoreTypes.length === 0) {
    return filterDuplicateTypeDefinitions(typeDefinitions, new Set(coreTypeNames));
  }

  let result = typeDefinitions;
  for (const { numbered, base } of numberedCoreTypes) {
    result = result.replace(new RegExp(`\\b${numbered}\\b`, 'g'), base);
  }

  console.log(
    `🔢 Deduplicating ${numberedCoreTypes.length} numbered core type(s): ` +
      numberedCoreTypes.map(t => `${t.numbered}→${t.base}`).join(', ')
  );

  return filterDuplicateTypeDefinitions(result, new Set(coreTypeNames));
}

// Helper function to filter duplicate type definitions properly
export function filterDuplicateTypeDefinitions(typeDefinitions: string, generatedTypes: Set<string>): string {
  const lines = typeDefinitions.split('\n');
  const outputLines: string[] = [];
  let currentTypeDefinition: string[] = [];
  let currentTypeName: string | null = null;
  let insideTypeDefinition = false;
  // Track brace depth so we can detect when a non-indented `/**` is the start
  // of the next type's JSDoc rather than a comment inside the current type body.
  let braceDepth = 0;
  // Buffer JSDoc comment lines that precede a type definition so they can be
  // dropped together if the type turns out to be a duplicate.
  let pendingJsdoc: string[] = [];
  let insideJsdoc = false;

  function endCurrentType(): void {
    if (currentTypeName && !generatedTypes.has(currentTypeName)) {
      generatedTypes.add(currentTypeName);
      outputLines.push(...currentTypeDefinition);
    }
    currentTypeDefinition = [];
    currentTypeName = null;
    insideTypeDefinition = false;
    braceDepth = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a type/interface definition
    const typeMatch = line.match(/^export (?:type|interface) (\w+)/);

    if (typeMatch) {
      // If we were tracking a previous type, process it first
      if (currentTypeName && currentTypeDefinition.length > 0) {
        endCurrentType();
      }

      // Start tracking this new type, prepending any buffered JSDoc
      currentTypeName = typeMatch[1];
      insideTypeDefinition = true;
      insideJsdoc = false;
      braceDepth = 0;
      currentTypeDefinition = [...pendingJsdoc, line];
      pendingJsdoc = [];

      // Count braces on the opening line (e.g. `export interface Foo {`)
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
    } else if (insideTypeDefinition) {
      // Count brace depth so we know when we've left the type body
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }

      // A non-indented `/**` at brace depth 0 unambiguously starts the next
      // type's JSDoc — end the current type here rather than swallowing it.
      if (braceDepth === 0 && line === line.trimStart() && line.startsWith('/**')) {
        endCurrentType();
        // Begin buffering this JSDoc for the upcoming type
        pendingJsdoc = [line];
        insideJsdoc = true;
      } else {
        currentTypeDefinition.push(line);

        // Also end when the next line starts a new export or we hit a double blank
        const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
        if (nextLine.match(/^export /) || (line.trim() === '' && nextLine.trim() === '')) {
          endCurrentType();
        }
      }
    } else {
      // Outside a type definition — buffer JSDoc comment blocks so they travel
      // with the type that follows them rather than being emitted immediately.
      if (line.trimStart().startsWith('/**')) {
        // Start of a new JSDoc block; discard any previous orphaned pending block
        pendingJsdoc = [line];
        insideJsdoc = true;
      } else if (insideJsdoc) {
        pendingJsdoc.push(line);
        if (line.trimStart().startsWith('*/')) {
          insideJsdoc = false;
        }
      } else {
        // Flush any accumulated JSDoc that wasn't immediately followed by a type
        if (pendingJsdoc.length > 0) {
          outputLines.push(...pendingJsdoc);
          pendingJsdoc = [];
        }
        outputLines.push(line);
      }
    }
  }

  // Handle the last type definition if we were tracking one
  if (currentTypeName && currentTypeDefinition.length > 0) {
    if (!generatedTypes.has(currentTypeName)) {
      generatedTypes.add(currentTypeName);
      outputLines.push(...currentTypeDefinition);
    }
  }

  // Flush any trailing pending JSDoc
  if (pendingJsdoc.length > 0) {
    outputLines.push(...pendingJsdoc);
  }

  return outputLines.join('\n');
}

/**
 * Some `Foo1` artifacts survive `removeNumberedTypeDuplicates` because their bodies
 * are not byte-identical to `Foo` — `json-schema-to-typescript` under-resolves the
 * second compile pass on certain shapes, dropping properties or wrappers the first
 * pass preserved. Examples (AdCP 3.0.4):
 *
 *   VASTAsset      = { asset_type: 'vast'; …metadata… } & ({delivery_type:'url',url} | {delivery_type:'inline',content})
 *   VASTAsset1     = ({delivery_type:'url',url} | {delivery_type:'inline',content})           ← lost asset_type wrapper
 *
 *   BriefAsset     = CreativeBrief & { asset_type: 'brief' }
 *   BriefAsset1    = CreativeBrief                                                            ← lost asset_type discriminator
 *
 *   AssetVariant   = ImageAsset | … | VASTAsset | … | BriefAsset | CatalogAsset
 *   AssetVariant1  = ImageAsset | … | VASTAsset1 | … | BriefAsset1 | CatalogAsset1            ← references the under-resolved variants
 *
 * AdCP 3.1.0-rc.10 added the same pattern for repeated PostalArea references;
 * the country-area branch is first stabilized as `PostalCountryArea`, then the
 * repeated union wrappers are aliased to `PostalArea`.
 *
 * The spec converged these via `core/assets/asset-union.json` (adcp#3462) — both
 * `creative-asset.json` and `creative-manifest.json` `$ref` the same union. The
 * bundler inlines both occurrences though, so jsts sees two anonymous-but-identically-
 * titled shapes and emits Foo / Foo1.
 *
 * Rewriting each `Foo1` as `type Foo1 = Foo` is type-level safe: the bundled
 * response carries `asset_type` correctly at runtime; the under-resolved TS type
 * was strictly weaker than the wire format. The alias gives consumers the
 * correctly-discriminated shape; `@deprecated` JSDoc surfaces the canonical name.
 *
 * Tracked: adcp-client#1264.
 */
const JSTS_UNDER_RESOLUTION_ALIASES: Array<{ numbered: string; base: string }> = [
  { numbered: 'VASTAsset1', base: 'VASTAsset' },
  { numbered: 'DAASTAsset1', base: 'DAASTAsset' },
  { numbered: 'BriefAsset1', base: 'BriefAsset' },
  { numbered: 'CatalogAsset1', base: 'CatalogAsset' },
  { numbered: 'AssetVariant1', base: 'AssetVariant' },
  { numbered: 'CreativeAsset1', base: 'CreativeAsset' },
  { numbered: 'PackageSignalTargetingGroups1', base: 'PackageSignalTargetingGroups' },
  { numbered: 'PackageSignalTargetingGroup1', base: 'PackageSignalTargetingGroup' },
  { numbered: 'LegacyManifestNamedFormatReference1', base: 'LegacyManifestNamedFormatReference' },
  { numbered: 'ManifestCanonicalFormatKind1', base: 'ManifestCanonicalFormatKind' },
  { numbered: 'LegacyManifestNamedFormatReference2', base: 'LegacyManifestNamedFormatReference' },
  { numbered: 'ManifestCanonicalFormatKind2', base: 'ManifestCanonicalFormatKind' },
  { numbered: 'LegacyCreativeNamedFormatReference1', base: 'LegacyCreativeNamedFormatReference' },
  { numbered: 'CreativeCanonicalFormatKind1', base: 'CreativeCanonicalFormatKind' },
  { numbered: 'CreateMediaBuySubmitted1', base: 'CreateMediaBuySubmitted' },
  { numbered: 'PostalArea2', base: 'PostalArea' },
  { numbered: 'PostalArea4', base: 'PostalArea' },
  { numbered: 'PostalArea6', base: 'PostalArea' },
  { numbered: 'Property1', base: 'Property' },
  { numbered: 'Product1', base: 'Product' },
  { numbered: 'SizeModeMutex1', base: 'SizeModeMutex' },
  { numbered: 'SizeModeMutex2', base: 'SizeModeMutex' },
  { numbered: 'Fixed1', base: 'Fixed' },
  { numbered: 'Fixed2', base: 'Fixed' },
  { numbered: 'MultiSize1', base: 'MultiSize' },
  { numbered: 'MultiSize2', base: 'MultiSize' },
  { numbered: 'Responsive1', base: 'Responsive' },
  { numbered: 'Responsive2', base: 'Responsive' },
  { numbered: 'None1', base: 'None' },
  { numbered: 'None2', base: 'None' },
];

const JSTS_REPEATED_UNDER_RESOLUTION_BASES = [
  'VASTAsset',
  'DAASTAsset',
  'AssetVariant',
  // Constraint-bearing canonical roots compiled ahead of transitive users.
  // Referenced copies lose @pattern/minItems metadata in jsts; keep every
  // numbered occurrence identical to the authoritative public type.
  'BrandReference',
  'BusinessEntity',
  'PlatformExtensionReference',
  'DeliveryMetrics',
  'MeasurementTerms',
] as const;

function buildKnownJstsAliases(typeDefinitions: string): Array<{ numbered: string; base: string }> {
  const exportedTypes = collectExportedTypeNames(typeDefinitions);
  const aliases = new Map(JSTS_UNDER_RESOLUTION_ALIASES.map(alias => [alias.numbered, alias]));

  for (const base of JSTS_REPEATED_UNDER_RESOLUTION_BASES) {
    if (!exportedTypes.has(base)) continue;
    const numberedPattern = new RegExp(`^${base}(\\d+)$`);
    for (const name of exportedTypes) {
      const match = name.match(numberedPattern);
      if (!match || Number(match[1]) < 1) continue;
      aliases.set(name, { numbered: name, base });
    }
  }

  return [...aliases.values()];
}

export function applyKnownJstsAliases(typeDefinitions: string): string {
  const lines = typeDefinitions.split('\n');
  const aliases = buildKnownJstsAliases(typeDefinitions);
  const targetNames = new Set(aliases.map(a => a.numbered));
  const baseByNumbered = new Map(aliases.map(a => [a.numbered, a.base]));
  const aliasedNames = new Set<string>();

  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const typeMatch = line.match(/^export (?:type|interface) (\w+)\b/);

    if (!typeMatch || !targetNames.has(typeMatch[1])) {
      outputLines.push(line);
      i++;
      continue;
    }

    // Found a target — locate the end of the block (brace-balanced for
    // interfaces; first `;` at brace+paren depth 0 for unions/intersections/
    // aliases) BEFORE swallowing the leading JSDoc, so a defensive bail
    // (terminator not found) leaves the original prose intact.
    const numbered = typeMatch[1];
    const base = baseByNumbered.get(numbered)!;

    let braceDepth = 0;
    let parenDepth = 0;
    let endIdx = i;
    let foundTerminator = false;
    for (let j = i; j < lines.length; j++) {
      const cur = lines[j];
      for (const ch of cur) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      // Interface block: ends at the line that closes braceDepth back to 0.
      // Type alias block: first `;` at brace+paren depth 0 ends it. Skip lines
      // that are JSDoc continuations (`*`-prefixed) so a `;` inside a comment
      // doesn't terminate the block early.
      const trimmed = cur.trimStart();
      const isJsdocLine = trimmed.startsWith('*') || trimmed.startsWith('/*');
      if (line.startsWith('export interface')) {
        if (braceDepth === 0 && j > i) {
          endIdx = j;
          foundTerminator = true;
          break;
        }
      } else {
        if (!isJsdocLine && cur.includes(';') && braceDepth === 0 && parenDepth === 0) {
          endIdx = j;
          foundTerminator = true;
          break;
        }
      }
    }

    if (!foundTerminator) {
      // Defensive: if we can't find the end, leave the block intact
      outputLines.push(line);
      i++;
      continue;
    }

    // Now that we've confirmed we'll rewrite this block, swallow any preceding
    // JSDoc lines from outputLines so the new alias's JSDoc replaces them.
    while (
      outputLines.length > 0 &&
      (outputLines[outputLines.length - 1].trimStart().startsWith('*') ||
        outputLines[outputLines.length - 1].trimStart().startsWith('/**') ||
        outputLines[outputLines.length - 1].trim() === '')
    ) {
      outputLines.pop();
    }

    outputLines.push(
      '/**',
      ` * Re-export of \`${base}\` under the legacy codegen artifact name.`,
      ' *',
      ` * \`${numbered}\` is a json-schema-to-typescript under-resolution artifact —`,
      ` * the bundler inlined the same schema at two call sites and jsts emitted a numbered`,
      ` * sibling. The body it produced was strictly weaker than \`${base}\` (missing the`,
      ` * discriminator, canonical wrapper, or named union); aliasing to \`${base}\``,
      ' * gives consumers the correctly-discriminated shape that matches the wire format.',
      ' *',
      ` * @deprecated Use \`${base}\` from \`@adcp/sdk/types\`. Slated for removal in the next major.`,
      ' */',
      `export type ${numbered} = ${base};`
    );
    aliasedNames.add(numbered);
    i = endIdx + 1;
  }

  if (aliasedNames.size > 0) {
    console.log(
      `🔀 Aliased ${aliasedNames.size} jsts under-resolution artifact(s): ${[...aliasedNames]
        .map(n => `${n}→${baseByNumbered.get(n)}`)
        .join(', ')}`
    );
  }

  return outputLines.join('\n');
}

/**
 * Format-side asset slot types (`IndividualImageAsset`, `IndividualVideoAsset`,
 * etc.) collapse to bare `BaseIndividualAsset` aliases under
 * `json-schema-to-typescript`. The schema spec uses
 * `allOf: [{$ref: baseIndividualAsset}]` plus extra `properties` (notably
 * `asset_type: { const: "<type>" }` and `requirements: {$ref: ...}`); jsts's
 * union resolver flattens to the base shape and drops the discriminator.
 *
 * The wire schema requires `asset_type` on every individual asset entry —
 * adopters writing TS-clean code that constructs an `IndividualImageAsset`
 * literal without `asset_type` get a runtime `VALIDATION_ERROR` against the
 * spec. We post-process the generated aliases into discriminated intersections
 * so TS catches the missing field at compile time.
 *
 * Tracked: adcp-client#1498.
 */
const INDIVIDUAL_ASSET_DISCRIMINATORS: Array<{ name: string; assetType: string; requirementsType?: string }> = [
  { name: 'IndividualImageAsset', assetType: 'image', requirementsType: 'ImageAssetRequirements' },
  { name: 'IndividualVideoAsset', assetType: 'video', requirementsType: 'VideoAssetRequirements' },
  { name: 'IndividualAudioAsset', assetType: 'audio', requirementsType: 'AudioAssetRequirements' },
  { name: 'IndividualTextAsset', assetType: 'text', requirementsType: 'TextAssetRequirements' },
  { name: 'IndividualMarkdownAsset', assetType: 'markdown', requirementsType: 'MarkdownAssetRequirements' },
  { name: 'IndividualHtmlAsset', assetType: 'html', requirementsType: 'HTMLAssetRequirements' },
  { name: 'IndividualCssAsset', assetType: 'css', requirementsType: 'CSSAssetRequirements' },
  { name: 'IndividualJavaScriptAsset', assetType: 'javascript', requirementsType: 'JavaScriptAssetRequirements' },
  { name: 'IndividualVastAsset', assetType: 'vast', requirementsType: 'VASTAssetRequirements' },
  { name: 'IndividualDaastAsset', assetType: 'daast', requirementsType: 'DAASTAssetRequirements' },
  { name: 'IndividualUrlAsset', assetType: 'url', requirementsType: 'URLAssetRequirements' },
  { name: 'IndividualWebhookAsset', assetType: 'webhook', requirementsType: 'WebhookAssetRequirements' },
  { name: 'IndividualBriefAsset', assetType: 'brief' },
  { name: 'IndividualCatalogAsset', assetType: 'catalog' },
];

const GROUP_ASSET_DISCRIMINATORS: Array<{ name: string; assetType: string; requirementsType: string }> = [
  { name: 'GroupImageAsset', assetType: 'image', requirementsType: 'ImageAssetRequirements' },
  { name: 'GroupVideoAsset', assetType: 'video', requirementsType: 'VideoAssetRequirements' },
  { name: 'GroupAudioAsset', assetType: 'audio', requirementsType: 'AudioAssetRequirements' },
  { name: 'GroupTextAsset', assetType: 'text', requirementsType: 'TextAssetRequirements' },
  { name: 'GroupMarkdownAsset', assetType: 'markdown', requirementsType: 'MarkdownAssetRequirements' },
  { name: 'GroupHtmlAsset', assetType: 'html', requirementsType: 'HTMLAssetRequirements' },
  { name: 'GroupCssAsset', assetType: 'css', requirementsType: 'CSSAssetRequirements' },
  { name: 'GroupJavaScriptAsset', assetType: 'javascript', requirementsType: 'JavaScriptAssetRequirements' },
  { name: 'GroupVastAsset', assetType: 'vast', requirementsType: 'VASTAssetRequirements' },
  { name: 'GroupDaastAsset', assetType: 'daast', requirementsType: 'DAASTAssetRequirements' },
  { name: 'GroupUrlAsset', assetType: 'url', requirementsType: 'URLAssetRequirements' },
  { name: 'GroupWebhookAsset', assetType: 'webhook', requirementsType: 'WebhookAssetRequirements' },
];

export function applyIndividualAssetDiscriminators(typeDefinitions: string): string {
  let result = typeDefinitions;
  let rewritten = 0;
  // The *AssetRequirements interfaces are declared in core.generated.ts. When this
  // post-processor runs against tools.generated.ts, those interfaces aren't local —
  // we inject an import so `requirements?: ImageAssetRequirements` references resolve
  // and TS + ts-to-zod (and downstream Format.assets[] consumers) see the full shape.
  const requirementsLocallyDeclared = /^export (interface|type) ImageAssetRequirements\b/m.test(result);
  const importedRequirementsTypes: string[] = [];

  for (const entry of INDIVIDUAL_ASSET_DISCRIMINATORS) {
    const aliasPattern = new RegExp(`^export type ${entry.name} = BaseIndividualAsset;$`, 'm');
    if (!aliasPattern.test(result)) continue;
    const reqsAvailable = entry.requirementsType !== undefined;
    const reqsField = reqsAvailable ? `\n  requirements?: ${entry.requirementsType};` : '';
    const replacement = `export type ${entry.name} = BaseIndividualAsset & {\n  asset_type: '${entry.assetType}';${reqsField}\n};`;
    result = result.replace(aliasPattern, replacement);
    rewritten++;
    if (reqsAvailable && !requirementsLocallyDeclared && entry.requirementsType) {
      importedRequirementsTypes.push(entry.requirementsType);
    }
  }

  for (const entry of GROUP_ASSET_DISCRIMINATORS) {
    const aliasPattern = new RegExp(`^export type ${entry.name} = BaseGroupAsset;$`, 'm');
    if (!aliasPattern.test(result)) continue;
    const replacement = `export type ${entry.name} = BaseGroupAsset & {\n  asset_type: '${entry.assetType}';\n  requirements?: ${entry.requirementsType};\n};`;
    result = result.replace(aliasPattern, replacement);
    rewritten++;
    if (!requirementsLocallyDeclared) {
      importedRequirementsTypes.push(entry.requirementsType);
    }
  }

  if (importedRequirementsTypes.length > 0) {
    result = addCoreGeneratedTypeImports(result, importedRequirementsTypes);
  }

  // Emit named union aliases for the slot shapes so ts-to-zod produces named
  // schemas (IndividualAssetSlotSchema, FormatAssetSlotSchema) and consumers
  // can import the unions directly. Only emit when the constituent types are
  // present in this file — keeps the post-processor a no-op on unrelated files.
  const allIndividualPresent = INDIVIDUAL_ASSET_DISCRIMINATORS.every(entry =>
    new RegExp(`^export type ${entry.name} = BaseIndividualAsset & \\{`, 'm').test(result)
  );
  const repeatableGroupPresent = /^export interface RepeatableGroupAsset \{/m.test(result);

  if (allIndividualPresent && repeatableGroupPresent && !/^export type IndividualAssetSlot\b/m.test(result)) {
    const slotUnion = [
      `export type IndividualAssetSlot =`,
      ...INDIVIDUAL_ASSET_DISCRIMINATORS.map((entry, i) => {
        const tail = i === INDIVIDUAL_ASSET_DISCRIMINATORS.length - 1 ? ';' : '';
        return `  | ${entry.name}${tail}`;
      }),
      ``,
      `export type GroupAssetSlot =`,
      ...GROUP_ASSET_DISCRIMINATORS.map((entry, i) => {
        const tail = i === GROUP_ASSET_DISCRIMINATORS.length - 1 ? ';' : '';
        return `  | ${entry.name}${tail}`;
      }),
      ``,
      `export type FormatAssetSlot = IndividualAssetSlot | RepeatableGroupAsset;`,
      ``,
    ].join('\n');
    result = result.trimEnd() + '\n\n' + slotUnion;

    // Tighten Format.assets[] from the inline anonymous union to the named
    // FormatAssetSlot[]. The codegen emits the inline union right after the
    // 'Array of all assets supported for this format.' comment. If jsts ever
    // changes its emitted indentation/wrapping the regex silently no-ops, so
    // we count replacements and warn loudly — Format.assets[] would otherwise
    // fall back to the loose anonymous union without TS surfacing it.
    const formatAssetsPattern = new RegExp(
      `(  assets\\?: )\\(\\s*(?:\\|\\s*Individual\\w+Asset\\s*)+\\|\\s*RepeatableGroupAsset\\s*\\)\\[\\];`,
      'g'
    );
    let formatAssetsReplaced = 0;
    result = result.replace(formatAssetsPattern, (_match, prefix) => {
      formatAssetsReplaced++;
      return `${prefix}FormatAssetSlot[];`;
    });
    if (formatAssetsReplaced === 0) {
      console.warn(
        '⚠️  applyIndividualAssetDiscriminators: Format.assets[] inline union not rewritten — jsts output layout may have changed'
      );
    }

    // Same for RepeatableGroupAsset.assets[] — replace the inline group union with GroupAssetSlot[].
    const groupAssetsPattern = new RegExp(`(  assets: )\\(\\s*(?:\\|\\s*Group\\w+Asset\\s*)+\\)\\[\\];`, 'g');
    let groupAssetsReplaced = 0;
    result = result.replace(groupAssetsPattern, (_match, prefix) => {
      groupAssetsReplaced++;
      return `${prefix}GroupAssetSlot[];`;
    });
    if (groupAssetsReplaced === 0) {
      console.warn(
        '⚠️  applyIndividualAssetDiscriminators: RepeatableGroupAsset.assets[] inline union not rewritten — jsts output layout may have changed'
      );
    }
  }

  if (rewritten > 0) {
    console.log(`🔀 Restored asset_type discriminator on ${rewritten} Individual*Asset alias(es)`);
  }
  return result;
}

/**
 * Convert method name to proper type name, preserving acronyms.
 * Examples:
 *   siGetOffering -> SIGetOffering
 *   getAdcpCapabilities -> GetAdCPCapabilities
 *   createMediaBuy -> CreateMediaBuy
 */
function methodNameToTypeName(methodName: string): string {
  // Known acronyms to preserve
  const acronymReplacements: [RegExp, string][] = [
    [/^si([A-Z])/i, 'SI$1'], // siGetOffering -> SIGetOffering
    [/Adcp/g, 'AdCP'], // getAdcpCapabilities -> getAdCPCapabilities
  ];

  let typeName = methodName.charAt(0).toUpperCase() + methodName.slice(1);

  for (const [pattern, replacement] of acronymReplacements) {
    typeName = typeName.replace(pattern, replacement);
  }

  return typeName;
}

/**
 * Determine whether a tool's request requires `idempotency_key`.
 *
 * Mirrors `deriveMutatingTasks()` in src/lib/utils/idempotency.ts: a tool is
 * "mutating" when its request schema has `idempotency_key` in the top-level
 * `required` array. `si_terminate_session` is excluded by name — it's naturally
 * idempotent via session_id, so its signature stays strict.
 */
function isMutatingTool(tool: ToolDefinition): boolean {
  if (tool.name === 'si_terminate_session') return false;
  const required = tool.paramsSchema?.required;
  return Array.isArray(required) && required.includes('idempotency_key');
}

function generateAgentClasses(tools: ToolDefinition[]) {
  console.log('🔧 Generating Agent and AgentCollection classes...');

  // Generate imports for tool types
  const paramImports = tools
    .map(tool => {
      const baseName = methodNameToTypeName(tool.methodName);
      const paramType = `${baseName}Request`;
      const responseType = `${baseName}Response`;
      return [paramType, responseType];
    })
    .flat();

  let agentClass = `// Generated Agent Classes
// Auto-generated from AdCP tool definitions

import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import { validateAgentUrl } from '../validation';
import { getCircuitBreaker, unwrapProtocolResponse } from '../utils';
import type { MutatingRequestInput } from '../utils/idempotency';
import type {
  ${paramImports.join(',\n  ')}
} from '../types/tools.generated';

/**
 * Single agent operations with full type safety
 *
 * Returns raw AdCP responses matching schema exactly.
 * No SDK wrapping - responses follow AdCP discriminated union patterns.
 *
 * @deprecated Use \`SingleAgentClient\` / \`AgentClient\` / \`ADCPMultiAgentClient\`
 * from \`@adcp/sdk\` instead. The \`Agent\` class predates Stage 3's per-instance
 * \`adcpVersion\` plumbing — it always emits the SDK-pinned \`ADCP_MAJOR_VERSION\`
 * on the wire regardless of caller pin, which silently drifts from a buyer
 * who pins a non-default version. The conversation-aware clients honor the
 * per-instance pin end-to-end (validators, wire field, capability check).
 */
let _agentDeprecationWarned = false;

export class Agent {
  constructor(
    private config: AgentConfig,
    private client: any // Will be AdCPClient
  ) {
    if (!_agentDeprecationWarned) {
      // Flag is set only after a successful emitWarning so a runtime that
      // throws on the first call (monkey-patched test harness, polyfilled
      // worker) still surfaces the deprecation on a later construction.
      try {
        process.emitWarning(
          'Agent class is deprecated. Use SingleAgentClient / AgentClient / ADCPMultiAgentClient from @adcp/sdk; ' +
            'Agent does not honor per-instance adcpVersion pins (always emits the SDK default major).',
          'DeprecationWarning'
        );
        _agentDeprecationWarned = true;
      } catch {
        // emitWarning is best-effort observability; never fatal.
      }
    }
  }

  private async callTool<T>(toolName: string, params: any): Promise<T> {
    const debugLogs: any[] = [];

    try {
      validateAgentUrl(this.config.agent_uri);

      const circuitBreaker = getCircuitBreaker(this.config.id);
      const protocolResponse = await circuitBreaker.call(async () => {
        return await ProtocolClient.callTool(this.config, toolName, params, { debugLogs });
      });

      // Unwrap and validate protocol response using tool-specific Zod schema
      const adcpResponse = unwrapProtocolResponse(protocolResponse, toolName, this.config.protocol);

      return adcpResponse as T;
    } catch (error) {
      // Convert exceptions to AdCP error format
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        errors: [{
          code: 'client_error',
          message: errorMessage
        }]
      } as T;
    }
  }

`;

  // Generate typed methods for each tool
  for (const tool of tools) {
    const baseName = methodNameToTypeName(tool.methodName);
    const paramType = tool.paramsSchema ? `${baseName}Request` : 'void';
    const responseType = tool.responseSchema ? `${baseName}Response` : 'any';
    const paramTypeAnnotation =
      paramType === 'void' ? paramType : isMutatingTool(tool) ? `MutatingRequestInput<${paramType}>` : paramType;
    const paramDecl = paramType === 'void' ? '' : `params: ${paramTypeAnnotation}`;

    agentClass += `  /**
   * ${tool.description}
   */
  async ${tool.methodName}(${paramDecl}): Promise<${responseType}> {
    return this.callTool<${responseType}>('${tool.name}', ${paramType === 'void' ? '{}' : 'params'});
  }

`;
  }

  agentClass += `}

/**
 * Multi-agent operations with full type safety
 */
export class AgentCollection {
  constructor(
    private configs: AgentConfig[],
    private client: any // Will be AdCPClient
  ) {}

  private async callToolOnAll<T>(toolName: string, params: any): Promise<T[]> {
    const agents = this.configs.map(config => new Agent(config, this.client));
    const promises = agents.map(agent => (agent as any).callTool(toolName, params));
    return Promise.all(promises);
  }

`;

  // Generate typed methods for multi-agent operations (excluding single-agent-only tools)
  for (const tool of tools) {
    if (tool.singleAgentOnly) continue;

    const baseName = methodNameToTypeName(tool.methodName);
    const paramType = tool.paramsSchema ? `${baseName}Request` : 'void';
    const responseType = tool.responseSchema ? `${baseName}Response` : 'any';
    const paramTypeAnnotation =
      paramType === 'void' ? paramType : isMutatingTool(tool) ? `MutatingRequestInput<${paramType}>` : paramType;
    const paramDecl = paramType === 'void' ? '' : `params: ${paramTypeAnnotation}`;

    agentClass += `  /**
   * ${tool.description} (across multiple agents)
   */
  async ${tool.methodName}(${paramDecl}): Promise<${responseType}[]> {
    return this.callToolOnAll<${responseType}>('${tool.name}', ${paramType === 'void' ? '{}' : 'params'});
  }

`;
  }

  agentClass += '}\n';

  return agentClass;
}

/**
 * Recursively discover all JSON schema files in the cache directory.
 * Returns relative paths from LATEST_CACHE_DIR (e.g., "core/format.json", "enums/channels.json").
 */
function discoverAllSchemaFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      // The versioned mcp/ and bundled/ trees are transport/build projections
      // of the canonical AdCP schemas. Compiling them again as gap types
      // duplicates nearly the entire public surface (and weakens several
      // declarations because projections intentionally inline dependencies or
      // permit envelope fields).
      // Only canonical protocol schemas own the SDK's exported types.
      const relativeDirectory = path.relative(base, fullPath);
      if (entry === 'tmp' || relativeDirectory === 'mcp' || relativeDirectory === 'bundled') continue;
      results.push(...discoverAllSchemaFiles(fullPath, base));
    } else if (entry.endsWith('.json') && entry !== 'index.json') {
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}

/**
 * Convert a schema file path to a PascalCase type name.
 * e.g., "core/format.json" -> "Format"
 *       "enums/pricing-model.json" -> "PricingModel"
 *       "core/assets/html-asset.json" -> "HtmlAsset"
 *       "pricing-options/cpm-option.json" -> "CpmOption"
 *       "brand/rights-pricing-option.json" -> "RightsPricingOption"
 */
function schemaPathToTypeName(relativePath: string): string {
  const fileName = path.basename(relativePath, '.json');
  return fileName
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Compile all schemas that weren't already generated by the root schema or tool passes.
 * This fills the gap for standalone schemas in core/, enums/, pricing-options/, brand/, etc.
 *
 * Skips:
 * - Task request/response schemas (already generated as tool types)
 * - Root aggregation schemas (brand.json, adagents.json at top level)
 * - Schemas whose type names were already generated via $ref resolution
 * - Async response variant schemas (working/submitted/input-required)
 */
async function compileGapSchemas(generatedTypes: Set<string>, refResolver: any): Promise<string> {
  const allFiles = discoverAllSchemaFiles(LATEST_CACHE_DIR);
  const gapCode: string[] = [];

  // Directories that contain task request/response schemas (already covered by tool generation)
  const taskDirs = new Set([
    'account',
    'media-buy',
    'creative',
    'signals',
    'governance',
    'protocol',
    'sponsored-intelligence',
    'compliance',
    'content-standards',
    'property',
    'collection',
  ]);

  // Patterns that indicate task request/response schemas
  const taskSchemaPattern = /-(request|response)\.json$/;
  // Async response variants are always generated alongside their parent tool
  const asyncVariantPattern = /-async-response-(working|submitted|input-required)\.json$/;

  // Top-level aggregation schemas (not standalone types)
  const skipFiles = new Set(['adagents.json', 'brand.json']);

  let compiledCount = 0;

  for (const relPath of allFiles.sort()) {
    // Skip top-level aggregation files
    if (!relPath.includes('/') && skipFiles.has(relPath)) continue;

    const dir = relPath.split('/')[0];

    // Skip task request/response schemas in task directories
    if (taskDirs.has(dir) && taskSchemaPattern.test(relPath)) continue;

    // Skip async response variants
    if (asyncVariantPattern.test(relPath)) continue;

    const pathDerivedTypeName = schemaPathToTypeName(relPath);

    // Skip deprecated schemas
    if (DEPRECATED_SCHEMAS.has(path.basename(relPath, '.json'))) continue;

    // Peek at the schema's `title` before deciding whether to skip for dedupe.
    // `json-schema-to-typescript` honors `title` over the typeName argument we
    // pass, so the actual emitted name is title-derived. Using path-only for
    // dedupe causes spurious skips when two distinct schemas share a kebab-name
    // (e.g. `error-details/creative-rejected.json` was being dropped because
    // brand-domain `creative-approval-response.json` already registered
    // `CreativeRejected` — but the error-details file's title is "Creative
    // Rejected Details", so jsts would emit `CreativeRejectedDetails`, not a
    // duplicate. Tracked: adcp-client#1271.
    let schemaForTypeName: Record<string, unknown> | null = null;
    try {
      const schemaPath = path.join(LATEST_CACHE_DIR, relPath);
      schemaForTypeName = JSON.parse(readFileSync(schemaPath, 'utf8'));
    } catch {
      // Fall through to the main compile attempt for consistent error logging
      schemaForTypeName = null;
    }
    const titleDerivedTypeName =
      typeof schemaForTypeName?.title === 'string' ? schemaForTypeName.title.replace(/[^A-Za-z0-9]/g, '') : '';
    const typeName = titleDerivedTypeName || pathDerivedTypeName;

    // Skip if this type was already generated. The check uses the
    // title-preferring name so two distinct schemas that share a kebab-name
    // but have distinct titles can both emit (the previous behavior used
    // path-only and silently dropped the second).
    if (generatedTypes.has(typeName)) continue;

    try {
      const schemaPath = path.join(LATEST_CACHE_DIR, relPath);
      let schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

      // Apply same preprocessing as other schema passes
      const fileName = path.basename(relPath, '.json');
      if (DEPRECATED_ENUM_VALUES[fileName]) {
        schema = removeDeprecatedFields(schema, fileName);
      }
      const pascalName = schemaPathToTypeName(relPath);
      if (DEPRECATED_SCHEMA_FIELDS[pascalName]) {
        schema = removeDeprecatedFields(schema, pascalName);
      }
      if (BACKWARD_COMPAT_OPTIONAL_FIELDS[pascalName]) {
        schema = makeFieldsOptional(schema, BACKWARD_COMPAT_OPTIONAL_FIELDS[pascalName]);
      }
      schema = applyCodegenSchemaWorkarounds(schema, pascalName);

      const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema)));
      const types = await compile(strictSchema, typeName, {
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

      const filtered = filterDuplicateTypeDefinitions(types, generatedTypes);
      if (filtered.trim()) {
        gapCode.push(`// ${relPath}\n${filtered}`);
        compiledCount++;
      }
    } catch (error: any) {
      console.warn(`⚠️  Failed to compile gap schema ${relPath}: ${error.message}`);
    }
  }

  console.log(`📦 Compiled ${compiledCount} gap schemas`);
  return gapCode.join('\n\n');
}

async function generateTypes() {
  console.log('🔄 Generating AdCP types and fluent API...');

  // Check if schemas are cached
  if (!existsSync(LATEST_CACHE_DIR)) {
    console.error('❌ Schema cache not found. Please run "npm run sync-schemas" first.');
    process.exit(1);
  }

  const adcpVersion = getCachedAdCPVersion();
  console.log(`📋 Using AdCP schemas version: ${adcpVersion}`);

  const libOutputDir = path.join(__dirname, '../src/lib/types');
  const agentsOutputDir = path.join(__dirname, '../src/lib/agents');
  mkdirSync(libOutputDir, { recursive: true });
  mkdirSync(agentsOutputDir, { recursive: true });

  // Generate core AdCP types from cached schemas
  let coreTypes = `// Generated AdCP core types from official schemas v${adcpVersion}\n// Generated at: ${new Date().toISOString()}\n\n`;

  // Custom $ref resolver for cached schemas
  const refResolver = {
    canRead: true,
    read: (file: { url: string }) => {
      const url = file.url;
      // Handle any /schemas/ path (versioned or v1)
      if (schemaRefToCacheRelativePath(url)) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema))));
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    },
  };

  // Track generated types across all core schemas to prevent duplicates
  const generatedCoreTypes = new Set<string>();

  // Compile canonical enum documents before broad aggregate roots. Large
  // dereferenced 3.2 roots can narrow a shared enum in one context or make
  // json-schema-to-typescript emit one numbered type per member. The canonical
  // enum directory owns these public unions; tool output imports them from
  // core.generated.ts instead of letting first-tool order choose a subset.
  const enumDirectory = path.join(LATEST_CACHE_DIR, 'enums');
  const canonicalEnums = existsSync(enumDirectory)
    ? readdirSync(enumDirectory)
        .filter(fileName => fileName.endsWith('.json'))
        .sort()
        .map(fileName => {
          const ref = `enums/${fileName}`;
          const schema = loadCachedSchema(ref);
          const typeName =
            typeof schema?.title === 'string' ? schema.title.replace(/[^A-Za-z0-9]/g, '') : schemaPathToTypeName(ref);
          return { ref, schema, typeName };
        })
    : [];

  for (const { ref, schema, typeName } of canonicalEnums) {
    try {
      if (!schema) throw new Error(`Schema ${ref} not found in cache`);
      const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema)));
      const types = await compile(strictSchema, typeName, {
        bannerComment: '',
        style: { semi: true, singleQuote: true },
        additionalProperties: false,
        strictIndexSignatures: true,
        $refOptions: { resolve: { cache: refResolver } },
      });
      const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);
      coreTypes += `// ${typeName.toUpperCase()} CANONICAL ENUM\n${filteredTypes}\n`;
      // jsts title casing is not equivalent to stripping punctuation (for
      // example "Day of Week" becomes `DayOfWeek`, not `DayofWeek`). Seed
      // tool imports from the declarations it actually emitted.
      for (const emittedTypeName of collectExportedTypeNames(types)) {
        CORE_AUTHORED_TOOL_SHARED_TYPES.add(emittedTypeName);
      }
    } catch (error) {
      console.error(`❌ Failed to generate canonical enum ${ref}:`, error.message);
    }
  }
  console.log(`✅ Generated ${canonicalEnums.length} canonical core enums`);

  for (const ref of PRIORITY_CANONICAL_SCHEMAS) {
    try {
      const schema = loadCachedSchema(ref);
      if (!schema) throw new Error(`Schema ${ref} not found in cache`);
      const typeName =
        typeof schema.title === 'string' ? schema.title.replace(/[^A-Za-z0-9]/g, '') : schemaPathToTypeName(ref);
      const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema)));
      const types = await compile(strictSchema, typeName, {
        bannerComment: '',
        style: { semi: true, singleQuote: true },
        additionalProperties: false,
        strictIndexSignatures: true,
        $refOptions: { resolve: { cache: refResolver } },
      });
      const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);
      coreTypes += `// ${typeName.toUpperCase()} PRIORITY CANONICAL SCHEMA\n${filteredTypes}\n`;
    } catch (error) {
      console.error(`❌ Failed to generate priority canonical schema ${ref}:`, error.message);
    }
  }
  console.log(`✅ Generated ${PRIORITY_CANONICAL_SCHEMAS.length} priority canonical schemas`);

  for (const schemaName of ADCP_CORE_SCHEMAS) {
    try {
      console.log(`📥 Loading ${schemaName} schema from cache...`);
      const schema = loadCoreSchema(schemaName);

      if (schema) {
        console.log(`🔧 Generating TypeScript types for ${schemaName}...`);
        // Process schema: remove additionalProperties and minItems constraints
        const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema)));
        const types = await compile(strictSchema, schemaName, {
          bannerComment: '',
          style: {
            semi: true,
            singleQuote: true,
          },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        // Filter out duplicate type definitions across core schemas
        const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);

        coreTypes += `// ${schemaName.toUpperCase()} SCHEMA\n${filteredTypes}\n`;
        console.log(`✅ Generated core types for ${schemaName}`);
      } else {
        console.warn(`⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`❌ Failed to generate core types for ${schemaName}:`, error.message);
    }
  }

  // Generate types for standalone schemas (not in core/ directory)
  for (const schemaName of STANDALONE_SCHEMAS) {
    try {
      console.log(`📥 Loading ${schemaName} schema from cache...`);

      // Read refs from the index.json instead of hardcoding paths
      const indexPath = path.join(SCHEMA_CACHE_DIR, 'latest', 'index.json');
      if (!existsSync(indexPath)) {
        throw new Error('Schema index not found in cache');
      }
      const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

      // Look up the schema in the index to get actual $ref
      const schemaRef = schemaIndex.schemas?.[schemaName]?.$ref;
      if (!schemaRef) {
        throw new Error(`Schema ${schemaName} not found in index`);
      }

      const schema = loadCachedSchema(schemaRef);

      if (schema) {
        console.log(`🔧 Generating TypeScript types for ${schemaName}...`);
        // Process schema: remove additionalProperties and minItems constraints
        const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(injectJsdocConstraints(schema)));
        const types = await compile(strictSchema, schemaName, {
          bannerComment: '',
          style: {
            semi: true,
            singleQuote: true,
          },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        // Filter out duplicate type definitions using the same tracking set
        const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);

        coreTypes += `// ${schemaName.toUpperCase()} SCHEMA\n${filteredTypes}\n`;
        console.log(`✅ Generated standalone types for ${schemaName}`);
      } else {
        console.warn(`⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`❌ Failed to generate standalone types for ${schemaName}:`, error.message);
    }
  }

  // Load AdCP tools from cached schemas
  const tools = loadAdCPTools();

  // Generate tool types
  let toolTypes = await generateToolTypes(tools, CORE_AUTHORED_TOOL_SHARED_TYPES);

  // Remove index signature types that were incorrectly generated from oneOf schemas
  // These occur when JSON Schema has additionalProperties: false but oneOf with only required constraints
  toolTypes = removeIndexSignatureTypes(toolTypes);
  // Remove numbered type duplicates (e.g., EventType1 -> EventType) caused by multiple $ref
  // occurrences of the same schema within a single compilation unit
  toolTypes = removeNumberedTypeDuplicates(toolTypes);
  toolTypes = removeNumberedCoreTypeDuplicates(toolTypes, CORE_AUTHORED_TOOL_SHARED_TYPES);
  toolTypes = nameGetProductsRejectedStatus(namePostalAreaCountryBranch(toolTypes));
  toolTypes = applyKnownJstsAliases(toolTypes);
  toolTypes = fixTypedIndexSignatures(toolTypes);
  toolTypes = widenPostalAreaSupportIndexSignature(toolTypes);
  toolTypes = widenMediaBuyFeaturesIndexSignature(toolTypes);
  toolTypes = simplifyForecastRange(toolTypes);
  // This set is deliberately limited to canonical enums plus the handful of
  // shared core contracts above. Import all of them: numbered-type cleanup can
  // introduce a canonical reference after lexical reference scanning, and
  // type-only imports have no runtime or bundle cost.
  toolTypes = addCoreGeneratedTypeImports(toolTypes, CORE_AUTHORED_TOOL_SHARED_TYPES);
  toolTypes = addCoreGeneratedTypeReExports(toolTypes, CORE_AUTHORED_TOOL_SHARED_TYPES);

  // Compile gap schemas: all schemas not already generated by root schema passes.
  // Only dedup against core types (not tool types) because gap schemas go into
  // core.generated.ts which is a separate file from tools.generated.ts.
  console.log('\n🔍 Scanning for gap schemas...');
  const gapTypes = await compileGapSchemas(new Set(generatedCoreTypes), refResolver);
  if (gapTypes.trim()) {
    coreTypes += `\n// GAP SCHEMAS — types not reachable from root schemas or tool definitions\n${gapTypes}\n`;
  }

  // Generate Agent classes
  const agentClasses = generateAgentClasses(tools);

  // Write files only if content changed
  const coreTypesPath = path.join(libOutputDir, 'core.generated.ts');
  // Strip inline index-signature arms first so numbered-duplicate detection compares
  // clean bodies (without the { [k: string]: unknown } intersection arms that only appear
  // on some compile passes of the same schema). After byte-identity dedupe, alias the
  // residual jsts under-resolution artifacts (*Asset1, AssetVariant1, CreativeAsset1) —
  // see applyKnownJstsAliases for the rationale. Finally, restore the asset_type
  // discriminator on Individual*Asset slot aliases that jsts collapses (#1498).
  const processedCoreTypes = hardenTrustedMatchGeneratedTypes(
    applyIndividualAssetDiscriminators(
      addBackwardCompatTypeAliases(
        simplifyForecastRange(
          widenMediaBuyFeaturesIndexSignature(
            widenPostalAreaSupportIndexSignature(
              fixTypedIndexSignatures(
                applyKnownJstsAliases(
                  nameGetProductsRejectedStatus(
                    namePostalAreaCountryBranch(removeNumberedTypeDuplicates(removeIndexSignatureTypes(coreTypes))),
                    true
                  )
                )
              )
            )
          )
        )
      )
    )
  );
  const coreChanged = writeFileIfChanged(coreTypesPath, processedCoreTypes);

  const toolTypesPath = path.join(libOutputDir, 'tools.generated.ts');
  const processedToolTypes = addCanonicalToolTypeAliases(
    applyIndividualAssetDiscriminators(addBackwardCompatTypeAliases(toolTypes)),
    tools
  );
  const toolsChanged = writeFileIfChanged(toolTypesPath, processedToolTypes);

  const agentClassesPath = path.join(agentsOutputDir, 'index.generated.ts');
  const agentsChanged = writeFileIfChanged(agentClassesPath, agentClasses);

  const changedFiles = [
    coreChanged && 'core types',
    toolsChanged && 'tool types',
    agentsChanged && 'agent classes',
  ].filter(Boolean);

  if (changedFiles.length > 0) {
    console.log(`✅ Updated ${changedFiles.join(', ')}`);
  } else {
    console.log(`✅ All generated files are up to date`);
  }

  console.log(`✅ Generated files:`);
  console.log(`   📄 Core types: ${coreTypesPath}`);
  console.log(`   📄 Tool types: ${toolTypesPath}`);
  console.log(`   📄 Agent classes: ${agentClassesPath}`);
}

if (require.main === module) {
  (async () => {
    try {
      // Generate TypeScript types
      await generateTypes();

      // Also generate Zod schemas
      console.log('\n🔄 Generating Zod schemas...');
      const { generateZodSchemas } = await import('./generate-zod-from-ts');
      await generateZodSchemas();

      console.log('\n✅ All type generation complete!');
    } catch (error) {
      console.error('❌ Failed to generate types:', error);
      process.exit(1);
    }
  })();
}

export { generateTypes, nameGetProductsRejectedStatus };
