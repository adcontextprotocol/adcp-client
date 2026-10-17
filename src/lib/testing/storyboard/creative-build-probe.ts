/** Portable, read-only preparation of one build request for evaluator probes.
 * Route identity and input are selected atomically. No build is dispatched here.
 */
import { matchesFixtureRequirements, normalizeFixtureMatchExpression } from './fixture-resolution';
import type { FixtureMatchClause, StoryboardContext } from './types';
import {
  getSchemaDocumentByRef,
  getSchemaValidatorByRef,
  withServedValidationVersion,
} from '../../validation/schema-loader';
import { ADCP_VERSION } from '../../version';
import { SECRET_KEY_PATTERN } from '../../utils/redact-secrets';
import { MAX_JSON_DEPTH } from '../../utils/json-depth';
import { canonicalizeAgentUrl } from '../../discovery/resolve-agent-properties';

export interface CreativeBuildProbeSpec {
  context_prefix: string;
  message: string;
}

export interface CreativeBuildProbeInputFixture {
  match: FixtureMatchClause[];
  /** Operator-provisioned valid input for every route matched by this recipe. */
  input: Record<string, unknown>;
}

export type CreativeBuildProbeResolution =
  | {
      status: 'resolved';
      capabilityId?: string;
      formatId?: Record<string, unknown>;
      context: StoryboardContext;
      source: 'generation' | 'test_kit';
      requirements: FixtureMatchClause[];
    }
  | { status: 'unsatisfied'; detail: string }
  | { status: 'failed'; detail: string };

const INPUT_FIELDS = new Set([
  'message',
  'creative_manifest',
  'creative_id',
  'transformer_id',
  'config',
  'target_format_id',
]);
const TRUST_FIELDS =
  /^(auth|private[_-]?key|bearer[_-]?token|id[_-]?token|jwk|jwks|jwks[_-]?uri|x[_-]api[_-]key|signing[_-]?key|secret[_-]?key|hmac[_-]?key|client[_-]?key)$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function at(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = isRecord(value) ? value[key] : undefined;
  return value;
}

// Diagnostic display bounds only: unknown producer values remain intact.
function displayUnknownKind(kind: string): string {
  return JSON.stringify(kind.slice(0, 128)).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export function validateCreativeBuildProbeSpec(value: unknown): asserts value is CreativeBuildProbeSpec {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => key !== 'context_prefix' && key !== 'message') ||
    typeof value.context_prefix !== 'string' ||
    !/^[a-z][a-z0-9_]*$/.test(value.context_prefix) ||
    typeof value.message !== 'string' ||
    value.message.trim().length === 0
  ) {
    throw new Error('creative_build_probe requires context_prefix (lowercase identifier) and a nonempty message');
  }
}

function containsSecretField(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > MAX_JSON_DEPTH) throw new Error('creative_build_probe: fixture nesting exceeds the JSON depth bound');
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('creative_build_probe: invalid URL in fixture');
    }
    return (
      !!(url.username || url.password) ||
      [...url.searchParams.keys()].some(key => SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key))
    );
  }
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) throw new Error('creative_build_probe: fixture must be acyclic JSON');
  seen.add(value);
  const found = Array.isArray(value)
    ? value.some(item => containsSecretField(item, depth + 1, seen))
    : Object.entries(value).some(
        ([key, item]) =>
          SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key) || containsSecretField(item, depth + 1, seen)
      );
  seen.delete(value);
  return found;
}

// Authoring-only limits. They do not constrain an agent's advertised catalog.
function validateRecipeBudget(value: unknown, location: string): void {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > MAX_JSON_DEPTH)
      throw new Error(`${location}: recipe exceeds the fixture node/depth budget`);
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    if (bytes > 4 * 1024 * 1024) throw new Error(`${location}: recipe exceeds the 4 MiB fixture string budget`);
    if (!item || typeof item !== 'object') return;
    if (ancestors.has(item)) throw new Error(`${location}: recipe must be acyclic JSON`);
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      bytes += Buffer.byteLength(key, 'utf8');
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

