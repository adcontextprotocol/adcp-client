/**
 * Protected storyboard-context namespace and the single atomic write funnel
 * that guards it.
 *
 * Fixture preparation publishes the selected product, its scoped pricing and
 * its collection witnesses into storyboard context so later steps can build
 * requests from the entity that was actually pinned. Those values decide what
 * gets purchased, so nothing downstream may replace, delete or shadow them:
 * not caller-supplied `options.context`, not storyboard defaults, not a
 * convention extractor, not an authored `context_outputs` entry, not a
 * generator alias, not a task-completion capture, not creative-prefix
 * cleanup, and not a seller response.
 *
 * Three properties, each load-bearing:
 *
 *  1. **Reserved flat namespace.** Keys under `__adcp_fixture_` are writable
 *     only with a runner-owned capability. The prefix is flat so existing
 *     whole-key `$context.<key>` substitution keeps working unchanged; no
 *     nested-token syntax is introduced.
 *  2. **Atomic whole-patch validation.** A patch touching a protected key
 *     without the capability is rejected before *any* map changes, so a
 *     partially-applied write can never leave context and provenance
 *     disagreeing. Values, deletions, provenance entries and
 *     unavailable-output markers all commit through the same call —
 *     protecting values alone would let a caller suppress a prepared capture
 *     by marking it unavailable, or rewrite its provenance. Prototype-
 *     sensitive keys are refused outright for every writer, and writes use
 *     `Object.defineProperty` so no inherited setter is ever invoked.
 *  3. **Detached immutable snapshots.** Committed values are deep-cloned on
 *     ingestion and deep-frozen, and every read for request building or
 *     diagnostics hands back a fresh clone. Guarding map assignment alone is
 *     not enough: `injectContext`/`deepReplace` hand out `context[key]` by
 *     reference today, so a mutated request object can otherwise reach back
 *     into the snapshot it was built from.
 *
 * The capability is a runtime object identity held in a module-private
 * `WeakSet`. It is deliberately not a string, a `source_kind`, a provenance
 * entry or a boolean: all of those are reachable from caller JSON. A
 * structurally-cloned or JSON-rehydrated copy of a capability is not the
 * capability, which is what keeps "I have a frozen object that looks right"
 * from being authority.
 */

import type { ContextProvenanceEntry, StoryboardContext } from './types';

/** Reserved flat prefix for preparation-produced context keys. */
export const PROTECTED_CONTEXT_PREFIX = '__adcp_fixture_';

/**
 * Declared capture keys must be whole-key `$context.<key>` substitutable
 * (`\w+` in the existing injector) and must not collide with
 * prototype-sensitive names.
 */
const PROTECTED_KEY_PATTERN = /^__adcp_fixture_[A-Za-z0-9_]+$/;

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for any key inside the reserved namespace, well-formed or not. */
export function isProtectedContextKey(key: string): boolean {
  return key.startsWith(PROTECTED_CONTEXT_PREFIX);
}

export type ProtectedContextViolationCode =
  | 'unauthorized_write'
  | 'unauthorized_delete'
  | 'unauthorized_metadata'
  | 'already_committed'
  | 'reserved_key'
  | 'uncloneable_value'
  | 'invalid_key';

/** Thrown by the funnel; never partially applied. */
export class ProtectedContextViolation extends Error {
  readonly code: ProtectedContextViolationCode;
  readonly keys: readonly string[];

  constructor(code: ProtectedContextViolationCode, keys: readonly string[], detail: string) {
    super(detail);
    this.name = 'ProtectedContextViolation';
    this.code = code;
    this.keys = [...keys];
  }
}

/**
 * Runner-owned write capability. Opaque by construction: the only way to
 * obtain one that the funnel accepts is to call `createProtectedContextWriter`
 * inside this process.
 */
export interface ProtectedContextWriter {
  readonly kind: 'adcp.storyboard.protected-context-writer';
}

const writers = new WeakSet<ProtectedContextWriter>();

export function createProtectedContextWriter(): ProtectedContextWriter {
  const writer: ProtectedContextWriter = Object.freeze({
    kind: 'adcp.storyboard.protected-context-writer' as const,
  });
  writers.add(writer);
  return writer;
}

