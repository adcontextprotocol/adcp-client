/** Portable, read-only preparation of one build request for evaluator probes.
 * Route identity and input are selected atomically. No build is dispatched here.
 */
import { matchesFixtureRequirements, normalizeFixtureMatchExpression } from './fixture-resolution';
import type { FixtureMatchClause, StoryboardContext } from './types';
import { getSchemaValidatorByRef } from '../../validation/schema-loader';
import { SECRET_KEY_PATTERN } from '../../utils/redact-secrets';
import { MAX_JSON_DEPTH } from '../../utils/json-depth';

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
  | { status: 'resolved'; capabilityId: string; context: StoryboardContext; source: 'generation' | 'test_kit'; requirements: FixtureMatchClause[] }
  | { status: 'unsatisfied'; detail: string }
  | { status: 'failed'; detail: string };

const INPUT_FIELDS = new Set(['message', 'creative_manifest', 'creative_id', 'transformer_id', 'config']);
const TRUST_FIELDS = /^(auth|private[_-]?key|bearer[_-]?token|id[_-]?token|jwk|jwks|jwks_uri)$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateCreativeBuildProbeSpec(value: unknown): asserts value is CreativeBuildProbeSpec {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'context_prefix' && key !== 'message') ||
      typeof value.context_prefix !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value.context_prefix) ||
      typeof value.message !== 'string' || value.message.trim().length === 0) {
    throw new Error('creative_build_probe requires context_prefix (lowercase identifier) and a nonempty message');
  }
}

function containsSecretField(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > MAX_JSON_DEPTH) throw new Error('creative_build_probe: fixture nesting exceeds the JSON depth bound');
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('creative_build_probe: invalid URL in fixture'); }
    return !!(url.username || url.password) || [...url.searchParams.keys()].some(key => SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key));
  }
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) throw new Error('creative_build_probe: fixture must be acyclic JSON');
  seen.add(value);
  const found = Array.isArray(value)
    ? value.some(item => containsSecretField(item, depth + 1, seen))
    : Object.entries(value).some(([key, item]) => SECRET_KEY_PATTERN.test(key) || TRUST_FIELDS.test(key) || containsSecretField(item, depth + 1, seen));
  seen.delete(value);
  return found;
}

