/**
 * Schema-driven validation for AdCP tool requests and responses.
 *
 * The client uses this pre-send and post-receive; the opt-in server
 * middleware uses the same core to reject drift at the dispatcher.
 */

import type { ErrorObject } from 'ajv';
import { getValidator, type Direction, type ResponseVariant } from './schema-loader';

/**
 * One variant of a `oneOf` / `anyOf` that the caller's payload could have
 * matched, summarized down to what a client (human or LLM) needs to know
 * to pick one. Attached to `ValidationIssue` when `keyword` is `oneOf`
 * or `anyOf`. Omitted otherwise.
 */
export interface ValidationIssueVariant {
  /** Zero-based index of the variant in the schema's `oneOf`/`anyOf` array. */
  index: number;
  /** Required property names on this variant (per its `required` array). */
  required: string[];
  /**
   * Keys declared in the variant's `properties`. Useful for clients that
   * want to show "this variant accepts X, Y, Z" without fetching the
   * full schema. Empty if the variant doesn't declare properties.
   */
  properties: string[];
}

/**
 * A single validation failure with a JSON Pointer to the offending field,
 * the AJV message, and the schema path that rejected it. Mirrors the
 * format a `VALIDATION_ERROR` carries at `adcp_error.issues` (top level)
 * and `adcp_error.details.issues` (spec-convention mirror).
 */
export interface ValidationIssue {
  /** RFC 6901 JSON Pointer to the offending field in the payload. */
  pointer: string;
  /** Human-readable message from the schema. */
  message: string;
  /** AJV keyword that rejected the payload (e.g., `required`, `type`). */
  keyword: string;
  /** Path inside the schema that rejected the payload. */
  schemaPath: string;
  /**
   * Variants a caller can pick from when `keyword === 'oneOf'` or
   * `'anyOf'`. Each entry carries the variant's required fields + known
   * properties so a naive LLM client can recover without fetching the
   * full schema. Absent on non-union keywords.
   *
   * Unlike {@link ValidationIssue.schemaPath} (which is gated behind
   * `exposeSchemaPath` because it encodes which branch the seller's
   * handler rejected first — an implementation detail), `variants[]`
   * ships on the wire by default. Rationale: it reflects the PUBLIC
   * spec's union shape, which the bundled AdCP schemas under
   * `schemas/cache/<version>/` already make available to anyone with
   * `@adcp/sdk` installed. Gating would hurt naive LLM clients in
   * production — exactly the audience this field was built to help
   * (adcp-client#919).
   */
  variants?: ValidationIssueVariant[];
  /**
   * Closed enum values the payload MUST match for `keyword: 'enum'`
   * issues. AdCP wire schemas use enum heavily for status fields,
   * channels, pricing models, delivery types, etc. Without this list
   * on the wire envelope, both LLM-generated platforms and humans
   * have to fetch the schema just to discover the allowed values —
   * the most common self-correction failure surfaced by the Emma matrix.
   *
   * Absent on non-enum keywords. Always projected (not gated behind
   * `exposeSchemaPath`) — these are PUBLIC spec values, not internal
   * branch detail.
   */
  allowedValues?: readonly unknown[];
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
  /** Which schema variant was selected — useful for logging/debugging. */
  variant: Direction | 'skipped';
  /**
   * True when the response's `status` field named an async variant
   * (`submitted` / `working` / `input-required`) but no compiled schema
   * existed for that variant, so validation fell back to the sync
   * response schema. The agent is using an async shape that this tool
   * doesn't explicitly schema — a conformance signal the sync-fallback
   * validation can't render by itself. Absent on normal sync or
   * fully-schema-covered async flows.
   */
  variant_fallback_applied?: boolean;
  /** Variant requested by payload shape before fallback. Set iff `variant_fallback_applied`. */
  requested_variant?: ResponseVariant;
}

const OK: ValidationOutcome = Object.freeze({ valid: true, issues: [], variant: 'skipped' });

