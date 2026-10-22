import { isDeepStrictEqual } from 'node:util';
import { ADCP_VERSION } from '../../version';
import { getRequestSchemaEntityPaths, type SchemaEntityPath } from '../../validation/schema-loader';
import { productCanonicalFormatSatisfies } from './canonical-format-satisfaction';
import {
  COLLECTION_WITNESS_KINDS,
  evaluateCollectionSelection,
  normalizeCollectionSelectionSelector,
  type ResolvedCollectionSelectionSelector,
  type CollectionSelectionWitness,
  type CollectionWitnessKind,
} from './collection-selection';
import { parsePath } from './path';
import { assertWellFormedProtectedKey, isProtectedContextKey } from './protected-context';
import type {
  FixtureCanonicalFormatSelector,
  FixtureContextOutput,
  FixtureMatchClause,
  FixtureResolutionDeclaration,
  FixtureResolutionStrategy,
  PricingOptionFixtureResolutionDeclaration,
  Storyboard,
} from './types';

const OPERATORS = [
  'equals',
  'present',
  'contains_all',
  'any_match',
  'canonical_format_satisfies',
  'collection_selection_satisfies',
] as const;
const DECLARATION_KEYS = new Set(['handle', 'strategies', 'match', 'allow_reuse', 'context_outputs']);
const PRICING_DECLARATION_KEYS = new Set([...DECLARATION_KEYS, 'product_handle']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location}: must be an object`);
}

function assertArray(value: unknown, location: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location}: must be an array`);
}