function validateInput(value: unknown, location: string, adcpVersion?: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !INPUT_FIELDS.has(key))) {
    throw new Error(`${location}: input may only contain message, creative_manifest, creative_id, transformer_id and config`);
  }
  if (containsSecretField(value)) throw new Error(`${location}: input must not carry credential or trust-material fields`);
  for (const key of ['message', 'creative_id', 'transformer_id']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].trim().length === 0)) {
      throw new Error(`${location}: ${key} must be a nonempty string`);
    }
  }
  if (value.config !== undefined && (!isRecord(value.config) || !value.transformer_id)) throw new Error(`${location}: this probe contract requires config to be an object bound to a provisioned transformer_id`);
  if (value.creative_id && value.creative_manifest) throw new Error(`${location}: this probe contract requires one unambiguous source, not both creative_id and creative_manifest`);
  if (value.creative_manifest !== undefined) {
    const manifest = value.creative_manifest;
    const validate = getSchemaValidatorByRef('core/creative-manifest.json', adcpVersion);
    if (!validate || !validate(manifest)) {
      throw new Error(`${location}: creative_manifest must be a complete manifest, including format and assets`);
    }
  }
  if (!value.message && !value.creative_manifest && !value.creative_id) {
    throw new Error(`${location}: input must identify a brief, source manifest or provisioned library creative`);
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
  governanceEnforcement?: unknown,
): CreativeBuildProbeResolution {
  validateCreativeBuildProbeSpec(spec);
  if (isRecord(creative) && creative.supported_formats !== undefined && !Array.isArray(creative.supported_formats)) {
    return { status: 'failed', detail: 'creative.supported_formats: malformed catalog (expected array)' };
  }
  if (!isRecord(creative) || !Array.isArray(creative.supported_formats)) {
    return { status: 'unsatisfied', detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no advertised creative build catalog` };
  }
  const recipes = isRecord(testKit) && testKit.creative_build_probes !== undefined
    ? testKit.creative_build_probes : [];
  if (!Array.isArray(recipes)) throw new Error('test_kit.creative_build_probes must be an array');
  const normalized = recipes.map((recipe: unknown, index: number) => {
    const location = `test_kit.creative_build_probes[${index}]`;
    if (!isRecord(recipe) || Object.keys(recipe).some(key => key !== 'match' && key !== 'input')) {
      throw new Error(`${location}: expected only match and input`);
    }
    const match = normalizeFixtureMatchExpression(recipe.match, `${location}.match`);
    if (match.length === 0) throw new Error(`${location}: at least one explicit match predicate is required`);
    validateInput(recipe.input, location, adcpVersion);
    return { match, input: recipe.input };
  });
  const ids = new Set<string>();
  const buildRoutes: Record<string, unknown>[] = [];
  for (const [index, entry] of creative.supported_formats.entries()) {
    const location = `creative.supported_formats[${index}]`;
    const invalid = (detail: string): CreativeBuildProbeResolution => ({ status: 'failed', detail: `${location}: ${detail}` });
    if (!isRecord(entry)) return invalid('malformed catalog entry (expected object)');
    if (!isRecord(entry.format) || typeof entry.format.format_kind !== 'string' || !isRecord(entry.format.params)) {
      return invalid('format must declare format_kind and params');
    }
    const validateFormat = getSchemaValidatorByRef('core/creative-operation-format-declaration.json', adcpVersion);
    const validateKind = getSchemaValidatorByRef('core/canonical-format-kind.json', adcpVersion);
    const validateParams = getSchemaValidatorByRef(`formats/canonical/${entry.format.format_kind}.json`, adcpVersion);
    if ((validateParams && !validateParams(entry.format.params)) || (validateFormat && !validateFormat(entry.format)) ||
        (validateKind && !validateKind(entry.format.format_kind)) ||
        (entry.format.technical_requirements_complete !== undefined && typeof entry.format.technical_requirements_complete !== 'boolean')) {
      return invalid(`malformed format declaration: ${[...(validateParams?.errors ?? []), ...(validateFormat?.errors ?? []), ...(validateKind?.errors ?? [])].map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
    }
    if (entry.capability_id !== undefined) {
      if (typeof entry.capability_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.capability_id) || ids.has(entry.capability_id)) {
        return invalid('capability_id must be usable and unique within the catalog');
      }
      ids.add(entry.capability_id);
    }
    const operations = entry.operations;
    if (operations !== undefined && (!Array.isArray(operations) || operations.length === 0 ||
        operations.some((operation, index) => typeof operation !== 'string' || !['build', 'validate', 'preview'].includes(operation) || operations.indexOf(operation) !== index))) {
      return invalid('operations must be a nonempty unique array of build, validate or preview');
    }
    if (entry.operations === undefined || (entry.operations as unknown[]).includes('build')) buildRoutes.push(entry);
  }
  if (isRecord(governanceEnforcement) && Array.isArray(governanceEnforcement.tasks) &&
      governanceEnforcement.tasks.some(task => isRecord(task) && task.task === 'build_creative' &&
        Array.isArray(task.modes) && task.modes.includes('signed_context'))) {
    return { status: 'unsatisfied', detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: payload-bound build governance authorization is not prepared by this runner contract` };
  }
  for (const route of buildRoutes) {
    if (typeof route.capability_id !== 'string') continue; // Legal legacy discoverable-only entry.
    let source: 'generation' | 'test_kit' = 'test_kit';
    const usable = (input: Record<string, unknown>) => {
      if (input.transformer_id) return creative.supports_transformers === true;
      if (input.creative_id) return creative.has_creative_library === true;
      if (input.creative_manifest) return creative.supports_transformation === true || creative.supports_generation === true;
      return creative.supports_generation === true;
    };
    const selectedRecipe = normalized.find(recipe => matchesFixtureRequirements(route, recipe.match) && usable(recipe.input));
    let input = selectedRecipe?.input;
    const format = route.format as Record<string, unknown>;
    const kindValidator = getSchemaValidatorByRef('core/canonical-format-kind.json', adcpVersion);
    const emptyCompleteFormat = format.technical_requirements_complete === true &&
      format.format_kind !== 'custom' && kindValidator?.(format.format_kind) === true &&
      Object.keys(format.params as Record<string, unknown>).length === 0 &&
      Object.keys(format).every(key => ['format_kind', 'params', 'technical_requirements_complete', 'display_name', 'seller_preference', 'experimental', 'sample_render_url', 'format_option_id', 'publisher_domain', 'applies_to_channels', 'canonical_formats_only'].includes(key)) &&
      Object.keys(route).every(key => ['capability_id', 'operations', 'format'].includes(key));
    if (!input && creative.supports_generation === true && buildRoutes.length === 1 && emptyCompleteFormat) {
      source = 'generation';
      const manifest = { format_kind: format.format_kind, assets: {} };
      const validateManifest = getSchemaValidatorByRef('core/creative-manifest.json', adcpVersion);
      if (!validateManifest?.(manifest)) continue;
      input = { message: spec.message, creative_manifest: manifest };
    }
    if (!input) continue;
    const context: StoryboardContext = {
      [`${spec.context_prefix}_capability_id`]: route.capability_id,
    };
    for (const key of ['message', 'creative_manifest', 'creative_id', 'transformer_id', 'config']) {
      if (input[key] !== undefined) context[`${spec.context_prefix}_${key}`] = structuredClone(input[key]);
    }
    return { status: 'resolved', capabilityId: route.capability_id, context, source, requirements: selectedRecipe?.match ?? [] };
  }
  return {
    status: 'unsatisfied',
    detail: `fixture_unsatisfied: creative_format:${spec.context_prefix}: no routable build entry has a known-valid generation input or a matching provisioned test-kit recipe`,
  };
}
