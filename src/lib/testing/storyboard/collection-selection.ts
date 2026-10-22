/**
 * Domain-qualified collection identity: one normalizer, one eligibility
 * predicate, one witness builder, one set comparison.
 *
 * Every consumer of collection identity in the runner goes through this
 * module — the fixture predicate (`collection_selection_satisfies`), the
 * derived witness captures published by fixture preparation, and the
 * `collection_set_equals_context` validator. Splitting those three would let
 * "what counts as the same collection" drift between selection and grading,
 * which is exactly the failure the upstream contract calls out.
 *
 * Identity rules, and the reasons they are what they are:
 *
 *   - A selector is normalized to atomic `(publisher_domain, collection_id)`
 *     pairs. IDs are never flattened without their domain: two publishers may
 *     legitimately declare the same `collection_id`.
 *   - `collection_ids` is optional on `CollectionSelector` and means "every
 *     collection declared in that domain's adagents.json". That bulk-grant
 *     form is a *different* selector from an explicit enumeration, so it
 *     normalizes to a pair with `collection_id: null` rather than silently
 *     comparing equal to an enumerated set. Product composition is required
 *     to name explicit ids, so `null` pairs do not count toward
 *     `minimum_pairs`.
 *   - Schema-valid redundancy collapses: repeated ids inside one selector,
 *     and overlapping atomic pairs across differently-grouped selectors, are
 *     one pair. Neither `product.collections[]` nor `collection_ids[]`
 *     carries a uniqueness constraint, so redundancy is legal *product
 *     composition*. The readback arm is stricter:
 *     `core/collection-selection.json` declares `uniqueItems: true` on
 *     `collections` in `mode: selected`. Normalizing here is for COMPARISON
 *     only and never excuses that — the surrounding response is still
 *     schema-validated, which is what rejects a duplicated outer entry.
 *     Schema-invalid input (a non-array, a non-object entry, an empty
 *     `collection_ids`) stays a visible failure here and is additionally
 *     rejected by ordinary response-schema validation upstream.
 *   - Ordering is bytewise over UTF-8, on the *pairs*, so outer grouping and
 *     inner id order never affect the result while non-ASCII identifiers stay
 *     lossless. Nothing is case-folded, trimmed, punycoded or otherwise
 *     rewritten. `collection_id` is a plain string with no `minLength` and no
 *     declared normalization form, so inventing one would grade agents
 *     against a rule the protocol does not state. `publisher_domain` is
 *     separately pattern-constrained to lowercase LDH by
 *     `core/collection-selector.json`, which response-schema validation
 *     already enforces — canonicalizing it here would be redundant at best
 *     and would mask a non-conformant catalog at worst.
 */

const PAIR_LIMIT_DEFAULT = 10_000;

/** Maximum distinct pairs any single normalization will materialize. */
export const COLLECTION_PAIR_LIMIT = PAIR_LIMIT_DEFAULT;

/** Maximum pairs echoed into a diagnostic before it is elided. */
export const COLLECTION_DIAGNOSTIC_LIMIT = 20;

/** One atomic, domain-qualified collection identity. */
export interface CollectionPair {
  publisher_domain: string;
  /** `null` is the domain-only bulk-grant selector, not an empty id. */
  collection_id: string | null;
}

/** A concrete `CollectionSelector` as it appears on the wire. */
export interface CollectionSelectorObject {
  publisher_domain: string;
  collection_ids?: string[];
}

export interface NormalizedCollectionSelectors {
  /** Distinct pairs in bytewise order. */
  pairs: CollectionPair[];
  /** Outer selector entries observed, before normalization. */
  selector_count: number;
  /** Distinct publisher domains, bytewise ordered. */
  domains: string[];
}

export type CollectionNormalizationCode =
  | 'not_an_array'
  | 'selector_not_object'
  | 'publisher_domain_invalid'
  | 'collection_ids_invalid'
  | 'collection_id_invalid'
  | 'pair_limit_exceeded';

export interface CollectionNormalizationFailure {
  code: CollectionNormalizationCode;
  detail: string;
}

