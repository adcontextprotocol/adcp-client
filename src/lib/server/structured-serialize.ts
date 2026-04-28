/**
 * Lossless serialization of rich JS types through {@link AdcpStateStore}.
 *
 * AdcpStateStore accepts `Record<string, unknown>` and round-trips through
 * JSON, which silently drops `Map`, `Set`, and converts `Date` to string.
 * Handlers that keep those types in memory can wrap reads and writes:
 *
 * ```ts
 * import { structuredSerialize, structuredDeserialize } from '@adcp/sdk/server';
 *
 * await ctx.store.put('sessions', id, structuredSerialize(session));
 * const session = structuredDeserialize(await ctx.store.get('sessions', id));
 * ```
 *
 * Tagged envelopes use the namespaced field `__adcpType` to avoid collision
 * with domain data. Unknown tag values pass through unchanged on deserialize,
 * so a future tag addition won't corrupt caller data that already uses
 * `__adcpType` for something else.
 */

type Primitive = string | number | boolean | null;

interface DateEnvelope {
  __adcpType: 'Date';
  value: string;
}

interface MapEnvelope {
  __adcpType: 'Map';
  entries: [unknown, unknown][];
}

interface SetEnvelope {
  __adcpType: 'Set';
  values: unknown[];
}

type Envelope = DateEnvelope | MapEnvelope | SetEnvelope;

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  switch (o.__adcpType) {
    case 'Date':
      return typeof o.value === 'string';
    case 'Map':
      return Array.isArray(o.entries);
    case 'Set':
      return Array.isArray(o.values);
    default:
      return false;
  }
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
    return { __adcpType: 'Date', value: value.toISOString() } satisfies DateEnvelope;
  }

  if (value instanceof Map) {
    return {
      __adcpType: 'Map',
      entries: [...value.entries()].map(([k, v]) => [structuredSerialize(k), structuredSerialize(v)]),
    } satisfies MapEnvelope;
  }

  if (value instanceof Set) {
    return {
      __adcpType: 'Set',
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
    switch (value.__adcpType) {
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
