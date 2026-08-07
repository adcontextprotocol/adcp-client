import { isDeepStrictEqual } from 'node:util';
import { ADCP_VERSION } from '../../version';
import { getRequestSchemaEntityPaths, type SchemaEntityPath } from '../../validation/schema-loader';
import { productCanonicalFormatSatisfies } from './canonical-format-satisfaction';
import type {
  FixtureMatchClause,
  FixtureResolutionDeclaration,
  FixtureResolutionStrategy,
  PricingOptionFixtureResolutionDeclaration,
  ProductFixtureResolutionDeclaration,
  Storyboard,
} from './types';

const MATCHERS = ['equals', 'present', 'contains_all', 'any_match', 'canonical_format_satisfies'] as const;
const DECLARATION_KEYS = new Set(['strategies', 'match', 'allow_reuse']);
const PRODUCT_DECLARATION_KEYS = new Set([...DECLARATION_KEYS, 'pricing_options']);
const PRICING_DECLARATION_KEYS = new Set([...DECLARATION_KEYS, 'product_handle', 'product_id']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location}: must be an object`);
}

/** Normalize and validate the closed fixture matching DSL. */
export function normalizeFixtureMatchExpression(expression: unknown, location: string): FixtureMatchClause[] {
  if (expression === undefined) return [];
  if (Array.isArray(expression)) {
    if (expression.length === 0) throw new Error(`${location}: must contain at least one match clause`);
    return expression.map((clause, index) => normalizeClause(clause, `${location}[${index}]`));
  }
  assertPlainObject(expression, location);
  const entries = Object.entries(expression);
  if (entries.length === 0) throw new Error(`${location}: must contain at least one field matcher`);
  return entries.map(([path, matcher]) => {
    if (path.length === 0) throw new Error(`${location}: field paths must be non-empty strings`);
    assertPlainObject(matcher, `${location}.${path}`);
    return normalizeClause({ path, ...matcher }, `${location}.${path}`);
  });
}

function normalizeClause(value: unknown, location: string): FixtureMatchClause {
  assertPlainObject(value, location);
  const unknownKeys = Object.keys(value).filter(
    key => key !== 'path' && !(MATCHERS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${location}: unknown key(s): ${unknownKeys.join(', ')}; the match DSL is closed`);
  }
  const matcherKeys = MATCHERS.filter(key => Object.hasOwn(value, key));
  if (matcherKeys.length !== 1) {
    throw new Error(`${location}: must declare exactly one of ${MATCHERS.join(', ')}`);
  }
  const matcher = matcherKeys[0]!;
  const path = value.path;
  if (matcher !== 'canonical_format_satisfies' && (typeof path !== 'string' || path.length === 0)) {
    throw new Error(`${location}.path: must be a non-empty string`);
  }
  if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
    throw new Error(`${location}.path: must be a non-empty string when present`);
  }

  switch (matcher) {
    case 'equals':
      return { path: path as string, equals: value.equals };
    case 'present':
      if (typeof value.present !== 'boolean') throw new Error(`${location}.present: must be boolean`);
      return { path: path as string, present: value.present };
    case 'contains_all':
      if (!Array.isArray(value.contains_all)) throw new Error(`${location}.contains_all: must be an array`);
      return { path: path as string, contains_all: value.contains_all };
    case 'any_match':
      return {
        path: path as string,
        any_match: normalizeFixtureMatchExpression(value.any_match, `${location}.any_match`),
      };
    case 'canonical_format_satisfies':
      assertPlainObject(value.canonical_format_satisfies, `${location}.canonical_format_satisfies`);
      if (
        typeof value.canonical_format_satisfies.format_kind !== 'string' ||
        value.canonical_format_satisfies.format_kind.length === 0
      ) {
        throw new Error(`${location}.canonical_format_satisfies.format_kind: must be a non-empty string`);
      }
      if (value.canonical_format_satisfies.params !== undefined && !isRecord(value.canonical_format_satisfies.params)) {
        throw new Error(`${location}.canonical_format_satisfies.params: must be an object when present`);
      }
      return {
        ...(typeof path === 'string' && { path }),
        canonical_format_satisfies: value.canonical_format_satisfies,
      };
  }
}