export type CollectionNormalizationResult =
  | { ok: true; value: NormalizedCollectionSelectors }
  | { ok: false; failure: CollectionNormalizationFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Total bytewise order over pairs. Domain first, then id; `null` sorts first. */
export function compareCollectionPairs(a: CollectionPair, b: CollectionPair): number {
  const domain = utf8Compare(a.publisher_domain, b.publisher_domain);
  if (domain !== 0) return domain;
  if (a.collection_id === b.collection_id) return 0;
  if (a.collection_id === null) return -1;
  if (b.collection_id === null) return 1;
  return utf8Compare(a.collection_id, b.collection_id);
}

/** Stable, unambiguous rendering for diagnostics and dedup keys. */
export function formatCollectionPair(pair: CollectionPair): string {
  return pair.collection_id === null
    ? `${JSON.stringify(pair.publisher_domain)}:*`
    : `${JSON.stringify(pair.publisher_domain)}:${JSON.stringify(pair.collection_id)}`;
}

function pairKey(pair: CollectionPair): string {
  // `\u0000` cannot appear in a JSON string literal produced by stringify, so
  // the two stringified components cannot be confused for one another.
  return pair.collection_id === null
    ? `${JSON.stringify(pair.publisher_domain)}\u0000`
    : `${JSON.stringify(pair.publisher_domain)}\u0000${JSON.stringify(pair.collection_id)}`;
}

/**
 * Normalize an array of `CollectionSelector` objects into distinct atomic
 * pairs. Used for product catalog entries, authored expected sets and
 * seller-returned `selected.collections` alike — same definition everywhere.
 */
export function normalizeCollectionSelectors(
  value: unknown,
  options: { limit?: number } = {}
): CollectionNormalizationResult {
  const limit = options.limit ?? PAIR_LIMIT_DEFAULT;
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failure: {
        code: 'not_an_array',
        detail: `expected an array of collection selectors; received ${describe(value)}`,
      },
    };
  }
  const seen = new Map<string, CollectionPair>();
  for (let index = 0; index < value.length; index++) {
    const selector: unknown = value[index];
    if (!isRecord(selector)) {
      return {
        ok: false,
        failure: {
          code: 'selector_not_object',
          detail: `collections[${index}] must be an object; received ${describe(selector)}`,
        },
      };
    }
    const domain = selector.publisher_domain;
    if (typeof domain !== 'string' || domain.length === 0) {
      return {
        ok: false,
        failure: {
          code: 'publisher_domain_invalid',
          detail: `collections[${index}].publisher_domain must be a non-empty string; received ${describe(domain)}`,
        },
      };
    }
    const ids = selector.collection_ids;
    if (ids === undefined || ids === null) {
      addPair(seen, { publisher_domain: domain, collection_id: null });
    } else {
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          ok: false,
          failure: {
            code: 'collection_ids_invalid',
            detail: `collections[${index}].collection_ids must be a non-empty array when present; received ${describe(ids)}`,
          },
        };
      }
      for (let idIndex = 0; idIndex < ids.length; idIndex++) {
        const id: unknown = ids[idIndex];
        if (typeof id !== 'string') {
          return {
            ok: false,
            failure: {
              code: 'collection_id_invalid',
              detail: `collections[${index}].collection_ids[${idIndex}] must be a string; received ${describe(id)}`,
            },
          };
        }
        // An empty-string id is legal: the schema declares no minLength.
        addPair(seen, { publisher_domain: domain, collection_id: id });
        // Bound inside the inner loop: a single selector with a huge
        // `collection_ids` array must refuse before materializing it, not
        // after.
        if (seen.size > limit) return pairLimitExceeded(limit, index);
      }
    }
    if (seen.size > limit) return pairLimitExceeded(limit, index);
  }
  const pairs = [...seen.values()].sort(compareCollectionPairs);
  const domains = [...new Set(pairs.map(pair => pair.publisher_domain))].sort(utf8Compare);
  return { ok: true, value: { pairs, selector_count: value.length, domains } };
}

function pairLimitExceeded(limit: number, index: number): CollectionNormalizationResult {
  return {
    ok: false,
    failure: {
      code: 'pair_limit_exceeded',
      detail: `normalized collection pairs exceeded the ${limit}-pair safety limit at collections[${index}]`,
    },
  };
}