function isTrustedWriter(writer: ProtectedContextWriter | undefined): writer is ProtectedContextWriter {
  return writer !== undefined && writers.has(writer);
}

interface ProtectedContextState {
  /** Keys committed by the preparation capability. */
  committed: Set<string>;
  writer: ProtectedContextWriter;
}

/**
 * Protection travels with the context object identity, mirroring how the
 * `$generate` alias cache already follows `forwardAliasCache` across the
 * runner's shallow clones. A `{ ...context }` copy therefore starts
 * unprotected until the runner forwards it, which is why every clone site
 * that forwards the alias cache also forwards this.
 */
const states = new WeakMap<object, ProtectedContextState>();

/** Register a context object as protected under `writer`. Idempotent. */
export function registerProtectedContext(context: StoryboardContext, writer: ProtectedContextWriter): void {
  if (!isTrustedWriter(writer)) {
    throw new ProtectedContextViolation(
      'unauthorized_write',
      [],
      'registerProtectedContext requires a runner-owned protected-context capability'
    );
  }
  if (!states.has(context)) states.set(context, { committed: new Set(), writer });
}

/**
 * Carry protection onto a clone. Call wherever the runner shallow-copies or
 * adopts a context object, alongside `forwardAliasCache`.
 */
export function forwardProtectedContext(from: StoryboardContext, to: StoryboardContext): void {
  const state = states.get(from);
  if (!state) return;
  const existing = states.get(to);
  if (existing) {
    for (const key of state.committed) existing.committed.add(key);
    return;
  }
  states.set(to, { committed: new Set(state.committed), writer: state.writer });
}

/** Keys already committed on this context, for evidence and diagnostics. */
export function listProtectedContextKeys(context: StoryboardContext): string[] {
  return [...(states.get(context)?.committed ?? [])].sort();
}

export interface ProtectedContextSinks {
  /** Per-key provenance the runner reports back to callers. */
  provenance?: Map<string, ContextProvenanceEntry>;
  /** Keys a skipped/ungraded step marked as unavailable, with their reason. */
  unavailable?: Map<string, string>;
}

export interface ProtectedContextPatch {
  /** Values to write. */
  set?: Readonly<Record<string, unknown>>;
  /** Keys to remove. */
  unset?: readonly string[];
  /** Provenance entries to write. */
  setProvenance?: Readonly<Record<string, ContextProvenanceEntry>>;
  /** Provenance entries to remove. */
  unsetProvenance?: readonly string[];
  /** Keys to mark unavailable (reason keyed by the same key). */
  markUnavailable?: Readonly<Record<string, string>> | readonly string[];
  /** Keys whose unavailable marker should be cleared. */
  clearUnavailable?: readonly string[];
}

export interface ApplyProtectedContextOptions {
  writer?: ProtectedContextWriter;
  sinks?: ProtectedContextSinks;
  /**
   * Where this patch came from, used verbatim in the violation message so an
   * operator can see which funnel attempted the write.
   */
  origin: string;
}

function markUnavailableEntries(markUnavailable: ProtectedContextPatch['markUnavailable']): Array<[string, string]> {
  if (markUnavailable === undefined) return [];
  if (Array.isArray(markUnavailable)) return markUnavailable.map(key => [key, 'unavailable']);
  return Object.entries(markUnavailable as Record<string, string>);
}

/**
 * The sole commit point for storyboard-context values, deletions, provenance
 * and unavailable-output metadata.
 *
 * Validates the whole patch first. A forbidden write, delete or metadata
 * change throws `ProtectedContextViolation` and leaves every map exactly as
 * it was — including the ordinary, unprotected keys in the same patch, so a
 * rejected batch never half-lands.
 */