function formatIssue(err: ErrorObject): ValidationIssue {
  const instancePath = err.instancePath || '';
  const missingProperty =
    err.keyword === 'required' &&
    err.params &&
    typeof (err.params as { missingProperty?: string }).missingProperty === 'string'
      ? `/${(err.params as { missingProperty: string }).missingProperty}`
      : '';

  // Enrich enum errors with the allowed values from AJV's params + replace
  // the opaque "must be equal to one of the allowed values" message with
  // the actual list. Without this, LLM-generated platforms can't self-
  // correct (Emma matrix v17, 2026-04-30): the validation cascade from
  // a single bad enum value swallows ~30 storyboard steps because no
  // self-correction signal is available without fetching the schema.
  const isEnum =
    err.keyword === 'enum' &&
    err.params != null &&
    Array.isArray((err.params as { allowedValues?: unknown[] }).allowedValues);
  const allowedValues = isEnum ? (err.params as { allowedValues: readonly unknown[] }).allowedValues : undefined;
  const message = isEnum
    ? `must be one of: ${allowedValues!.map(v => JSON.stringify(v)).join(', ')}`
    : (err.message ?? 'validation failed');

  return {
    pointer: `${instancePath}${missingProperty}` || '/',
    message,
    keyword: err.keyword,
    schemaPath: err.schemaPath,
    ...(allowedValues !== undefined && { allowedValues }),
  };
}

// Path segments we refuse to walk into during schema-path resolution. AJV
// emits trusted `schemaPath` strings today, but the function is exported in
// shape (anything in this file is reachable via the compiled JS), so any
// future caller passing user-influenced paths can't traverse into prototype
// chains. Bundled schemas have no use for these names either.
const FORBIDDEN_SCHEMA_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve an AJV `schemaPath` like `"#/properties/account/oneOf"` against
 * the compiled validator's root schema. Returns `undefined` if the path
 * doesn't land on an object. Handles URI-encoded path segments (AJV
 * escapes `~` as `~0` and `/` as `~1` per RFC 6901).
 *
 * Refuses prototype-chain segments and uses own-property indexing so a
 * future caller (or a pathological future schema) can't induce a walk
 * into `Object.prototype`.
 */
function resolveSchemaPath(rootSchema: unknown, schemaPath: string): unknown {
  if (rootSchema == null) return undefined;
  const clean = schemaPath.replace(/^#\/?/, '');
  if (clean.length === 0) return rootSchema;
  let cursor: unknown = rootSchema;
  for (const raw of clean.split('/')) {
    if (cursor == null || (typeof cursor !== 'object' && !Array.isArray(cursor))) return undefined;
    const decoded = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (FORBIDDEN_SCHEMA_PATH_SEGMENTS.has(decoded)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, decoded)) return undefined;
    cursor = (cursor as Record<string, unknown>)[decoded];
  }
  return cursor;
}

/**
 * Compact AJV's `oneOf` / `anyOf` cascades before they reach the wire.
 *
 * AJV with `allErrors: true` emits one error per non-matching variant
 * plus a synthetic "must match exactly one schema" root. For a 9-way
 * `pricing_options` union with a single bad `pricing_model` value that
 * is 14+ errors per failed item, drowning real residual errors elsewhere
 * in the same payload (adcontextprotocol/adcp-client#1111).
 *
 * Strategy:
 *  1. For each union root, group variant errors by variant index.
 *  2. Inspect each variant's schema for `const`-constrained properties.
 *     A property where ≥2 variants assert `const` at the same path is a
 *     candidate discriminator (covers single-field discriminators like
 *     `pricing_model` and composite ones like `audience-selector`'s
 *     `(type, value_type)`).
 *  3. Collapse a candidate path iff EVERY variant that asserts `const`
 *     there emitted a `const` error. (If some variants silently passed,
 *     the user's value matched some allowed const — collapsing would
 *     hide that and tell them their valid value was wrong.)
 *  4. Each collapse becomes a synthetic `enum`-keyword issue carrying
 *     the union of allowed const values; the existing `formatIssue`
 *     enrichment then renders "must be one of: A, B, ...".
 *  5. After collapse, if any variant has zero residual errors, the
 *     discriminator collapse fully explains the failure — drop the
 *     synthetic union root and the residuals from the other variants.
 *  6. Otherwise pick the variant with the fewest residual errors,
 *     tie-breaking by fewest residual `const` errors so a variant the
 *     user's discriminator value satisfied wins over a sibling whose
 *     discriminator they violated. Drop the rest.
 */