function decodeJsonPointer(path: string, location: string): string[] {
  if (path !== '' && !path.startsWith('/')) {
    throw new Error(`${location}: must be an RFC 6901 JSON Pointer`);
  }
  if (path === '') return [];
  return path
    .slice(1)
    .split('/')
    .map(segment => {
      for (let i = 0; i < segment.length; i++) {
        if (segment[i] === '~' && segment[i + 1] !== '0' && segment[i + 1] !== '1') {
          throw new Error(`${location}: contains an invalid RFC 6901 escape`);
        }
        if (segment[i] === '~') i++;
      }
      return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

/** Normalize and validate the closed fixture matching DSL. */
export function normalizeFixtureMatchExpression(expression: unknown, location: string): FixtureMatchClause[] {
  if (expression === undefined) return [];
  assertArray(expression, location);
  if (expression.length === 0) throw new Error(`${location}: must contain at least one predicate`);
  return expression.map((clause, index) => normalizeClause(clause, `${location}[${index}]`));
}

function normalizeClause(value: unknown, location: string): FixtureMatchClause {
  assertPlainObject(value, location);
  const unknownKeys = Object.keys(value).filter(key => !['path', 'operator', 'value', 'where'].includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${location}: unknown key(s): ${unknownKeys.join(', ')}; the match DSL is closed`);
  }
  if (typeof value.path !== 'string') {
    throw new Error(`${location}.path: must be an RFC 6901 JSON Pointer string`);
  }
  decodeJsonPointer(value.path, `${location}.path`);
  if (typeof value.operator !== 'string' || !(OPERATORS as readonly string[]).includes(value.operator)) {
    throw new Error(`${location}.operator: must be one of ${OPERATORS.join(', ')}`);
  }
  const operator = value.operator as (typeof OPERATORS)[number];
  const hasValue = Object.hasOwn(value, 'value');
  const hasWhere = Object.hasOwn(value, 'where');
  if (operator === 'any_match') {
    if (hasValue) throw new Error(`${location}.value: is not allowed for any_match; use where`);
    if (!hasWhere) throw new Error(`${location}.where: is required for any_match`);
  } else if (operator === 'present') {
    if (hasValue) throw new Error(`${location}.value: is not allowed for present`);
    if (hasWhere) throw new Error(`${location}.where: is only allowed for any_match`);
  } else {
    if (!hasValue) throw new Error(`${location}.value: is required for ${operator}`);
    if (hasWhere) throw new Error(`${location}.where: is only allowed for any_match`);
  }

  switch (operator) {
    case 'equals':
      return { path: value.path, operator, value: value.value };
    case 'present':
      return { path: value.path, operator };
    case 'contains_all':
      if (!Array.isArray(value.value)) throw new Error(`${location}.value: must be an array for contains_all`);
      return { path: value.path, operator, value: value.value };
    case 'any_match':
      return {
        path: value.path,
        operator,
        where: normalizeFixtureMatchExpression(value.where, `${location}.where`),
      };
    case 'collection_selection_satisfies':
      return {
        path: value.path,
        operator,
        value: normalizeCollectionSelectionSelector(value.value, `${location}.value`),
      };
    case 'canonical_format_satisfies':
      assertPlainObject(value.value, `${location}.value`);
      if (typeof value.value.format_kind !== 'string' || value.value.format_kind.length === 0) {
        throw new Error(`${location}.value.format_kind: must be a non-empty string`);
      }
      if (value.value.params !== undefined && !isRecord(value.value.params)) {
        throw new Error(`${location}.value.params: must be an object when present`);
      }
      return { path: value.path, operator, value: value.value as FixtureCanonicalFormatSelector };
  }
}

function validateDeclaration(
  declaration: unknown,
  location: string,
  allowedKeys: ReadonlySet<string>,
  entityKind: 'product' | 'pricing_option' = 'product'
): void {
  assertPlainObject(declaration, location);
  const unknown = Object.keys(declaration).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${location}: unknown key(s): ${unknown.join(', ')}`);
  if (typeof declaration.handle !== 'string' || declaration.handle.length === 0) {
    throw new Error(`${location}.handle: must be a non-empty string`);
  }
  if (declaration.strategies !== undefined) {
    if (!Array.isArray(declaration.strategies) || declaration.strategies.length === 0) {
      throw new Error(`${location}.strategies: must be a non-empty array`);
    }
    for (let i = 0; i < declaration.strategies.length; i++) {
      const strategy: unknown = declaration.strategies[i];
      if (strategy !== 'seed' && strategy !== 'discover') {
        throw new Error(`${location}.strategies[${i}]: must be "seed" or "discover"`);
      }
      if (declaration.strategies.indexOf(strategy) !== i) {
        throw new Error(`${location}.strategies: duplicate strategy "${strategy}"`);
      }
    }
  }
  if (declaration.allow_reuse !== undefined && typeof declaration.allow_reuse !== 'boolean') {
    throw new Error(`${location}.allow_reuse: must be boolean`);
  }
  const clauses = normalizeFixtureMatchExpression(declaration.match, `${location}.match`);
  if (Array.isArray(declaration.strategies) && declaration.strategies.includes('discover') && clauses.length === 0) {
    throw new Error(`${location}.match: discover strategy requires at least one authored predicate`);
  }
  normalizeFixtureContextOutputs(declaration.context_outputs, `${location}.context_outputs`, clauses, entityKind);
}

const FIXTURE_CONTEXT_OUTPUT_KEYS = new Set(['key', 'path', 'witness', 'snapshot']);

/**
 * Validate the declaration-local capture block.
 *
 * A `witness:` entry is only authorable when the same declaration carries a
 * `collection_selection_satisfies` predicate — the witness is retained from
 * that evaluation, so asking for one without the predicate is an authoring
 * error rather than a runtime surprise on an agent that happens to answer
 * differently.
 */
export function normalizeFixtureContextOutputs(
  value: unknown,
  location: string,
  clauses: readonly FixtureMatchClause[],
  /**
   * `'pricing_option'` refuses `witness:` captures. A collection witness
   * describes a PRODUCT — its selectors, its pairs, its cross-publisher
   * relation — and a pricing option has none of its own. Accepting one
   * here loaded fine and then failed at run with a message about a missing
   * `collection_selection_satisfies` predicate that was right there in the
   * declaration, and the two strategies disagreed about it besides (seed
   * retained the parent's witness, discover did not). Declare the witness
   * on the parent product.
   */
  entityKind: 'product' | 'pricing_option' = 'product'
): FixtureContextOutput[] {
  if (value === undefined) return [];
  assertArray(value, location);
  if (value.length === 0) throw new Error(`${location}: must contain at least one capture when present`);
  const hasCollectionPredicate = clauses.some(clause => clause.operator === 'collection_selection_satisfies');
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const entryLocation = `${location}[${index}]`;
    assertPlainObject(raw, entryLocation);
    const unknown = Object.keys(raw).filter(key => !FIXTURE_CONTEXT_OUTPUT_KEYS.has(key));
    if (unknown.length > 0) {
      throw new Error(`${entryLocation}: unknown key(s): ${unknown.join(', ')}`);
    }
    if (typeof raw.key !== 'string' || raw.key.length === 0) {
      throw new Error(`${entryLocation}.key: must be a non-empty string`);
    }
    if (!isProtectedContextKey(raw.key)) {
      throw new Error(
        `${entryLocation}.key: fixture captures must use the reserved "__adcp_fixture_" prefix so later steps, caller context and seller responses cannot replace them; received "${raw.key}"`
      );
    }
    assertWellFormedProtectedKey(raw.key, entryLocation + '.key');
    if (seen.has(raw.key)) throw new Error(`${entryLocation}.key: duplicate capture key "${raw.key}"`);
    seen.add(raw.key);
    const forms = ['path', 'witness', 'snapshot'].filter(form => Object.hasOwn(raw, form));
    if (forms.length !== 1) {
      throw new Error(
        `${entryLocation}: must set exactly one of 'path', 'witness' or 'snapshot'; received ${forms.length === 0 ? 'none' : forms.join(' + ')}`
      );
    }
    const hasPath = forms[0] === 'path';
    if (forms[0] === 'snapshot') {
      if (raw.snapshot !== 'selected_entity') {
        throw new Error(`${entryLocation}.snapshot: must be 'selected_entity'`);
      }
      return { key: raw.key, snapshot: 'selected_entity' };
    }
    if (hasPath) {
      if (typeof raw.path !== 'string' || raw.path.length === 0) {
        throw new Error(`${entryLocation}.path: must be a non-empty string`);
      }
      // `match[].path` four lines up IS an RFC 6901 pointer, so mirroring
      // its style here is the natural mistake — and it loaded fine, ran
      // discovery, and only then failed with a message about a missing
      // field rather than a wrong grammar.
      if (raw.path.startsWith('/')) {
        throw new Error(
          `${entryLocation}.path: capture paths use the dotted storyboard grammar ("currency", "pricing_options[0].rate"), not the RFC 6901 pointers that match[].path takes; drop the leading "/" — received "${raw.path}"`
        );
      }
      // Validated against the RESOLVER, not against the dotted string.
      // Any path `parsePath` reduces to zero segments resolves to the
      // WHOLE selected entity, so a typo captured the entire product row
      // under a scalar's name — and unlike the `snapshot:` arm, a `path:`
      // capture does not run `redactSecrets`, so a credential-shaped
      // seller field would have been committed verbatim into protected
      // context. Checking the dotted string alone caught "." and "a..b"
      // but not "[]" or a path over the resolver's length bound, which
      // reach the same place.
      if (parsePath(raw.path).length === 0) {
        throw new Error(
          `${entryLocation}.path: must name at least one field in the dotted storyboard grammar ("currency", "pricing_options[0].rate") — received "${raw.path}", which resolves to the whole selected entity. To capture the whole entity, say so: snapshot: 'selected_entity'.`
        );
      }
      // Narrower, and kept for the message: a trailing or doubled dot
      // ("ext.", ".ext", "a..b") still parses to real segments, so the
      // check above lets it through while the author's intent is plainly
      // a typo rather than a whole-entity capture.
      if (raw.path.split('.').some(segment => segment.length === 0)) {
        throw new Error(`${entryLocation}.path: every dotted segment must name a field — received "${raw.path}".`);
      }
      return { key: raw.key, path: raw.path };
    }
    if (typeof raw.witness !== 'string' || !(COLLECTION_WITNESS_KINDS as readonly string[]).includes(raw.witness)) {
      throw new Error(`${entryLocation}.witness: must be one of ${COLLECTION_WITNESS_KINDS.join(', ')}`);
    }
    if (entityKind === 'pricing_option') {
      throw new Error(
        `${entryLocation}.witness: a collection witness describes the product, not one of its pricing options; declare it under fixture_resolution.products.<product_handle>.context_outputs instead`
      );
    }
    if (!hasCollectionPredicate) {
      throw new Error(
        `${entryLocation}.witness: requires a collection_selection_satisfies predicate on the same declaration`
      );
    }
    return { key: raw.key, witness: raw.witness as CollectionWitnessKind };
  });
}

/** Loader/runtime authoring validation for the AdCP 3.2 declaration block. */
export function validateFixtureResolutionDeclarations(storyboard: Storyboard): void {
  const root = storyboard.fixture_resolution;
  if (root === undefined) {
    assertNoReservedOrdinaryKeys(storyboard);
    return;
  }
  assertPlainObject(root, `[${storyboard.id}] fixture_resolution`);
  const unknownRoot = Object.keys(root).filter(key => key !== 'products' && key !== 'pricing_options');
  if (unknownRoot.length > 0) {
    throw new Error(`[${storyboard.id}] fixture_resolution: unknown key(s): ${unknownRoot.join(', ')}`);
  }

  const productFixtures = new Set<string>();
  for (const fixture of storyboard.fixtures?.products ?? []) {
    const handle = fixture.product_id;
    if (typeof handle !== 'string' || handle.length === 0) continue;
    if (productFixtures.has(handle)) {
      throw new Error(`[${storyboard.id}] fixtures.products: duplicate fixture handle "${handle}"`);
    }
    productFixtures.add(handle);
  }
  const pricingFixtures = new Set<string>();
  for (const fixture of storyboard.fixtures?.pricing_options ?? []) {
    if (
      typeof fixture.product_id !== 'string' ||
      fixture.product_id.length === 0 ||
      typeof fixture.pricing_option_id !== 'string' ||
      fixture.pricing_option_id.length === 0
    ) {
      continue;
    }
    const key = `${fixture.product_id}\0${fixture.pricing_option_id}`;
    if (pricingFixtures.has(key)) {
      throw new Error(
        `[${storyboard.id}] fixtures.pricing_options: duplicate fixture handle "${fixture.product_id}/${fixture.pricing_option_id}"`
      );
    }
    pricingFixtures.add(key);
  }

  if (root.products !== undefined) {
    assertArray(root.products, `[${storyboard.id}] fixture_resolution.products`);
    const seen = new Set<string>();
    for (let index = 0; index < root.products.length; index++) {
      const declaration = root.products[index];
      const location = `[${storyboard.id}] fixture_resolution.products[${index}]`;
      validateDeclaration(declaration, location, DECLARATION_KEYS);
      const typedDeclaration = declaration as FixtureResolutionDeclaration;
      const handle = typedDeclaration.handle;
      if (seen.has(handle)) throw new Error(`${location}.handle: duplicate product handle "${handle}"`);
      seen.add(handle);
      if (!productFixtures.has(handle)) {
        throw new Error(`${location}.handle: no matching fixtures.products handle "${handle}"`);
      }
    }
  }

  if (root.pricing_options !== undefined) {
    assertArray(root.pricing_options, `[${storyboard.id}] fixture_resolution.pricing_options`);
    const seen = new Set<string>();
    for (let index = 0; index < root.pricing_options.length; index++) {
      const declaration = root.pricing_options[index];
      const location = `[${storyboard.id}] fixture_resolution.pricing_options[${index}]`;
      validateDeclaration(declaration, location, PRICING_DECLARATION_KEYS, 'pricing_option');
      const typedDeclaration = declaration as PricingOptionFixtureResolutionDeclaration;
      if (typeof typedDeclaration.product_handle !== 'string' || typedDeclaration.product_handle.length === 0) {
        throw new Error(`${location}.product_handle: must be a non-empty string`);
      }
      const key = `${typedDeclaration.product_handle}\0${typedDeclaration.handle}`;
      if (seen.has(key)) {
        throw new Error(`${location}.handle: duplicate pricing-option handle "${typedDeclaration.handle}"`);
      }
      seen.add(key);
      if (!pricingFixtures.has(key)) {
        throw new Error(
          `${location}.handle: no matching fixtures.pricing_options entry for product handle "${typedDeclaration.product_handle}"`
        );
      }
    }
  }

  assertNoReservedOrdinaryKeys(storyboard);
  assertUniqueFixtureCaptureKeys(storyboard);
}

/**
 * The reserved namespace is owned by fixture preparation, so every ordinary
 * authoring surface that writes context must stay out of it. Caught at load,
 * before any discovery call — the runtime write funnel enforces the same rule
 * independently for values that only exist at run time.
 */
function assertNoReservedOrdinaryKeys(storyboard: Storyboard): void {
  const reject = (key: string, location: string): void => {
    if (isProtectedContextKey(key)) {
      throw new Error(
        `${location}: "${key}" uses the reserved "__adcp_fixture_" prefix, which is owned by fixture preparation. Rename it to any key not starting with "__adcp_fixture_".`
      );
    }
    // Prototype-sensitive names are refused everywhere a context key is
    // authored: they can shadow a reserved key through the prototype chain
    // rather than through an own property.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(
        `${location}: "${key}" is a prototype-sensitive context key and cannot be used; rename it to anything other than __proto__, constructor or prototype`
      );
    }
  };
  for (const key of Object.keys(storyboard.context ?? {})) {
    reject(key, `[${storyboard.id}] context`);
  }
  // `creative_build_probe.context_prefix` needs no reserved-prefix check:
  // `validateCreativeBuildProbeSpec` already constrains it to a lowercase
  // identifier, which cannot start with `__`. Adding a second rule here
  // would be unreachable code that looks like protection.
  for (const phase of storyboard.phases ?? []) {
    for (const step of phase.steps ?? []) {
      for (const output of step.context_outputs ?? []) {
        if (typeof output.key !== 'string') continue;
        if (isProtectedContextKey(output.key)) {
          throw new Error(
            `[${storyboard.id}] phase '${phase.id}' step '${step.id}': context_outputs entry "${output.key}" uses the reserved "__adcp_fixture_" prefix; step captures cannot write fixture-preparation state. Declare it under fixture_resolution instead, or rename the key.`
          );
        }
        reject(output.key, `[${storyboard.id}] phase '${phase.id}' step '${step.id}' context_outputs`);
      }
      // `not_applicable_if[].context_keys` names keys the runner marks
      // unavailable at run time, which is a metadata write against the same
      // namespace.
      const gates = step.not_applicable_if;
      for (const gate of gates === undefined ? [] : Array.isArray(gates) ? gates : [gates]) {
        for (const key of gate.context_keys ?? []) {
          if (typeof key === 'string') {
            reject(key, `[${storyboard.id}] phase '${phase.id}' step '${step.id}' not_applicable_if.context_keys`);
          }
        }
      }
    }
  }
}