function validateInput(
  value: unknown,
  location: string,
  validateManifest: ReturnType<typeof getSchemaValidatorByRef>
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !INPUT_FIELDS.has(key))) {
    throw new Error(
      `${location}: input may only contain message, creative_manifest, creative_id, transformer_id, config and target_format_id`
    );
  }
  if (containsSecretField(value))
    throw new Error(`${location}: input must not carry credential or trust-material fields`);
  for (const key of ['message', 'creative_id', 'transformer_id']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].trim().length === 0)) {
      throw new Error(`${location}: ${key} must be a nonempty string`);
    }
  }
  if (value.config !== undefined && (!isRecord(value.config) || !value.transformer_id))
    throw new Error(
      `${location}: this probe contract requires config to be an object bound to a provisioned transformer_id`
    );
  if (value.creative_id && value.creative_manifest)
    throw new Error(
      `${location}: this probe contract requires one unambiguous source, not both creative_id and creative_manifest`
    );
  if (value.creative_manifest !== undefined) {
    const manifest = value.creative_manifest;
    if (!validateManifest || !validateManifest(manifest)) {
      throw new Error(`${location}: creative_manifest must be a complete manifest, including format and assets`);
    }
  }
  if (!value.message && !value.creative_manifest && !value.creative_id && !value.transformer_id) {
    throw new Error(
      `${location}: input must identify a brief, source manifest or provisioned library creative/transformer`
    );
  }
}

/**
 * Uses only actual catalog entries and explicitly provisioned test-kit inputs.
 * Global generation support does not identify a generation route in a mixed
 * catalog: the automatic brief recipe is therefore used only when the catalog
 * has exactly one build route (including legacy unaddressable build entries),
 * and a complete, understood declaration proves there are no technical seeds.
 * Other modes require a matching operator recipe, not inferred source assets.
 */
export function resolveCreativeBuildProbe(
  creative: unknown,
  spec: CreativeBuildProbeSpec,
  testKit?: unknown,
  adcpVersion?: string,
  governanceEnforcement?: unknown
): CreativeBuildProbeResolution {
  return resolveCreativeBuildProbeWithSchemas(
    creative,
    spec,
    testKit,
    governanceEnforcement,
    adcpVersion,
    captureRequestSchemas(adcpVersion)
  );
}

function captureRequestSchemas(adcpVersion?: string) {
  return {
    request: getSchemaDocumentByRef('media-buy/build-creative-request.json', adcpVersion)?.schema,
    validateManifest: getSchemaValidatorByRef('core/creative-manifest.json', adcpVersion),
    validateFormatId: getSchemaValidatorByRef('core/format-id.json', adcpVersion),
    formatIdProperties: at(getSchemaDocumentByRef('core/format-id.json', adcpVersion)?.schema, 'properties'),
  };
}

/** @internal Capture pinned request authority before activating served catalog roots. */
export function prepareCreativeBuildProbe(
  capabilities: unknown,
  spec: CreativeBuildProbeSpec,
  testKit?: unknown,
  adcpVersion?: string
): CreativeBuildProbeResolution {
  const requestSchemas = captureRequestSchemas(adcpVersion);
  return withServedValidationVersion(capabilities, adcpVersion ?? ADCP_VERSION, catalogVersion =>
    resolveCreativeBuildProbeWithSchemas(
      at(capabilities, 'creative'),
      spec,
      testKit,
      at(capabilities, 'adcp', 'governance_enforcement'),
      catalogVersion,
      requestSchemas
    )
  );
}