function compactUnionErrors(errors: readonly ErrorObject[], rootSchema: unknown): ErrorObject[] {
  if (errors.length === 0) return [...errors];

  // Pre-bucket once so each error is scanned a constant number of times even
  // when a malicious or pathological payload pushes Ajv to emit thousands of
  // errors across many union failures. The naive `for root in unionRoots: for
  // e in errors` form is O(U·N) — at K=100 product items each producing a
  // 14-error pricing-options cascade that's ~140k iterations on the
  // request-validation hot path.
  const errorsByOneOfPath = new Map<string, ErrorObject[]>();
  for (const e of errors) {
    const m = e.schemaPath.match(/^(.*\/(?:oneOf|anyOf))\/\d+(?:\/|$)/);
    if (!m) continue;
    const root = m[1]!;
    const bucket = errorsByOneOfPath.get(root);
    if (bucket) bucket.push(e);
    else errorsByOneOfPath.set(root, [e]);
  }

  const dropped = new Set<ErrorObject>();
  const added: ErrorObject[] = [];

  // Deepest-first ordering matters for nested unions: by the time the outer
  // root is evaluated, the inner cascade has already been replaced by a
  // synthetic enum at a `<...>/discriminator/<field>` schemaPath that won't
  // match the outer's `oneOfPath + '/'` prefix and stays independent.
  const unionRoots = errors
    .filter(e => e.keyword === 'oneOf' || e.keyword === 'anyOf')
    .slice()
    .sort((a, b) => b.schemaPath.length - a.schemaPath.length);

  for (const root of unionRoots) {
    if (dropped.has(root)) continue;
    const oneOfPath = root.schemaPath;
    const rootInstance = root.instancePath;

    // Variant errors: pulled from the prebuilt index (constant per-error work
    // above), then grouped by variant index. instancePath scoping keeps two
    // separate union failures sharing the same `schemaPath` but different
    // instancePaths — e.g., `products[0].pricing_options[0]` and
    // `products[1]...` — independent.
    const candidateErrors = errorsByOneOfPath.get(oneOfPath) ?? [];
    const byVariant = new Map<number, ErrorObject[]>();
    for (const e of candidateErrors) {
      if (e === root || dropped.has(e)) continue;
      const tail = e.schemaPath.slice(oneOfPath.length + 1);
      const m = tail.match(/^(\d+)(?:\/|$)/);
      if (!m) continue;
      if (e.instancePath !== rootInstance && !e.instancePath.startsWith(rootInstance + '/')) continue;
      const idx = parseInt(m[1]!, 10);
      const bucket = byVariant.get(idx);
      if (bucket) bucket.push(e);
      else byVariant.set(idx, [e]);
    }
    if (byVariant.size === 0) continue;

    // Resolve the variant schema array. Without it we fall back to a pure
    // error-shape collapse (still correct, just less precise on which
    // variants asserted const where the user happened to match).
    const variantSchemas = resolveSchemaPath(rootSchema, oneOfPath);
    const variantArr: readonly unknown[] = Array.isArray(variantSchemas) ? variantSchemas : [];

    // For each top-level property in each variant, record which variants
    // declare a `const` value there. Top-level only — composite
    // discriminators in AdCP (`audience-selector`, pricing-option) all
    // sit at the variant root.
    const constAsserters = new Map<string, Map<number, unknown>>();
    for (let i = 0; i < variantArr.length; i++) {
      const variant = variantArr[i];
      if (!variant || typeof variant !== 'object') continue;
      const props = (variant as { properties?: unknown }).properties;
      if (!props || typeof props !== 'object') continue;
      for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
        if (prop && typeof prop === 'object' && 'const' in prop) {
          const path = `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
          let m = constAsserters.get(path);
          if (!m) constAsserters.set(path, (m = new Map()));
          m.set(i, (prop as { const: unknown }).const);
        }
      }
    }

    // For each candidate path with ≥2 asserters, did every asserter emit?
    const collapsedPaths = new Set<string>();
    for (const [relPath, asserters] of constAsserters) {
      if (asserters.size < 2) continue;
      const absolutePath = rootInstance + relPath;
      const emittersByVariant = new Map<number, ErrorObject>();
      for (const [idx, errs] of byVariant) {
        for (const e of errs) {
          if (e.keyword === 'const' && e.instancePath === absolutePath) {
            emittersByVariant.set(idx, e);
            break;
          }
        }
      }
      let allEmitted = true;
      for (const idx of asserters.keys()) {
        if (!emittersByVariant.has(idx)) {
          allEmitted = false;
          break;
        }
      }
      if (!allEmitted) continue;

      const allowedValues: unknown[] = [];
      for (const v of asserters.values()) {
        const already = allowedValues.some(existing => existing === v);
        if (!already) allowedValues.push(v);
      }
      const sample = emittersByVariant.values().next().value as ErrorObject;
      // Synthetic enum issue. `schemaPath: ''` keeps it out of any caller
      // that walks the path back to a real schema location (the synthesized
      // `<oneOfPath>/discriminator/<field>` would dangle if dereferenced)
      // while still satisfying the wire shape — the response-side errors
      // helper already gates `schemaPath` exposure via `exposeSchemaPath`.
      // `JSON.stringify` on the const values is safe: they come from the
      // bundled (trusted) schema and the outer wire envelope re-encodes
      // anyway, so control characters or quotes can't break framing.
      added.push({
        ...sample,
        keyword: 'enum',
        schemaPath: '',
        message: `must be one of: ${allowedValues.map(v => JSON.stringify(v)).join(', ')}`,
        params: { allowedValues },
      } as ErrorObject);
      for (const e of emittersByVariant.values()) dropped.add(e);
      collapsedPaths.add(absolutePath);
    }

    // Compute residuals after the collapse.
    const residualByVariant = new Map<number, ErrorObject[]>();
    for (const [idx, errs] of byVariant) {
      residualByVariant.set(
        idx,
        errs.filter(e => !dropped.has(e))
      );
    }

    if (collapsedPaths.size > 0) {
      const anyZeroResidual = [...residualByVariant.values()].some(r => r.length === 0);
      if (anyZeroResidual) {
        for (const errs of residualByVariant.values()) for (const e of errs) dropped.add(e);
        dropped.add(root);
        continue;
      }
    }

    // Pick the best surviving variant; prefer fewest residuals, tie-break
    // by fewest residual `const` errors (so variants whose discriminator
    // the user actually picked win over siblings whose discriminator they
    // violated).
    let bestIdx = -1;
    let bestCount = Infinity;
    let bestConsts = Infinity;
    for (const [idx, residual] of residualByVariant) {
      const constCount = residual.reduce((n, e) => (e.keyword === 'const' ? n + 1 : n), 0);
      if (residual.length < bestCount || (residual.length === bestCount && constCount < bestConsts)) {
        bestIdx = idx;
        bestCount = residual.length;
        bestConsts = constCount;
      }
    }
    for (const [idx, residual] of residualByVariant) {
      if (idx !== bestIdx) for (const e of residual) dropped.add(e);
    }
  }

  return [...errors.filter(e => !dropped.has(e)), ...added];
}

/**
 * When an AJV error has `keyword: 'oneOf' | 'anyOf'`, resolve the
 * schema's variant array and summarize each variant so a client can
 * pick one without fetching the full schema. See {@link ValidationIssueVariant}.
 * Returns the issue unchanged when the keyword doesn't match or the
 * resolution fails (e.g. the variant list is inlined in an unexpected
 * way).
 */
function enrichWithVariants(issue: ValidationIssue, rootSchema: unknown): ValidationIssue {
  if (issue.keyword !== 'oneOf' && issue.keyword !== 'anyOf') return issue;
  const resolved = resolveSchemaPath(rootSchema, issue.schemaPath);
  if (!Array.isArray(resolved)) return issue;
  const variants: ValidationIssueVariant[] = resolved.map((variant: unknown, index: number) => {
    if (variant == null || typeof variant !== 'object') {
      return { index, required: [], properties: [] };
    }
    const v = variant as Record<string, unknown>;
    const required = Array.isArray(v.required) ? (v.required.filter(r => typeof r === 'string') as string[]) : [];
    const properties =
      v.properties != null && typeof v.properties === 'object' ? Object.keys(v.properties as object) : [];
    return { index, required, properties };
  });
  return { ...issue, variants };
}

/**
 * Validate an outgoing request against `{tool}-request.json`.
 *
 * `version` selects which AdCP version's schema bundle to validate against;
 * defaults to the SDK-pinned `ADCP_VERSION`. Pass the per-instance value
 * from `getAdcpVersion()` to validate against a pinned-version client/server's
 * schema.
 */
export function validateRequest(toolName: string, payload: unknown, version?: string): ValidationOutcome {
  const validator = getValidator(toolName, 'request', version);
  if (!validator) return OK;
  const valid = validator(payload) as boolean;
  if (valid) return { valid: true, issues: [], variant: 'request' };
  const rootSchema = (validator as { schema?: unknown }).schema;
  const compacted = compactUnionErrors(validator.errors ?? [], rootSchema);
  return {
    valid: false,
    issues: compacted.map(formatIssue).map(i => enrichWithVariants(i, rootSchema)),
    variant: 'request',
  };
}

/**
 * Select the response variant by payload shape (per issue #688: choose by
 * `status` field, not just the tool name). Matches the AdCP 3.0 async
 * contract: `submitted`, `working`, `input-required`, and the sync
 * terminal states (`completed` / no status).
 */
function selectResponseVariant(payload: unknown): ResponseVariant {
  if (payload && typeof payload === 'object' && 'status' in (payload as Record<string, unknown>)) {
    const status = (payload as Record<string, unknown>).status;
    if (status === 'submitted') return 'submitted';
    if (status === 'working') return 'working';
    if (status === 'input-required') return 'input-required';
  }
  return 'sync';
}

/**
 * Validate an incoming response; picks the async variant by payload shape.
 *
 * `version` selects which AdCP version's schema bundle to validate against;
 * defaults to the SDK-pinned `ADCP_VERSION`. See {@link validateRequest} for
 * the per-instance use case.
 */
export function validateResponse(toolName: string, payload: unknown, version?: string): ValidationOutcome {
  const variant = selectResponseVariant(payload);
  const validator = getValidator(toolName, variant, version);
  // If an async variant schema is missing, fall back to the sync one —
  // some tools declare `-response.json` only and use `status` as an
  // in-band marker without a dedicated variant schema.
  const effective = validator ?? (variant !== 'sync' ? getValidator(toolName, 'sync', version) : undefined);
  if (!effective) return OK;
  const valid = effective(payload) as boolean;
  const usedVariant: Direction = validator ? variant : 'sync';
  const variantFallback = !validator && variant !== 'sync';
  const fallbackFields: Pick<ValidationOutcome, 'variant_fallback_applied' | 'requested_variant'> = variantFallback
    ? { variant_fallback_applied: true, requested_variant: variant }
    : {};
  if (valid) return { valid: true, issues: [], variant: usedVariant, ...fallbackFields };
  const rootSchema = (effective as { schema?: unknown }).schema;
  const compacted = compactUnionErrors(effective.errors ?? [], rootSchema);
  return {
    valid: false,
    issues: compacted.map(formatIssue).map(i => enrichWithVariants(i, rootSchema)),
    variant: usedVariant,
    ...fallbackFields,
  };
}

/** Render a compact one-line summary of the failures — useful for logs. */
export function formatIssues(issues: ValidationIssue[], limit = 3): string {
  const head = issues
    .slice(0, limit)
    .map(i => `${i.pointer} ${i.message}`)
    .join('; ');
  const rest = issues.length - limit;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}
