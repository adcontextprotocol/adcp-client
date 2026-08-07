import { isDeepStrictEqual } from 'node:util';
import { ADCP_VERSION } from '../../version';
import { getRequestSchemaEntityPaths, type SchemaEntityPath } from '../../validation/schema-loader';
import { productCanonicalFormatSatisfies } from './canonical-format-satisfaction';
import type {
  FixtureCanonicalFormatSelector,
  FixtureMatchClause,
  FixtureResolutionDeclaration,
  FixtureResolutionStrategy,
  PricingOptionFixtureResolutionDeclaration,
  Storyboard,
} from './types';

const OPERATORS = ['equals', 'present', 'contains_all', 'any_match', 'canonical_format_satisfies'] as const;
const DECLARATION_KEYS = new Set(['handle', 'strategies', 'where', 'allow_reuse']);
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
  } else {
    if (!hasValue) throw new Error(`${location}.value: is required for ${operator}`);
    if (hasWhere) throw new Error(`${location}.where: is only allowed for any_match`);
  }

  switch (operator) {
    case 'equals':
      return { path: value.path, operator, value: value.value };
    case 'present':
      if (typeof value.value !== 'boolean') throw new Error(`${location}.value: must be boolean for present`);
      return { path: value.path, operator, value: value.value };
    case 'contains_all':
      if (!Array.isArray(value.value)) throw new Error(`${location}.value: must be an array for contains_all`);
      return { path: value.path, operator, value: value.value };
    case 'any_match':
      return {
        path: value.path,
        operator,
        where: normalizeFixtureMatchExpression(value.where, `${location}.where`),
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

function validateDeclaration(declaration: unknown, location: string, allowedKeys: ReadonlySet<string>): void {
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
  const clauses = normalizeFixtureMatchExpression(declaration.where, `${location}.where`);
  if (Array.isArray(declaration.strategies) && declaration.strategies.includes('discover') && clauses.length === 0) {
    throw new Error(`${location}.where: discover strategy requires at least one authored predicate`);
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
      validateDeclaration(declaration, location, PRICING_DECLARATION_KEYS);
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
        return clause.value === true
          ? actual !== undefined && actual !== null
          : actual === undefined || actual === null;
      case 'contains_all':
        return (
          Array.isArray(actual) &&
          (clause.value as unknown[]).every(expected => actual.some(value => isDeepStrictEqual(value, expected)))
        );
      case 'any_match':
        return Array.isArray(actual) && actual.some(value => matchesFixtureRequirements(value, clause.where ?? []));
      case 'canonical_format_satisfies':
        return productCanonicalFormatSatisfies(actual, clause.value as Record<string, unknown>);
    }
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
    specs.push({
      entityType: 'product',
      handle,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: normalizeFixtureMatchExpression(declaration?.where, `fixture_resolution.products.${handle}.where`),
      allowReuse: declaration?.allow_reuse === true,
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
    specs.push({
      entityType: 'product_pricing_option',
      handle,
      parentProductHandle: parent,
      fixture: requirementFixture,
      strategies: [...(declaration?.strategies ?? ['seed'])],
      clauses: normalizeFixtureMatchExpression(
        declaration?.where,
        `fixture_resolution.pricing_options.${parent}/${handle}.where`
      ),
      allowReuse: declaration?.allow_reuse === true,
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
