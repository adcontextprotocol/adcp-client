/**
 * Lossless serialization of rich JS types through {@link AdcpStateStore}.
 *
 * AdcpStateStore accepts `Record<string, unknown>` and round-trips through
 * JSON, which silently drops `Map`, `Set`, and converts `Date` to string.
 * Handlers that keep those types in memory can wrap reads and writes:
 *
 * ```ts
 * import { structuredSerialize, structuredDeserialize } from '@adcp/client/server';
 *
 * await ctx.store.put('sessions', id, structuredSerialize(session));
 * const session = structuredDeserialize(await ctx.store.get('sessions', id));
 * ```
 *
 * Tagged envelopes use the field `__type` (reserved). Plain objects that
 * happen to contain a `__type` field are left alone — they are round-tripped
 * as-is, but if you rely on that field for domain data, rename it first.
 */

type Primitive = string | number | boolean | null;

interface DateEnvelope {
  __type: 'Date';
  value: string;
}

interface MapEnvelope {
  __type: 'Map';
  entries: [unknown, unknown][];
}

interface SetEnvelope {
  __type: 'Set';
  values: unknown[];
}

type Envelope = DateEnvelope | MapEnvelope | SetEnvelope;

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as Record<string, unknown>).__type;
  return tag === 'Date' || tag === 'Map' || tag === 'Set';
}

/**
 * Walk `value` replacing `Map`, `Set`, and `Date` instances with JSON-safe
 * tagged envelopes. Plain objects and arrays recurse.
 */
export function structuredSerialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value as Primitive;

  if (value instanceof Date) {
    return { __type: 'Date', value: value.toISOString() } satisfies DateEnvelope;
  }

  if (value instanceof Map) {
    return {
      __type: 'Map',
      entries: [...value.entries()].map(([k, v]) => [structuredSerialize(k), structuredSerialize(v)]),
    } satisfies MapEnvelope;
  }

  if (value instanceof Set) {
    return {
      __type: 'Set',
      values: [...value.values()].map(v => structuredSerialize(v)),
    } satisfies SetEnvelope;
  }

  if (Array.isArray(value)) {
    return value.map(v => structuredSerialize(v));
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = structuredSerialize(v);
    }
    return out;
  }

  // Functions, symbols, bigints — drop silently (consistent with JSON.stringify).
  return undefined;
}

/**
 * Inverse of {@link structuredSerialize}. Walks `value` converting tagged
 * envelopes back into native `Map`, `Set`, and `Date` instances.
 */
export function structuredDeserialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map(v => structuredDeserialize(v));
  }

  if (isEnvelope(value)) {
    switch (value.__type) {
      case 'Date':
        return new Date(value.value);
      case 'Map':
        return new Map(value.entries.map(([k, v]) => [structuredDeserialize(k), structuredDeserialize(v)]));
      case 'Set':
        return new Set(value.values.map(v => structuredDeserialize(v)));
    }
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = structuredDeserialize(v);
    }
    return out;
  }

  return value;
}