function resolveCreativeBuildProbeWithSchemas(
  creative: unknown,
  spec: CreativeBuildProbeSpec,
  testKit: unknown,
  governanceEnforcement: unknown,
  catalogAdcpVersion: string | undefined,
  requestSchemas: ReturnType<typeof captureRequestSchemas>
): CreativeBuildProbeResolution {
  validateCreativeBuildProbeSpec(spec);
  if (isRecord(creative) && creative.supported_formats !== undefined && !Array.isArray(creative.supported_formats)) {
    return { status: 'failed', detail: 'creative.supported_formats: malformed catalog (expected array)' };
  }
  if (!isRecord(creative) || !Array.isArray(creative.supported_formats)) {
    return {
      status: 'unsatisfied',
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no advertised creative build catalog`,
    };
  }
  const recipes = isRecord(testKit) && testKit.creative_build_probes !== undefined ? testKit.creative_build_probes : [];
  if (!Array.isArray(recipes)) throw new Error('test_kit.creative_build_probes must be an array');
  if (
    recipes.some(
      recipe => isRecord(recipe) && isRecord(recipe.input) && recipe.input.creative_manifest !== undefined
    ) &&
    !requestSchemas.validateManifest
  ) {
    return {
      status: 'unsatisfied',
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version source manifest schema validator is unavailable`,
    };
  }
  const normalized = recipes.map((recipe: unknown, index: number) => {
    const location = `test_kit.creative_build_probes[${index}]`;
    validateRecipeBudget(recipe, location);
    if (!isRecord(recipe) || Object.keys(recipe).some(key => key !== 'match' && key !== 'input')) {
      throw new Error(`${location}: expected only match and input`);
    }
    const match = normalizeFixtureMatchExpression(recipe.match, `${location}.match`);
    if (match.length === 0) throw new Error(`${location}: at least one explicit match predicate is required`);
    validateInput(recipe.input, location, requestSchemas.validateManifest);
    return { match, input: recipe.input };
  });
  // The capabilities response can serve a different release from the request
  // pin. The caller activates its existing served-validation schema scope.
  // Only catalog declarations use that release; input and wire selectors stay
  // on the request pin above and below.
  const catalogDocument = getSchemaDocumentByRef('protocol/get-adcp-capabilities-response.json', catalogAdcpVersion);
  const catalog = catalogDocument?.schema;
  const selectedVersion = catalogDocument?.resolvedVersion ?? catalogAdcpVersion ?? 'selected bundle';
  const item = at(catalog, 'properties', 'creative', 'properties', 'supported_formats', 'items');
  const request = requestSchemas.request;
  const canonicalSelector = !!at(request, 'properties', 'target_capability_id');
  const legacySelector = !!at(request, 'properties', 'target_format_id');
  const catalogRequest = getSchemaDocumentByRef('media-buy/build-creative-request.json', catalogAdcpVersion)?.schema;
  const canonicalCatalog = !!at(catalogRequest, 'properties', 'target_capability_id');
  const requestIdPattern = at(request, 'properties', 'target_capability_id', 'pattern');
  const canonicalAddressable = (route: Record<string, unknown>) =>
    canonicalCatalog &&
    canonicalSelector &&
    typeof route.capability_id === 'string' &&
    (typeof requestIdPattern !== 'string' || new RegExp(requestIdPattern).test(route.capability_id));
  const ref = at(item, 'properties', 'format', '$ref');
  // These are authored bundle refs, not network lookups or a cross-version fallback.
  const formatRef =
    typeof ref === 'string'
      ? ref.replace(/^(?:https:\/\/adcontextprotocol\.org)?\/schemas\/(?:(?:v?\d[^/]*|latest)\/)?/, '')
      : undefined;
  const validateFormat = formatRef ? getSchemaValidatorByRef(formatRef, catalogAdcpVersion) : undefined;
  const validateKind = getSchemaValidatorByRef('core/canonical-format-kind.json', catalogAdcpVersion);
  if (!validateFormat || !validateKind || !catalogRequest || (!canonicalSelector && !legacySelector)) {
    return {
      status: 'unsatisfied',
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version creative catalog schema validators are unavailable`,
    };
  }
  for (const recipe of normalized) {
    if (recipe.input.target_format_id !== undefined) {
      if (!legacySelector)
        throw new Error(
          'test_kit.creative_build_probes: target_format_id is not supported by the selected build request'
        );
      const validateId = requestSchemas.validateFormatId;
      if (!validateId)
        return {
          status: 'unsatisfied',
          detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: selected-version legacy FormatID schema validator is unavailable`,
        };
      if (!validateId(recipe.input.target_format_id))
        throw new Error(
          'test_kit.creative_build_probes: target_format_id must be a selected-version valid provisioned FormatID'
        );
    }
  }
  const idPattern = at(item, 'properties', 'capability_id', 'pattern');
  const hasOperations = at(item, 'properties', 'operations') !== undefined;
  const isBuildRoute = (entry: Record<string, unknown>) =>
    !hasOperations ||
    entry.operations === undefined ||
    (Array.isArray(entry.operations) && entry.operations.includes('build'));
  const selectorProperties = at(
    getSchemaDocumentByRef('core/format-id.json', catalogAdcpVersion)?.schema,
    'properties'
  );
  const requestSelectorProperties = requestSchemas.formatIdProperties;
  const requestHasPixelRatio = at(requestSelectorProperties, 'pixel_ratio') !== undefined;
  const legacyDimensions = ['width', 'height', 'duration_ms', 'pixel_ratio'].filter(
    key => at(selectorProperties, key) !== undefined
  );
  const unavailableKinds = new Set<string>();
  const ids = new Set<string>();
  const buildRoutes: Record<string, unknown>[] = [];
  for (const [index, entry] of creative.supported_formats.entries()) {
    const location = `creative.supported_formats[${index}]`;
    const invalid = (detail: string): CreativeBuildProbeResolution => ({
      status: 'failed',
      detail: `${location}: ${detail}`,
    });
    if (!isRecord(entry)) return invalid('malformed catalog entry (expected object)');
    if (entry.capability_id !== undefined) {
      if (
        typeof entry.capability_id !== 'string' ||
        (typeof idPattern === 'string' && !new RegExp(idPattern).test(entry.capability_id)) ||
        (canonicalCatalog && ids.has(entry.capability_id))
      ) {
        return invalid('capability_id must be usable and unique within the catalog');
      }
      ids.add(entry.capability_id);
    }
    const operations = entry.operations;
    if (
      hasOperations &&
      operations !== undefined &&
      (!Array.isArray(operations) ||
        operations.length === 0 ||
        operations.some(
          (operation, index) =>
            typeof operation !== 'string' ||
            !['build', 'validate', 'preview'].includes(operation) ||
            operations.indexOf(operation) !== index
        ))
    ) {
      return invalid('operations must be a nonempty unique array of build, validate or preview');
    }

    if (!isRecord(entry.format) || typeof entry.format.format_kind !== 'string' || !isRecord(entry.format.params)) {
      return invalid('format must declare format_kind and params');
    }
    // The 3.1 consumer contract retains unknown future kinds as unsupported
    // routes. Do not grade that surrounding payload as producer nonconformance.
    if (!canonicalCatalog && !validateKind(entry.format.format_kind)) {
      unavailableKinds.add(entry.format.format_kind);
      if (isBuildRoute(entry)) buildRoutes.push(entry);
      continue;
    }
    if (!validateFormat(entry.format) || !validateKind(entry.format.format_kind)) {
      return invalid(
        `malformed format declaration: ${[...(validateFormat.errors ?? []), ...(validateKind.errors ?? [])].map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`
      );
    }
    const validateParams = getSchemaValidatorByRef(
      `formats/canonical/${entry.format.format_kind}.json`,
      catalogAdcpVersion
    );
    if (entry.format.format_kind !== 'custom' && !validateParams) {
      unavailableKinds.add(entry.format.format_kind);
      if (isBuildRoute(entry)) buildRoutes.push(entry);
      continue;
    }
    if (
      (validateParams && !validateParams(entry.format.params)) ||
      (validateFormat && !validateFormat(entry.format)) ||
      (validateKind && !validateKind(entry.format.format_kind))
    ) {
      return invalid(
        `malformed format declaration: ${[...(validateParams?.errors ?? []), ...(validateFormat?.errors ?? []), ...(validateKind?.errors ?? [])].map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`
      );
    }
    if (isBuildRoute(entry)) buildRoutes.push(entry);
  }
  if (
    isRecord(governanceEnforcement) &&
    Array.isArray(governanceEnforcement.tasks) &&
    governanceEnforcement.tasks.some(
      task =>
        isRecord(task) &&
        task.task === 'build_creative' &&
        Array.isArray(task.modes) &&
        task.modes.includes('signed_context')
    )
  ) {
    return {
      status: 'unsatisfied',
      detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: payload-bound build governance authorization is not prepared by this runner contract`,
    };
  }
  for (const route of buildRoutes) {
    const knownKind = validateKind((route.format as Record<string, unknown>).format_kind);
    if (
      !knownKind ||
      ((route.format as Record<string, unknown>).format_kind !== 'custom' &&
        !getSchemaValidatorByRef(
          `formats/canonical/${(route.format as Record<string, unknown>).format_kind}.json`,
          catalogAdcpVersion
        ))
    )
      continue; // Unknown/unvalidated route retained, never fabricated.

    let source: 'generation' | 'test_kit' = 'test_kit';
    const usable = (input: Record<string, unknown>) => {
      if (input.transformer_id) return creative.supports_transformers === true;
      if (input.creative_id) return creative.has_creative_library === true;
      if (input.creative_manifest)
        return creative.supports_transformation === true || creative.supports_generation === true;
      return creative.supports_generation === true;
    };
    const format = route.format as Record<string, unknown>;
    const legacyBindingAgrees = (input: Record<string, unknown>): boolean => {
      if (input.target_format_id === undefined) return canonicalAddressable(route);
      if (format.canonical_formats_only === true || !isRecord(input.target_format_id)) return false;
      if (!Array.isArray(format.v1_format_ref)) return true; // Explicit operator-provisioned mapping.
      const target = input.target_format_id;
      const targetUrl = typeof target.agent_url === 'string' ? canonicalizeAgentUrl(target.agent_url) : null;
      if (targetUrl === null) return false;
      return format.v1_format_ref.some(
        ref =>
          isRecord(ref) &&
          ref.id === target.id &&
          typeof ref.agent_url === 'string' &&
          typeof target.agent_url === 'string' &&
          canonicalizeAgentUrl(ref.agent_url) === targetUrl &&
          legacyDimensions.every(key =>
            key === 'pixel_ratio'
              ? (ref[key] ?? 1) === (requestHasPixelRatio ? (target[key] ?? 1) : 1)
              : ref[key] === undefined || ref[key] === target[key]
          )
      );
    };
    const selectedRecipe = normalized.find(
      recipe =>
        matchesFixtureRequirements(route, recipe.match) && usable(recipe.input) && legacyBindingAgrees(recipe.input)
    );
    let input = selectedRecipe?.input;
    const kindValidator = getSchemaValidatorByRef('core/canonical-format-kind.json', catalogAdcpVersion);
    const emptyCompleteFormat =
      format.technical_requirements_complete === true &&
      format.format_kind !== 'custom' &&
      kindValidator?.(format.format_kind) === true &&
      Object.keys(format.params as Record<string, unknown>).length === 0 &&
      Object.keys(format).every(key =>
        [
          'format_kind',
          'params',
          'technical_requirements_complete',
          'display_name',
          'seller_preference',
          'experimental',
          'sample_render_url',
          'format_option_id',
          'publisher_domain',
          'applies_to_channels',
          'canonical_formats_only',
        ].includes(key)
      ) &&
      Object.keys(route).every(key => ['capability_id', 'operations', 'format'].includes(key));
    if (
      !input &&
      canonicalAddressable(route) &&
      creative.supports_generation === true &&
      buildRoutes.length === 1 &&
      emptyCompleteFormat
    ) {
      source = 'generation';
      const manifest = { format_kind: format.format_kind, assets: {} };
      const validateManifest = requestSchemas.validateManifest;
      if (!validateManifest?.(manifest)) continue;
      input = { message: spec.message, creative_manifest: manifest };
    }
    if (!input) continue;
    const useCanonicalSelector = input.target_format_id === undefined;
    const context: StoryboardContext = useCanonicalSelector
      ? { [`${spec.context_prefix}_capability_id`]: route.capability_id }
      : { [`${spec.context_prefix}_target_format_id`]: structuredClone(input.target_format_id) };
    for (const key of ['message', 'creative_manifest', 'creative_id', 'transformer_id', 'config']) {
      if (input[key] !== undefined) context[`${spec.context_prefix}_${key}`] = structuredClone(input[key]);
    }
    return {
      status: 'resolved',
      ...(useCanonicalSelector
        ? { capabilityId: route.capability_id as string }
        : { formatId: structuredClone(input.target_format_id) as Record<string, unknown> }),
      context,
      source,
      requirements: selectedRecipe?.match ?? [],
    };
  }
  return {
    status: 'unsatisfied',
    detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no routable build entry has a known-valid generation input or a matching provisioned test-kit recipe${unavailableKinds.size ? `; ${unavailableKinds.size} unvalidated kind(s) in schema bundle ${selectedVersion}: ${[...unavailableKinds].slice(0, 8).map(displayUnknownKind).join(', ')}${unavailableKinds.size > 8 ? ', …' : ''}` : ''}`,
  };
}
