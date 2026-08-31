/**
 * Read an explicit `null` as "field absent" wherever a generated schema says
 * the field may be omitted and may not hold `null`.
 *
 * The generated schemas mirror the AdCP TypeScript types exactly: an optional
 * field is `.optional()`, which accepts `undefined` and rejects `null`. Many
 * sellers serialize from Pydantic, Jackson, or encoding/json and emit `null`
 * for a field they have nothing to report for. Zod validates the whole payload
 * before a caller reads any field, so one such `null` on a scheduling hint
 * discards the spend and impression figures alongside it.
 *
 * A `null` is only reinterpreted where the schema itself says it carries no
 * information the omission wouldn't: the field may be skipped, and `null` is
 * not among the values it accepts. Everything else keeps its `null` and its
 * verdict — a `.nullable()` field whose spec assigns `null` a meaning, a
 * required field whose `null` must still fail, a `z.never()` field that must
 * not be provided at all.
 */

import type { z } from 'zod';

/**
 * Zod wrappers that only widen what an inner schema accepts. The shape a
 * payload has to match lives inside them, so a walk has to look through them
 * to find the object or array underneath. Whether a `null` survives is decided
 * by parsing against the wrapped field, not by this list — looking through a
 * wrapper never changes the verdict, only where the walk can reach.
 *
 * The generated schemas use `optional`, `nullable`, and `default`; the rest are
 * here because these schemas are public and adopters compose them (a
 * `.readonly()` response schema, a `.catch()` fallback, a `.nonoptional()`
 * narrowing) before handing them back to this helper.
 */
const TRANSPARENT_WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

/** The subset of a Zod def this walk reads, across the types it recognises. */
interface WalkableDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  left?: z.ZodType;
  right?: z.ZodType;
}

function defOf(schema: z.ZodType): WalkableDef {
  return schema.def as unknown as WalkableDef;
}

function innermostSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    if (!TRANSPARENT_WRAPPERS.has(def.type) || def.innerType === undefined) {
      return current;
    }
    current = def.innerType;
  }
}

/**
 * Every declaration a value at this position has to satisfy, as the object
 * shapes or array element schemas that carry it.
 *
 * An intersection contributes both of its sides — a JSON Schema `allOf` lands
 * as one, and its object shape is usually on one side with conditional
 * requirements on the other. Wrappers that aren't listed above and combinators
 * that aren't intersections (`union`, `pipe`, `lazy`, `record`) contribute
 * nothing and so end the walk: they name no single shape to resolve a field
 * against, and leaving that subtree untouched only forgoes tolerance.
 */
function collect<K extends 'shape' | 'element'>(schema: z.ZodType, key: K, into: NonNullable<WalkableDef[K]>[]): void {
  const def = defOf(innermostSchema(schema));
  if (def.type === 'intersection') {
    if (def.left) collect(def.left, key, into);
    if (def.right) collect(def.right, key, into);
    return;
  }
  const found = def[key];
  if (found !== undefined) into.push(found);
}

function collectAll<K extends 'shape' | 'element'>(
  schemas: readonly z.ZodType[],
  key: K
): NonNullable<WalkableDef[K]>[] {
  const into: NonNullable<WalkableDef[K]>[] = [];
  for (const schema of schemas) collect(schema, key, into);
  return into;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the schema itself says a `null` here carries no more information
 * than omitting the field: the value may be skipped, and `null` is not one of
 * the values the field is allowed to hold.
 *
 * `z.never()` is excluded. It accepts nothing, so the probe below would read
 * its rejection of `null` as "drop the key" — which would turn a field the
 * schema forbids into a field the payload silently passes.
 */
function nullMeansAbsent(field: z.ZodType): boolean {
  if (defOf(innermostSchema(field)).type === 'never') return false;
  return field.safeParse(undefined).success === true && field.safeParse(null).success === false;
}

/**
 * Reinterpret nulls in `value` against every declaration it has to satisfy.
 * A `null` is dropped only where all of them agree it means absent, so a field
 * one side declares nullable keeps its `null` even if another side doesn't
 * mention it as a value.
 */
function walk(schemas: readonly z.ZodType[], value: unknown): unknown {
  if (Array.isArray(value)) {
    const elements = collectAll(schemas, 'element');
    if (elements.length === 0) return value;
    let changed = false;
    const mapped = value.map(entry => {
      const next = walk(elements, entry);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }

  if (isRecord(value)) {
    const shapes = collectAll(schemas, 'shape');
    if (shapes.length === 0) return value;
    // Keys no shape declares are left alone: their value is either rejected or
    // passed through verbatim, and neither is ours to reinterpret.
    let result: Record<string, unknown> | null = null;
    // Cloning by spread *defines* properties rather than assigning them, so a
    // payload key named `__proto__` stays an ordinary key.
    const clone = () => (result ??= { ...value });
    for (const [key, entry] of Object.entries(value)) {
      const fields = shapes.flatMap(shape => shape[key] ?? []);
      if (fields.length === 0) continue;
      if (entry === null) {
        if (fields.every(nullMeansAbsent)) delete clone()[key];
        continue;
      }
      const next = walk(fields, entry);
      if (next !== entry) clone()[key] = next;
    }
    return result ?? value;
  }

  return value;
}

/**
 * Return `payload` with every `null` dropped that the schema declares optional
 * and non-nullable, so `schema.safeParse()` accepts it.
 *
 * The input is never mutated: objects and arrays containing a reinterpreted
 * `null` are copied, and every other node is shared with the original. A
 * caller keeping an audit trail of what the seller actually sent can hold onto
 * the payload it passed in.
 *
 * ```ts
 * import { GetMediaBuyDeliveryResponseSchema, treatOptionalNullsAsAbsent } from '@adcp/sdk/schemas';
 *
 * // Seller sent `next_expected_at: null` — an optional scheduling hint.
 * const tolerated = treatOptionalNullsAsAbsent(GetMediaBuyDeliveryResponseSchema, response);
 * const parsed = GetMediaBuyDeliveryResponseSchema.safeParse(tolerated);
 * // parsed.success === true, and every media_buy_deliveries figure survives.
 * // A `null` reporting_period still fails: the schema requires it.
 * ```
 *
 * Subtrees reached through a `union`, `pipe`, `lazy`, or `record` are left as
 * they are — the schema does not name a single shape to resolve the field
 * against, and guessing one risks dropping a `null` that one arm of the union
 * treats as a value.
 */
export function treatOptionalNullsAsAbsent<T>(schema: z.ZodType, payload: T): T {
  return walk([schema], payload) as T;
}