/** Two declarations cannot publish the same reserved key. */
function assertUniqueFixtureCaptureKeys(storyboard: Storyboard): void {
  const owners = new Map<string, string>();
  const claim = (key: string, owner: string): void => {
    const existing = owners.get(key);
    if (existing !== undefined) {
      throw new Error(
        `[${storyboard.id}] fixture_resolution: capture key "${key}" is declared by both ${existing} and ${owner}`
      );
    }
    owners.set(key, owner);
  };
  for (const declaration of storyboard.fixture_resolution?.products ?? []) {
    for (const output of declaration.context_outputs ?? []) {
      claim(output.key, `products."${declaration.handle}"`);
    }
  }
  for (const declaration of storyboard.fixture_resolution?.pricing_options ?? []) {
    for (const output of declaration.context_outputs ?? []) {
      claim(output.key, `pricing_options."${declaration.product_handle}/${declaration.handle}"`);
    }
  }
}

function resolveCandidatePath(candidate: unknown, pointer: string): unknown {
  let current = candidate;
  for (const segment of decodeJsonPointer(pointer, 'fixture predicate path')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True when a seller catalog entity satisfies every authored clause. */
export function matchesFixtureRequirements(candidate: unknown, clauses: readonly FixtureMatchClause[]): boolean {
  return clauses.every(clause => {
    const actual = resolveCandidatePath(candidate, clause.path);
    switch (clause.operator) {
      case 'equals':
        return isDeepStrictEqual(actual, clause.value);
      case 'present':
        return actual !== undefined && actual !== null;
      case 'contains_all':
        return (
          Array.isArray(actual) &&
          (clause.value as unknown[]).every(expected => actual.some(value => isDeepStrictEqual(value, expected)))
        );
      case 'any_match':
        return Array.isArray(actual) && actual.some(value => matchesFixtureRequirements(value, clause.where ?? []));
      case 'canonical_format_satisfies':
        return productCanonicalFormatSatisfies(actual, clause.value as Record<string, unknown>);
      case 'collection_selection_satisfies':
        return evaluateCollectionSelection(actual, clause.value as ResolvedCollectionSelectionSelector).eligible;
    }
  });
}

/**
 * Match a candidate and retain the collection witness for it.
 *
 * The boolean `matchesFixtureRequirements` keeps its signature for existing
 * callers. This variant exists so the resolver can retain the witness for the
 * candidate it *actually selects*, rather than recomputing one later from an
 * unrelated response — which is precisely how a selected-entity snapshot
 * drifts away from the entity that was purchased.
 */
export function matchFixtureRequirementsWithWitness(
  candidate: unknown,
  clauses: readonly FixtureMatchClause[]
): { matched: boolean; witness?: CollectionSelectionWitness; reason?: string } {
  let witness: CollectionSelectionWitness | undefined;
  let matched = true;
  let reason: string | undefined;
  for (const clause of clauses) {
    if (clause.operator !== 'collection_selection_satisfies') {
      // Keep evaluating rather than returning: a collection clause authored
      // AFTER a failing ordinary clause must still produce its witness, or
      // a downstream `witness:` capture reports "requires a
      // collection_selection_satisfies predicate" about a predicate that is
      // right there. Clause order must not change the diagnostic.
      if (matched && !matchesFixtureRequirements(candidate, [clause])) {
        matched = false;
        // Name the clause that actually rejected the candidate. Almost no
        // declaration is a lone collection predicate, so without this the
        // common case collapses into one generic bucket.
        reason = `${clause.operator} at "${clause.path || '(whole candidate)'}" did not match`;
      }
      continue;
    }
    const actual = resolveCandidatePath(candidate, clause.path);
    const evaluation = evaluateCollectionSelection(actual, clause.value as ResolvedCollectionSelectionSelector);
    if (!evaluation.eligible) {
      if (matched) reason = evaluation.reason;
      matched = false;
      continue;
    }
    // Multiple predicates on one declaration are legal; the last evaluated
    // witness wins deterministically because clause order is authored.
    witness = evaluation.witness;
  }
  return {
    matched,
    ...(witness && { witness }),
    ...(reason !== undefined && { reason }),
  };
}

export interface FixtureResolutionSpec {
  entityType: 'product' | 'product_pricing_option';
  handle: string;
  parentProductHandle?: string;
  fixture: Record<string, unknown>;
  strategies: FixtureResolutionStrategy[];
  clauses: FixtureMatchClause[];
  allowReuse: boolean;
  /** Declaration-local captures published after the whole graph resolves. */
  contextOutputs: FixtureContextOutput[];
}

/** Normalize fixture rows + optional metadata into the ordered handle list. */
export function buildFixtureResolutionSpecs(storyboard: Storyboard): FixtureResolutionSpec[] {
  const specs: FixtureResolutionSpec[] = [];
  const productFixtures = new Map(
    (storyboard.fixtures?.products ?? [])
      .filter(fixture => typeof fixture.product_id === 'string' && fixture.product_id.length > 0)
      .map(fixture => [fixture.product_id!, fixture])
  );
  const pricingFixtures = new Map(
    (storyboard.fixtures?.pricing_options ?? [])
      .filter(
        fixture =>
          typeof fixture.product_id === 'string' &&
          fixture.product_id.length > 0 &&
          typeof fixture.pricing_option_id === 'string' &&
          fixture.pricing_option_id.length > 0
      )
      .map(fixture => [`${fixture.product_id}\0${fixture.pricing_option_id}`, fixture])
  );
  const declaredProducts = storyboard.fixture_resolution?.products ?? [];
  const declaredProductHandles = new Set(declaredProducts.map(declaration => declaration.handle));
  const orderedProducts = [
    ...declaredProducts.map(declaration => ({ fixture: productFixtures.get(declaration.handle), declaration })),
    ...(storyboard.fixtures?.products ?? [])
      .filter(
        fixture =>
          typeof fixture.product_id === 'string' &&
          fixture.product_id.length > 0 &&
          !declaredProductHandles.has(fixture.product_id)
      )
      .map(fixture => ({ fixture, declaration: undefined })),
  ];
  for (const { fixture, declaration } of orderedProducts) {
    if (!fixture) continue;
    if (typeof fixture.product_id !== 'string' || fixture.product_id.length === 0) continue;
    const { product_id: handle, ...requirementFixture } = fixture;
    const productClauses = normalizeFixtureMatchExpression(
      declaration?.match,
      `fixture_resolution.products.${handle}.match`
    );
    specs.push({
      entityType: 'product',
      handle,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: productClauses,
      allowReuse: declaration?.allow_reuse === true,
      contextOutputs: normalizeFixtureContextOutputs(
        declaration?.context_outputs,
        `fixture_resolution.products.${handle}.context_outputs`,
        productClauses
      ),
    });
  }
  const declaredPricing = storyboard.fixture_resolution?.pricing_options ?? [];
  const declaredPricingHandles = new Set(
    declaredPricing.map(declaration => `${declaration.product_handle}\0${declaration.handle}`)
  );
  const orderedPricing = [
    ...declaredPricing.map(declaration => ({
      fixture: pricingFixtures.get(`${declaration.product_handle}\0${declaration.handle}`),
      declaration,
    })),
    ...(storyboard.fixtures?.pricing_options ?? [])
      .filter(
        fixture =>
          typeof fixture.product_id === 'string' &&
          fixture.product_id.length > 0 &&
          typeof fixture.pricing_option_id === 'string' &&
          fixture.pricing_option_id.length > 0 &&
          !declaredPricingHandles.has(`${fixture.product_id}\0${fixture.pricing_option_id}`)
      )
      .map(fixture => ({ fixture, declaration: undefined })),
  ];
  for (const { fixture, declaration } of orderedPricing) {
    if (!fixture) continue;
    const parent = fixture.product_id;
    const handle = fixture.pricing_option_id;
    if (typeof parent !== 'string' || !parent || typeof handle !== 'string' || !handle) continue;
    const { product_id: _parent, pricing_option_id: _handle, ...requirementFixture } = fixture;
    const pricingClauses = normalizeFixtureMatchExpression(
      declaration?.match,
      `fixture_resolution.pricing_options.${parent}/${handle}.match`
    );
    specs.push({
      entityType: 'product_pricing_option',
      handle,
      parentProductHandle: parent,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: pricingClauses,
      allowReuse: declaration?.allow_reuse === true,
      contextOutputs: normalizeFixtureContextOutputs(
        declaration?.context_outputs,
        `fixture_resolution.pricing_options.${parent}/${handle}.context_outputs`,
        pricingClauses,
        'pricing_option'
      ),
    });
  }
  return specs;
}

/** Run-scoped, pinned handle bindings. */
export class FixtureBindingRegistry {
  private readonly products = new Map<string, string>();
  private readonly productHandlesBySellerId = new Map<string, Set<string>>();
  private readonly pricingOptions = new Map<string, string>();
  private readonly pricingScopesByHandle = new Map<string, Set<string>>();

  bindProduct(handle: string, sellerProductId: string): void {
    const existing = this.products.get(handle);
    if (existing !== undefined && existing !== sellerProductId) {
      throw new Error(`fixture product handle "${handle}" is already pinned to "${existing}"`);
    }
    this.products.set(handle, sellerProductId);
    const handles = this.productHandlesBySellerId.get(sellerProductId) ?? new Set<string>();
    handles.add(handle);
    this.productHandlesBySellerId.set(sellerProductId, handles);
  }

  bindPricingOption(parentHandle: string, handle: string, sellerPricingOptionId: string): void {
    const key = `${parentHandle}\0${handle}`;
    const existing = this.pricingOptions.get(key);
    if (existing !== undefined && existing !== sellerPricingOptionId) {
      throw new Error(`fixture pricing-option handle "${parentHandle}/${handle}" is already pinned to "${existing}"`);
    }
    this.pricingOptions.set(key, sellerPricingOptionId);
    const scopes = this.pricingScopesByHandle.get(handle) ?? new Set<string>();
    scopes.add(parentHandle);
    this.pricingScopesByHandle.set(handle, scopes);
  }

  productId(handle: string): string | undefined {
    return this.products.get(handle);
  }

  productHandle(value: string): string | undefined {
    if (this.products.has(value)) return value;
    const handles = this.productHandlesBySellerId.get(value);
    if (!handles || handles.size === 0) return undefined;
    if (handles.size > 1) {
      throw new Error(`ambiguous seller product_id "${value}" maps to fixture handles: ${[...handles].join(', ')}`);
    }
    return [...handles][0];
  }

  pricingOptionId(handle: string, parentValue?: string): string | undefined {
    if (parentValue !== undefined) {
      const directParent = this.products.has(parentValue)
        ? new Set([parentValue])
        : this.productHandlesBySellerId.get(parentValue);
      if (directParent) {
        const sellerIds = new Set(
          [...directParent]
            .map(parentHandle => this.pricingOptions.get(`${parentHandle}\0${handle}`))
            .filter((value): value is string => value !== undefined)
        );
        if (sellerIds.size === 1) return [...sellerIds][0];
        if (sellerIds.size > 1) {
          throw new Error(`ambiguous pricing-option fixture handle "${handle}" for seller product_id "${parentValue}"`);
        }
        return undefined;
      }
    }
    const scopes = this.pricingScopesByHandle.get(handle);
    if (!scopes || scopes.size === 0) return undefined;
    if (scopes.size > 1) {
      throw new Error(
        `ambiguous unscoped pricing-option fixture handle "${handle}"; scope it with its parent product_id`
      );
    }
    return this.pricingOptions.get(`${[...scopes][0]}\0${handle}`);
  }
}

interface RequestTarget {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  value: unknown;
  ancestors: Array<Record<string, unknown> | unknown[]>;
}

function targetsAtPath(root: unknown, path: readonly string[]): RequestTarget[] {
  const targets: RequestTarget[] = [];
  const walk = (value: unknown, index: number, ancestors: Array<Record<string, unknown> | unknown[]>): void => {
    if (index >= path.length) return;
    const segment = path[index]!;
    if (segment === '*') {
      if (!Array.isArray(value)) return;
      for (let i = 0; i < value.length; i++) {
        if (index === path.length - 1) targets.push({ parent: value, key: i, value: value[i], ancestors });
        else walk(value[i], index + 1, [...ancestors, value]);
      }
      return;
    }
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return;
    if (index === path.length - 1) {
      targets.push({ parent: value, key: segment, value: value[segment], ancestors });
    } else {
      walk(value[segment], index + 1, [...ancestors, value]);
    }
  };
  walk(root, 0, []);
  return targets;
}

function nearestProductScope(target: RequestTarget): string | undefined {
  const containers = [...target.ancestors, target.parent].reverse();
  for (const container of containers) {
    if (isRecord(container) && typeof container.product_id === 'string') return container.product_id;
  }
  return undefined;
}

/**
 * Replace exact handles only at request-schema leaves carrying the matching
 * `x-entity` annotation. Pricing-option replacement runs first so its parent
 * scope is read before the sibling product handle is rewritten.
 */
export function applyFixtureBindingsToRequest(
  request: Record<string, unknown>,
  toolName: string,
  bindings: FixtureBindingRegistry | undefined,
  version: string = ADCP_VERSION,
  entityPaths?: readonly SchemaEntityPath[]
): Record<string, unknown> {
  if (!bindings) return request;
  const paths = entityPaths ?? getRequestSchemaEntityPaths(toolName, version);
  if (paths.length === 0) return request;
  const clone = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  const relevant = paths.filter(path => path.xEntity === 'product' || path.xEntity === 'product_pricing_option');
  relevant.sort((a, b) => Number(a.xEntity === 'product') - Number(b.xEntity === 'product'));
  for (const entityPath of relevant) {
    for (const target of targetsAtPath(clone, entityPath.path)) {
      if (typeof target.value !== 'string') continue;
      const replacement =
        entityPath.xEntity === 'product'
          ? bindings.productId(target.value)
          : bindings.pricingOptionId(target.value, nearestProductScope(target));
      if (replacement === undefined) continue;
      (target.parent as Record<string | number, unknown>)[target.key] = replacement;
    }
  }
  return clone;
}