function addPair(seen: Map<string, CollectionPair>, pair: CollectionPair): void {
  const key = pairKey(pair);
  if (!seen.has(key)) seen.set(key, pair);
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  return typeof value === 'object' ? 'an object' : JSON.stringify(value);
}

/** Exact set difference over normalized pairs, with bounded diagnostics. */
export function diffCollectionPairSets(
  actual: readonly CollectionPair[],
  expected: readonly CollectionPair[]
): { equal: boolean; missing: CollectionPair[]; unexpected: CollectionPair[] } {
  const expectedKeys = new Set(expected.map(pairKey));
  const actualKeys = new Set(actual.map(pairKey));
  const missing = expected.filter(pair => !actualKeys.has(pairKey(pair)));
  const unexpected = actual.filter(pair => !expectedKeys.has(pairKey(pair)));
  return { equal: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

/** Render at most `COLLECTION_DIAGNOSTIC_LIMIT` pairs, flagging elision. */
export function summarizeCollectionPairs(pairs: readonly CollectionPair[]): string {
  const shown = pairs.slice(0, COLLECTION_DIAGNOSTIC_LIMIT).map(formatCollectionPair);
  const elided = pairs.length - shown.length;
  return elided > 0 ? `${shown.join(', ')} (+${elided} more)` : shown.join(', ');
}

// ────────────────────────────────────────────────────────────
// Eligibility predicate
// ────────────────────────────────────────────────────────────

/**
 * Operand of the `collection_selection_satisfies` fixture predicate.
 *
 * `collection_targeting` encodes the schema's omitted-false default
 * explicitly rather than teaching every `equals` comparison to apply
 * arbitrary defaults. It is deliberately NOT named `mode`: the wire's
 * `collection_selection.mode` is `selected | default`, and the two appear in
 * the same storyboard file.
 *
 *   - `fixed`      — `collection_targeting_allowed` is literal `false` OR
 *                    absent (the normative default). `true` does not qualify.
 *   - `selectable` — literal `true` only.
 *   - `any`        — either, as long as the flag is absent or a boolean.
 *
 * A non-boolean, non-absent flag never qualifies in any mode: that is a
 * schema failure of the seller's catalog, surfaced by response-schema
 * validation during discovery, not something this predicate repairs.
 */
export interface CollectionSelectionSelector {
  collection_targeting: 'selectable' | 'fixed' | 'any';
  /**
   * Distinct concrete pairs the product must expose. Defaults to `1`, which
   * covers default materialization / full-bundle restatement; `2` is
   * required before a genuine strict subset exists to exercise.
   */
  minimum_pairs?: 1 | 2;
  /**
   * Require a wire-visible owner/host relation: at least one collection
   * selector whose publisher domain is outside every declared property
   * (host) domain of the same product. Defaults to `false`.
   */
  require_cross_publisher_collection?: boolean;
}

/**
 * Post-normalization operand the evaluator consumes, with both defaults
 * applied.
 *
 * Kept separate from the authored form so the type accepts exactly what the
 * loader accepts: `{ collection_targeting: 'fixed' }` is valid YAML and must type-check,
 * while an index signature would have let a typo'd key compile clean and
 * then fail at load against the closed-operand rule.
 */
export interface ResolvedCollectionSelectionSelector {
  collection_targeting: 'selectable' | 'fixed' | 'any';
  minimum_pairs: 1 | 2;
  require_cross_publisher_collection: boolean;
}

export const COLLECTION_TARGETING_MODES = ['selectable', 'fixed', 'any'] as const;

/** Validate and default the closed operand. Throws on authoring errors. */
export function normalizeCollectionSelectionSelector(
  value: unknown,
  location: string
): ResolvedCollectionSelectionSelector {
  if (!isRecord(value)) throw new Error(`${location}: must be an object`);
  const unknown = Object.keys(value).filter(
    key => !['collection_targeting', 'minimum_pairs', 'require_cross_publisher_collection'].includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(`${location}: unknown key(s): ${unknown.join(', ')}; the operand is closed`);
  }
  const targeting = value.collection_targeting;
  if (typeof targeting !== 'string' || !(COLLECTION_TARGETING_MODES as readonly string[]).includes(targeting)) {
    throw new Error(`${location}.collection_targeting: must be one of ${COLLECTION_TARGETING_MODES.join(', ')}`);
  }
  let minimumPairs: 1 | 2 = 1;
  if (value.minimum_pairs !== undefined) {
    if (value.minimum_pairs !== 1 && value.minimum_pairs !== 2) {
      throw new Error(`${location}.minimum_pairs: must be 1 or 2`);
    }
    minimumPairs = value.minimum_pairs;
  }
  if (
    value.require_cross_publisher_collection !== undefined &&
    typeof value.require_cross_publisher_collection !== 'boolean'
  ) {
    throw new Error(`${location}.require_cross_publisher_collection: must be boolean`);
  }
  return {
    collection_targeting: targeting as ResolvedCollectionSelectionSelector['collection_targeting'],
    minimum_pairs: minimumPairs,
    require_cross_publisher_collection: value.require_cross_publisher_collection === true,
  };
}

/** The declared owner/host relation observed on one product. */
export interface CrossPublisherCollectionRelation {
  /**
   * The collection namespace that lies outside every property namespace of
   * the SAME selected product.
   */
  collection_publisher_domain: string;
  /** Property namespaces declared by that same product. */
  property_publisher_domains: string[];
  /**
   * The concrete selector carrying it. `selector.publisher_domain` always
   * equals `collection_publisher_domain`.
   */
  selector: CollectionSelectorObject;
}

/**
 * Everything the resolver retains about the product it actually selected.
 * Built once, from the selected candidate, and never recomputed from a
 * different response.
 */
export interface CollectionSelectionWitness {
  product_id: string | null;
  /**
   * Effective targeting of the selected product, with the schema's
   * omitted-false default applied. Distinct from the native seller field
   * `collection_targeting_allowed`, whose raw observed value is reported
   * beside it, and from the wire's `collection_selection.mode`.
   */
  collection_targeting: 'selectable' | 'fixed';
  /** The flag exactly as observed — `undefined` when the seller omitted it. */
  collection_targeting_allowed: boolean | undefined;
  /** The product's complete, concrete collection selector bundle. */
  declared_selectors: CollectionSelectorObject[];
  /** Distinct concrete pairs (bulk-grant entries excluded). */
  distinct_pairs: CollectionPair[];
  /**
   * A one-entry selector array naming exactly one of the bundle's pairs, so
   * it is a strict subset whenever the bundle has two or more. Shaped as an
   * array because that is the shape a `collections` field takes on the wire,
   * so a storyboard can substitute it whole.
   *
   * When `require_cross_publisher_collection` was requested, the pair is drawn from the
   * retained external owner, so the subset actually exercises the carriage
   * relation rather than the host's own inventory.
   *
   * `null` when the product exposes fewer than two distinct concrete pairs —
   * a one-pair product still qualifies for default materialization, so the
   * absence of a subset witness must not suppress that coverage.
   */
  strict_subset: CollectionSelectorObject[] | null;
  /**
   * One-entry selector array naming an id verified absent from this
   * product's pairs, under a domain the product does carry.
   */
  undeclared_collection_id_selectors: CollectionSelectorObject[];
  /**
   * One-entry selector array whose domain is verified absent from every
   * COLLECTION namespace this product declares.
   *
   * Property namespaces (`publisher_properties[].publisher_domain`) are not
   * checked — the synthesized domain is a `.invalid` name, which RFC 2606
   * reserves and no real publisher can hold, so a collision is not possible
   * in practice. Stated precisely because "every namespace this product
   * declares" read as including the property side, and it does not.
   */
  undeclared_publisher_domain_selectors: CollectionSelectorObject[];
  /** Present only when the relation was requested and found. */
  cross_publisher_relation: CrossPublisherCollectionRelation | null;
  /** Declared property namespaces, bytewise ordered. */
  property_publisher_domains: string[];
}

export type CollectionSelectionEvaluation =
  | { eligible: true; witness: CollectionSelectionWitness }
  | { eligible: false; reason: string };

/**
 * Declared property (host) domains for one product.
 *
 * Singular `publisher_domain` only. `core/product.json` restricts each
 * `publisher_properties[]` entry with
 * `{"not": {"required": ["publisher_domains"]}}` and states that SDK
 * implementers MUST enforce singular-only at runtime: the compact fan-out
 * form is legal on a selector in general but rejected on products. Reading
 * it here would also be unsafe in the direction that matters — a larger host
 * set makes the owner/host relation strictly HARDER to satisfy, so honoring
 * a non-conformant product would silently suppress qualification into a
 * coverage gap.
 */
function collectHostDomains(candidate: Record<string, unknown>): string[] {
  const domains = new Set<string>();
  const properties = candidate.publisher_properties;
  if (Array.isArray(properties)) {
    for (const entry of properties) {
      if (!isRecord(entry)) continue;
      if (typeof entry.publisher_domain === 'string' && entry.publisher_domain.length > 0) {
        domains.add(entry.publisher_domain);
      }
    }
  }
  return [...domains].sort(utf8Compare);
}

function cloneSelectorBundle(value: unknown): CollectionSelectorObject[] {
  // `value` already passed normalization, so every entry is a well-formed
  // selector object. Clone so the witness never aliases the catalog response.
  return (value as CollectionSelectorObject[]).map(selector => ({
    publisher_domain: selector.publisher_domain,
    ...(Array.isArray(selector.collection_ids) && { collection_ids: [...selector.collection_ids] }),
  }));
}

/**
 * Build a selector that is schema-valid and verified absent from `pairs`.
 * Deterministic: the same product always produces the same witness, so
 * evidence is reproducible and a negative case can never accidentally name a
 * collection the seller does actually carry.
 */
function buildUndeclaredCollectionIdSelectors(
  domain: string,
  pairs: readonly CollectionPair[]
): CollectionSelectorObject[] {
  const taken = new Set(pairs.filter(pair => pair.publisher_domain === domain).map(pair => pair.collection_id));
  let candidate = 'adcp-absent-collection';
  for (let suffix = 0; taken.has(candidate); suffix++) {
    candidate = `adcp-absent-collection-${suffix}`;
  }
  return [{ publisher_domain: domain, collection_ids: [candidate] }];
}

function buildUndeclaredPublisherDomainSelectors(
  domains: ReadonlySet<string>,
  collectionId: string
): CollectionSelectorObject[] {
  // `.invalid` is reserved by RFC 2606 and can never be a real publisher.
  let candidate = 'adcp-absent-owner.invalid';
  for (let suffix = 0; domains.has(candidate); suffix++) {
    candidate = `adcp-absent-owner-${suffix}.invalid`;
  }
  return [{ publisher_domain: candidate, collection_ids: [collectionId] }];
}

/**
 * Decide whether one discovered product qualifies, and retain the witness
 * for the candidate that is actually selected.
 *
 * Qualification is evaluated against the complete validated candidate before
 * any deterministic ordering is applied, so a nonqualifying first product can
 * never hide a later qualifying one.
 */
export function evaluateCollectionSelection(
  candidate: unknown,
  selector: CollectionSelectionSelector
): CollectionSelectionEvaluation {
  // A WITNESS is structurally assignable to a selector — its
  // `collection_targeting` is a subset of the selector's, and the
  // selector's other two fields are optional — so `evaluate(candidate,
  // someWitness)` compiles clean and would silently evaluate with
  // `minimum_pairs: 1` and no carriage requirement. A caller holding a
  // witness and meaning to re-check eligibility writes exactly that.
  // The compiler cannot catch it; this can.
  if (selector !== null && typeof selector === 'object' && 'declared_selectors' in selector) {
    throw new Error(
      'evaluateCollectionSelection: received a CollectionSelectionWitness where a CollectionSelectionSelector was expected. A witness is the OUTPUT of an evaluation, not an operand; build the operand explicitly, e.g. { collection_targeting: "selectable", minimum_pairs: 2 }.'
    );
  }
  // Accept the AUTHORED form and apply the same defaults the loader does.
  // Requiring the resolved form would force a downstream consumer to
  // hand-assemble all three fields and re-derive our defaults, which is
  // exactly the drift this module exists to prevent.
  const resolved: ResolvedCollectionSelectionSelector = {
    collection_targeting: selector.collection_targeting,
    minimum_pairs: selector.minimum_pairs ?? 1,
    require_cross_publisher_collection: selector.require_cross_publisher_collection === true,
  };
  return evaluateResolvedCollectionSelection(candidate, resolved);
}

function evaluateResolvedCollectionSelection(
  candidate: unknown,
  selector: ResolvedCollectionSelectionSelector
): CollectionSelectionEvaluation {
  if (!isRecord(candidate)) return { eligible: false, reason: 'candidate is not an object' };

  const flag = candidate.collection_targeting_allowed;
  if (flag !== undefined && typeof flag !== 'boolean') {
    return {
      eligible: false,
      reason: `collection_targeting_allowed must be boolean or absent; observed ${describe(flag)}`,
    };
  }
  // The schema default is false, so absence is a fixed bundle.
  const effectiveTargeting: 'selectable' | 'fixed' = flag === true ? 'selectable' : 'fixed';
  if (selector.collection_targeting !== 'any' && selector.collection_targeting !== effectiveTargeting) {
    return {
      eligible: false,
      reason:
        selector.collection_targeting === 'fixed'
          ? 'collection_targeting_allowed is true; a fixed bundle requires literal false or absence'
          : 'collection_targeting_allowed is not literal true',
    };
  }

  const normalized = normalizeCollectionSelectors(candidate.collections);
  if (!normalized.ok) {
    return { eligible: false, reason: `collections did not normalize: ${normalized.failure.detail}` };
  }
  // Product composition must name explicit ids: `core/product.json` requires
  // `collection_ids` on every `collections[]` entry. A bulk-grant entry here
  // is a non-conformant catalog row, and letting one through would put a
  // schema-invalid `{publisher_domain}` selector into the witness bundle that
  // storyboards substitute whole into `collection_selection.collections`.
  if (normalized.value.pairs.some(pair => pair.collection_id === null)) {
    return {
      eligible: false,
      reason:
        'product collections contain a domain-only bulk-grant selector; product composition requires explicit collection_ids on every entry',
    };
  }
  const concrete = normalized.value.pairs;
  if (concrete.length < selector.minimum_pairs) {
    return {
      eligible: false,
      reason: `product exposes ${concrete.length} distinct concrete collection pair(s); ${selector.minimum_pairs} required`,
    };
  }

  const hostDomains = collectHostDomains(candidate);
  const bundle = cloneSelectorBundle(candidate.collections);
  let relation: CrossPublisherCollectionRelation | null = null;
  if (selector.require_cross_publisher_collection) {
    const hostSet = new Set(hostDomains);
    // Traverse every declared collection selector, not index zero, and keep
    // the first external namespace in bytewise pair order so the witness is
    // deterministic regardless of seller array order.
    const externalDomain = normalized.value.domains.find(domain => !hostSet.has(domain));
    if (externalDomain === undefined) {
      return {
        eligible: false,
        reason:
          hostDomains.length === 0
            ? 'product declares no publisher_properties domains, so no owner/host relation is observable'
            : 'every collection namespace is also a declared property namespace',
      };
    }
    // `find` is SELLER ARRAY ORDER. Every other field of the witness is
    // bytewise-normalized, so a product declaring two selector entries
    // under the same external domain produced a different `selector`
    // whenever the seller reordered its array — while the comment above
    // promised determinism. Pick the bytewise-first entry instead, by the
    // same comparison the pair ordering uses.
    const carrying = bundle
      .filter(entry => entry.publisher_domain === externalDomain)
      .sort((left, right) => {
        const l = JSON.stringify([...(left.collection_ids ?? [])].sort());
        const r = JSON.stringify([...(right.collection_ids ?? [])].sort());
        return l < r ? -1 : l > r ? 1 : 0;
      })[0]!;
    relation = {
      collection_publisher_domain: externalDomain,
      property_publisher_domains: hostDomains,
      selector: {
        ...carrying,
        ...(carrying.collection_ids && { collection_ids: [...carrying.collection_ids] }),
      },
    };
  }

  // When the carriage relation was requested, the retained subset and the
  // negative witnesses must come from the EXTERNAL owner, not from whichever
  // pair happens to sort first. A bytewise-earlier local pair would
  // otherwise produce a subset that exercises only the host's own inventory
  // while the storyboard believes it is testing carriage.
  //
  // Two distinct TOTAL pairs still suffice for a strict subset — a single
  // external pair alongside a local one is a legitimate carriage product,
  // and requiring two external pairs would suppress it.
  const subsetSource =
    relation === null
      ? concrete[0]!
      : // Non-null is sound, not optimism: `relation.collection_publisher_domain`
        // is taken from `normalized.value.domains`, which is derived from
        // `concrete`, so the domain is present by construction. The previous
        // `?? concrete[0]` read as a carriage-vs-local fallback and was not
        // one — it could only ever have masked a normalizer bug.
        concrete.find(pair => pair.publisher_domain === relation.collection_publisher_domain)!;
  const strictSubset: CollectionSelectorObject[] | null =
    concrete.length >= 2
      ? [{ publisher_domain: subsetSource.publisher_domain, collection_ids: [subsetSource.collection_id as string] }]
      : null;

  const witness: CollectionSelectionWitness = {
    product_id: typeof candidate.product_id === 'string' ? candidate.product_id : null,
    collection_targeting: effectiveTargeting,
    collection_targeting_allowed: flag,
    declared_selectors: bundle,
    distinct_pairs: concrete,
    strict_subset: strictSubset,
    undeclared_collection_id_selectors: buildUndeclaredCollectionIdSelectors(
      subsetSource.publisher_domain,
      normalized.value.pairs
    ),
    undeclared_publisher_domain_selectors: buildUndeclaredPublisherDomainSelectors(
      new Set(normalized.value.domains),
      subsetSource.collection_id as string
    ),
    cross_publisher_relation: relation,
    property_publisher_domains: hostDomains,
  };
  return { eligible: true, witness };
}

/** Boolean form for the legacy matcher. */
export function productSatisfiesCollectionSelection(
  candidate: unknown,
  selector: CollectionSelectionSelector
): boolean {
  return evaluateCollectionSelection(candidate, selector).eligible;
}

/** Derived witness captures a declaration may bind to a context key. */
export const COLLECTION_WITNESS_KINDS = [
  'declared_selectors',
  'distinct_pairs',
  'strict_subset',
  'undeclared_collection_id_selectors',
  'undeclared_publisher_domain_selectors',
  'cross_publisher_relation',
  'property_publisher_domains',
] as const;

export type CollectionWitnessKind = (typeof COLLECTION_WITNESS_KINDS)[number];

export type CollectionWitnessReadResult = { ok: true; value: unknown } | { ok: false; detail: string };

/**
 * Read one derived capture off a retained witness.
 *
 * A declared capture that cannot be built is a setup failure, never an
 * unsupported/not-applicable downgrade — the storyboard asked for state the
 * selected product does not provide, and silently proceeding would grade the
 * agent against a request the author did not write.
 */
export function readCollectionWitness(
  witness: CollectionSelectionWitness | undefined,
  kind: CollectionWitnessKind
): CollectionWitnessReadResult {
  if (!witness) {
    return {
      ok: false,
      detail: `witness capture "${kind}" requires a collection_selection_satisfies predicate on the same declaration`,
    };
  }
  switch (kind) {
    case 'declared_selectors':
      return { ok: true, value: witness.declared_selectors };
    case 'distinct_pairs':
      return { ok: true, value: witness.distinct_pairs };
    case 'strict_subset':
      if (witness.strict_subset === null) {
        return {
          ok: false,
          detail:
            'strict_subset requires a product with at least two distinct concrete collection pairs; declare minimum_pairs: 2',
        };
      }
      return { ok: true, value: witness.strict_subset };
    case 'undeclared_collection_id_selectors':
      return { ok: true, value: witness.undeclared_collection_id_selectors };
    case 'undeclared_publisher_domain_selectors':
      return { ok: true, value: witness.undeclared_publisher_domain_selectors };
    case 'cross_publisher_relation':
      if (witness.cross_publisher_relation === null) {
        return {
          ok: false,
          detail:
            'cross_publisher_relation requires require_cross_publisher_collection: true on the collection_selection_satisfies operand',
        };
      }
      return { ok: true, value: witness.cross_publisher_relation };
    case 'property_publisher_domains':
      return { ok: true, value: witness.property_publisher_domains };
  }
}