function validateDeclaration(
  declaration: unknown,
  location: string,
  allowedKeys: ReadonlySet<string>
): asserts declaration is FixtureResolutionDeclaration {
  assertPlainObject(declaration, location);
  const unknown = Object.keys(declaration).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${location}: unknown key(s): ${unknown.join(', ')}`);
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
    throw new Error(`${location}.match: discover strategy requires at least one authored requirement clause`);
  }
}

/** Loader/runtime authoring validation for the AdCP 3.2 declaration block. */
export function validateFixtureResolutionDeclarations(storyboard: Storyboard): void {
  const root = storyboard.fixture_resolution;
  if (root === undefined) return;
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
    assertPlainObject(root.products, `[${storyboard.id}] fixture_resolution.products`);
    for (const [handle, declaration] of Object.entries(root.products)) {
      if (!productFixtures.has(handle)) {
        throw new Error(
          `[${storyboard.id}] fixture_resolution.products.${handle}: no matching fixtures.products handle`
        );
      }
      const location = `[${storyboard.id}] fixture_resolution.products.${handle}`;
      validateDeclaration(declaration, location, PRODUCT_DECLARATION_KEYS);
      const productDeclaration = declaration as unknown as ProductFixtureResolutionDeclaration;
      if (productDeclaration.pricing_options !== undefined) {
        assertPlainObject(productDeclaration.pricing_options, `${location}.pricing_options`);
        for (const [pricingHandle, pricingDeclaration] of Object.entries(productDeclaration.pricing_options)) {
          if (!pricingFixtures.has(`${handle}\0${pricingHandle}`)) {
            throw new Error(
              `${location}.pricing_options.${pricingHandle}: no matching fixtures.pricing_options handle`
            );
          }
          validateDeclaration(
            pricingDeclaration,
            `${location}.pricing_options.${pricingHandle}`,
            PRICING_DECLARATION_KEYS
          );
        }
      }
    }
  }

  if (root.pricing_options !== undefined) {
    assertPlainObject(root.pricing_options, `[${storyboard.id}] fixture_resolution.pricing_options`);
    for (const [key, declaration] of Object.entries(root.pricing_options)) {
      const location = `[${storyboard.id}] fixture_resolution.pricing_options.${key}`;
      validateDeclaration(declaration, location, PRICING_DECLARATION_KEYS);
      const pricing = declaration as unknown as PricingOptionFixtureResolutionDeclaration;
      const parent = pricing.product_handle ?? pricing.product_id;
      if (typeof parent !== 'string' || parent.length === 0) {
        throw new Error(`${location}: requires product_handle (or product_id compatibility spelling)`);
      }
      if (!pricingFixtures.has(`${parent}\0${key}`)) {
        throw new Error(`${location}: no matching fixtures.pricing_options entry for product handle "${parent}"`);
      }
    }
  }
}

function resolveCandidatePath(candidate: unknown, dottedPath: string | undefined): unknown {
  if (!dottedPath) return candidate;
  let current = candidate;
  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True when a seller catalog entity satisfies every authored clause. */
export function matchesFixtureRequirements(candidate: unknown, clauses: readonly FixtureMatchClause[]): boolean {
  return clauses.every(clause => {
    const actual = resolveCandidatePath(candidate, clause.path);
    if ('equals' in clause) return isDeepStrictEqual(actual, clause.equals);
    if ('present' in clause)
      return clause.present ? actual !== undefined && actual !== null : actual === undefined || actual === null;
    if ('contains_all' in clause) {
      return (
        Array.isArray(actual) &&
        clause.contains_all.every(expected => actual.some(value => isDeepStrictEqual(value, expected)))
      );
    }
    if ('any_match' in clause) {
      return (
        Array.isArray(actual) &&
        actual.some(value => matchesFixtureRequirements(value, clause.any_match as FixtureMatchClause[]))
      );
    }
    const formatCandidate = clause.path === undefined ? candidate : actual;
    return productCanonicalFormatSatisfies(formatCandidate, clause.canonical_format_satisfies);
  });
}

export interface FixtureResolutionSpec {
  entityType: 'product' | 'product_pricing_option';
  handle: string;
  parentProductHandle?: string;
  fixture: Record<string, unknown>;
  strategies: FixtureResolutionStrategy[];
  clauses: FixtureMatchClause[];
  allowReuse: boolean;
}

/** Normalize fixture rows + optional metadata into the ordered handle list. */
export function buildFixtureResolutionSpecs(storyboard: Storyboard): FixtureResolutionSpec[] {
  const specs: FixtureResolutionSpec[] = [];
  for (const fixture of storyboard.fixtures?.products ?? []) {
    if (typeof fixture.product_id !== 'string' || fixture.product_id.length === 0) continue;
    const declaration = storyboard.fixture_resolution?.products?.[fixture.product_id];
    const { product_id: handle, ...requirementFixture } = fixture;
    specs.push({
      entityType: 'product',
      handle,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: normalizeFixtureMatchExpression(declaration?.match, `fixture_resolution.products.${handle}.match`),
      allowReuse: declaration?.allow_reuse === true,
    });
  }
  for (const fixture of storyboard.fixtures?.pricing_options ?? []) {
    const parent = fixture.product_id;
    const handle = fixture.pricing_option_id;
    if (typeof parent !== 'string' || !parent || typeof handle !== 'string' || !handle) continue;
    const nested = storyboard.fixture_resolution?.products?.[parent]?.pricing_options?.[handle];
    const root = storyboard.fixture_resolution?.pricing_options?.[handle];
    const declaration = nested ?? ((root?.product_handle ?? root?.product_id) === parent ? root : undefined);
    const { product_id: _parent, pricing_option_id: _handle, ...requirementFixture } = fixture;
    specs.push({
      entityType: 'product_pricing_option',
      handle,
      parentProductHandle: parent,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: normalizeFixtureMatchExpression(
        declaration?.match,
        `fixture_resolution.products.${parent}.pricing_options.${handle}.match`
      ),
      allowReuse: declaration?.allow_reuse === true,
    });
  }
  return specs;
}

/** Run-scoped, pinned handle bindings. */
export class FixtureBindingRegistry {
  private readonly products = new Map<string, string>();
  private readonly productHandlesBySellerId = new Map<string, string>();
  private readonly pricingOptions = new Map<string, string>();
  private readonly pricingScopesByHandle = new Map<string, Set<string>>();

  bindProduct(handle: string, sellerProductId: string): void {
    const existing = this.products.get(handle);
    if (existing !== undefined && existing !== sellerProductId) {
      throw new Error(`fixture product handle "${handle}" is already pinned to "${existing}"`);
    }
    this.products.set(handle, sellerProductId);
    this.productHandlesBySellerId.set(sellerProductId, handle);
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
    return this.products.has(value) ? value : this.productHandlesBySellerId.get(value);
  }

  pricingOptionId(handle: string, parentValue?: string): string | undefined {
    const parentHandle = parentValue === undefined ? undefined : this.productHandle(parentValue);
    if (parentHandle) return this.pricingOptions.get(`${parentHandle}\0${handle}`);
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