export function applyProtectedContextPatch(
  context: StoryboardContext,
  patch: ProtectedContextPatch,
  options: ApplyProtectedContextOptions
): void {
  const state = states.get(context);
  // Fail closed on an unregistered context. An unforwarded clone is not a
  // context this module has ever vouched for, so accepting a trusted write
  // into it would silently drop both the single-commit rule and the
  // writer-identity binding.
  const trusted = isTrustedWriter(options.writer) && state !== undefined && state.writer === options.writer;

  const setEntries = Object.entries(patch.set ?? {});
  const unsetKeys = patch.unset ?? [];
  const provenanceEntries = Object.entries(patch.setProvenance ?? {});
  const provenanceUnset = patch.unsetProvenance ?? [];
  const unavailableEntries = markUnavailableEntries(patch.markUnavailable);
  const clearUnavailable = patch.clearUnavailable ?? [];

  // Prototype-sensitive keys are refused for EVERY writer, before anything
  // else. `JSON.parse('{"__proto__": …}')` produces an own data property that
  // survives object spread and `Object.entries`, and a plain
  // `context[key] = value` assignment on it invokes the `Object.prototype`
  // setter — replacing the run context's prototype instead of creating an
  // own key. Every subsequent `key in context` read then resolves reserved
  // keys off the attacker's object. Writes below additionally use
  // `Object.defineProperty`, so neither half of that pair is load-bearing
  // alone.
  const prototypeKeys = [
    ...setEntries.map(([key]) => key),
    ...unsetKeys,
    ...provenanceEntries.map(([key]) => key),
    ...provenanceUnset,
    ...unavailableEntries.map(([key]) => key),
    ...clearUnavailable,
  ].filter(key => PROTOTYPE_SENSITIVE_KEYS.has(key));
  if (prototypeKeys.length > 0) {
    throw new ProtectedContextViolation(
      'reserved_key',
      [...new Set(prototypeKeys)],
      `${options.origin}: refused prototype-sensitive context key(s) ${[...new Set(prototypeKeys)].join(', ')}; these can rewrite the context's prototype and shadow reserved fixture keys. Rename them to anything other than __proto__, constructor or prototype.`
    );
  }

  if (!trusted) {
    const valueKeys = setEntries.map(([key]) => key).filter(isProtectedContextKey);
    if (valueKeys.length > 0) {
      throw new ProtectedContextViolation(
        'unauthorized_write',
        valueKeys,
        `${options.origin}: cannot write reserved fixture-preparation context key(s) ${valueKeys.join(', ')}; the "${PROTECTED_CONTEXT_PREFIX}" namespace is owned by fixture preparation. Declare the value under fixture_resolution[].context_outputs instead, or rename the key.`
      );
    }
    const deleteKeys = unsetKeys.filter(isProtectedContextKey);
    if (deleteKeys.length > 0) {
      throw new ProtectedContextViolation(
        'unauthorized_delete',
        deleteKeys,
        `${options.origin}: cannot delete reserved fixture-preparation context key(s) ${deleteKeys.join(', ')}`
      );
    }
    const metadataKeys = [
      ...provenanceEntries.map(([key]) => key),
      ...provenanceUnset,
      ...unavailableEntries.map(([key]) => key),
      ...clearUnavailable,
    ].filter(isProtectedContextKey);
    if (metadataKeys.length > 0) {
      throw new ProtectedContextViolation(
        'unauthorized_metadata',
        [...new Set(metadataKeys)],
        `${options.origin}: cannot change provenance or availability metadata for reserved key(s) ${[...new Set(metadataKeys)].join(', ')}; suppressing a prepared capture is as damaging as overwriting it`
      );
    }
  } else {
    // Even the preparation capability commits a protected key once. Steps
    // cannot reinterpret a pinned binding, and a second commit would mean
    // the graph published twice.
    // Every arm, not just `set`. Guarding writes alone let the preparation
    // capability unset a committed key, or delete its provenance, leaving
    // `listProtectedContextKeys` reporting a capture that no longer exists
    // and a key that can never be re-committed. "Committed once" has to
    // mean committed, not merely written once.
    const recommitted = [
      ...setEntries.map(([key]) => key),
      ...unsetKeys,
      ...provenanceUnset,
      ...unavailableEntries.map(([key]) => key),
    ].filter(key => isProtectedContextKey(key) && state?.committed.has(key) === true);
    if (recommitted.length > 0) {
      throw new ProtectedContextViolation(
        'already_committed',
        recommitted,
        `${options.origin}: reserved context key(s) ${recommitted.join(', ')} are already committed by fixture preparation and are immutable for the rest of the run`
      );
    }
    for (const [key] of setEntries) {
      if (isProtectedContextKey(key)) assertWellFormedProtectedKey(key, options.origin);
    }
  }

  // The commit below uses `delete` and `Object.defineProperty`, both of
  // which throw in strict mode on a non-configurable key or a non-extensible
  // target. Prove the destination can accept the whole patch before any of
  // it lands, so "validation complete, nothing may throw" is true rather
  // than merely intended.
  const mutatedKeys = [...new Set([...setEntries.map(([key]) => key), ...unsetKeys])];
  if (!Object.isExtensible(context)) {
    // A key that is own NOW but is also in `unset` will not be own by the
    // time it is defined — removals apply first — so it counts as an
    // addition for extensibility purposes. Convention extraction uses
    // exactly this overlapping shape.
    const unsetSet = new Set(unsetKeys);
    const added = mutatedKeys.filter(key => !Object.hasOwn(context, key) || unsetSet.has(key));
    if (added.length > 0) {
      throw new ProtectedContextViolation(
        'uncloneable_value',
        added,
        `${options.origin}: the storyboard context is not extensible, so key(s) ${added.join(', ')} cannot be written`
      );
    }
  }
  const locked = mutatedKeys.filter(key => {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    return descriptor !== undefined && descriptor.configurable === false;
  });
  if (locked.length > 0) {
    throw new ProtectedContextViolation(
      'uncloneable_value',
      locked,
      `${options.origin}: context key(s) ${locked.join(', ')} are non-configurable and cannot be rewritten or removed`
    );
  }

  // Snapshot protected values during VALIDATION, not during the commit.
  // `structuredClone` throws on functions, Proxies and other non-cloneables,
  // and a throw partway through the commit loop is exactly the half-landed
  // state this funnel exists to prevent.
  const snapshots = new Map<string, unknown>();
  for (const [key, value] of setEntries) {
    if (!isProtectedContextKey(key)) continue;
    let cloned: unknown;
    try {
      cloned = structuredClone(value);
    } catch (error) {
      throw new ProtectedContextViolation(
        'uncloneable_value',
        [key],
        `${options.origin}: reserved context key "${key}" holds a value that cannot be detached (${error instanceof Error ? error.message : String(error)}); captures must be plain JSON-shaped data`
      );
    }
    assertFreezable(cloned, key, options.origin);
    snapshots.set(key, freezeDeep(cloned));
  }

  // Protected PROVENANCE is detached here too, for the same reason and in
  // the same place. Doing it in the sink loop put a `structuredClone` below
  // the barrier, where a throw left the value committed, `state.committed`
  // updated and the provenance map empty — and escaped as a `DOMException`
  // rather than a `ProtectedContextViolation`, so both guarded call sites
  // rethrew and aborted the run instead of grading it.
  const provenanceSnapshots = new Map<string, ContextProvenanceEntry>();
  for (const [key, entry] of provenanceEntries) {
    if (!isProtectedContextKey(key)) continue;
    let cloned: ContextProvenanceEntry;
    try {
      cloned = structuredClone(entry);
    } catch (error) {
      throw new ProtectedContextViolation(
        'uncloneable_value',
        [key],
        `${options.origin}: provenance for reserved context key "${key}" cannot be detached (${error instanceof Error ? error.message : String(error)}); capture provenance must be plain JSON-shaped data`
      );
    }
    assertFreezable(cloned, key, options.origin);
    provenanceSnapshots.set(key, freezeDeep(cloned));
  }

  // ── Validation complete; from here nothing may throw. ──
  // Removals apply before writes. Convention extraction clears an alias
  // group and then republishes the keys the new response actually carries;
  // writing first would delete the value it just wrote.
  for (const key of unsetKeys) delete context[key];
  for (const [key, value] of setEntries) {
    // `defineProperty`, never `context[key] = …`: assignment would invoke an
    // inherited setter for a key like `__proto__`.
    Object.defineProperty(context, key, {
      value: snapshots.has(key) ? snapshots.get(key) : value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (isProtectedContextKey(key)) state?.committed.add(key);
  }

  const sinks = options.sinks;
  if (sinks?.provenance) {
    for (const key of provenanceUnset) sinks.provenance.delete(key);
    for (const [key, entry] of provenanceEntries) {
      // Detached and frozen for protected keys — retaining the caller's
      // object by reference left a live alias that could rewrite committed
      // metadata without re-entering the funnel. The clone happened during
      // validation; this loop only reads the result.
      sinks.provenance.set(key, provenanceSnapshots.get(key) ?? entry);
    }
  }
  if (sinks?.unavailable) {
    for (const key of clearUnavailable) sinks.unavailable.delete(key);
    for (const [key, reason] of unavailableEntries) sinks.unavailable.set(key, reason);
  }
}

/** Authoring-time guard for a declaration-produced reserved key. */
export function assertWellFormedProtectedKey(key: string, location: string): void {
  if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
    throw new ProtectedContextViolation(
      'invalid_key',
      [key],
      `${location}: "${key}" is a prototype-sensitive key; rename it to anything other than __proto__, constructor or prototype`
    );
  }
  if (!PROTECTED_KEY_PATTERN.test(key)) {
    throw new ProtectedContextViolation(
      'invalid_key',
      [key],
      `${location}: reserved capture key "${key}" must match ${PROTECTED_KEY_PATTERN.source} so whole-key $context.<key> substitution resolves it`
    );
  }
}

/**
 * Refuse values `Object.freeze` cannot actually make immutable.
 *
 * `structuredClone` faithfully preserves `Map`, `Set`, `Date`, `RegExp`,
 * `Error`, `ArrayBuffer` and typed arrays, and freezing any of those only
 * locks their own properties — a frozen `Map` still accepts `.set()`, and
 * a frozen `ArrayBuffer`'s bytes stay writable through a fresh view. No
 * capture produces one today (values come from parsed
 * seller JSON, authored fixtures, or the witness builder's plain
 * arrays/objects), so this is a loud guard against a future witness kind
 * silently becoming mutable rather than a reachable condition.
 */
function assertFreezable(value: unknown, key: string, origin: string, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) assertFreezable(nested, key, origin, seen);
    return;
  }
  // ALLOWLIST, not a denylist of known-bad constructors. The denylist
  // version named `Map`, `Set`, `Date` and typed arrays and therefore
  // missed a bare `ArrayBuffer` (`isView` is false for it, and the bytes
  // stay writable through a fresh view of a frozen buffer), `RegExp` and
  // `Error` — all of which `structuredClone` preserves. A future witness
  // kind returning any of them would have become silently mutable, which
  // is the exact drift this guard exists to prevent.
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtectedContextViolation(
      'uncloneable_value',
      [key],
      `${origin}: reserved context key "${key}" holds a ${(value as object).constructor?.name ?? 'non-plain object'}, which Object.freeze cannot make immutable; captures must be plain JSON-shaped data`
    );
  }
  // `Reflect.ownKeys`, not `Object.values`: a non-enumerable or
  // symbol-keyed property is neither checked nor frozen by an enumerable
  // walk, so it would survive `freezeDeep` as a mutable branch.
  for (const nested of Reflect.ownKeys(value)) {
    assertFreezable((value as Record<PropertyKey, unknown>)[nested], key, origin, seen);
  }
}

/**
 * Deep-freeze in place. Applied to the canonical snapshot after cloning, so
 * the value the runner holds cannot be mutated even by code that reached it
 * through an ordinary context read.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  // `Reflect.ownKeys` for the same reason `assertFreezable` uses it: an
  // enumerable-only walk leaves non-enumerable and symbol-keyed branches
  // unfrozen inside an object that reports as frozen.
  for (const nested of Reflect.ownKeys(value as object)) {
    freezeDeep((value as Record<PropertyKey, unknown>)[nested]);
  }
  return value;
}

/**
 * Detached view of a protected value for request building or diagnostics.
 *
 * Request builders legitimately mutate the objects they are handed, so a
 * frozen snapshot cannot be passed through directly; a clone is both safe to
 * mutate and unable to write back.
 */
export function detachProtectedValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}
