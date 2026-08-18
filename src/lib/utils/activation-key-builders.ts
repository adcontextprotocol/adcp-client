// Typed factory helpers for `ActivationKey` — schema oneOf on
// `type: "segment_id" | "key_value"`. The `key_value` arm is consistently
// mis-shaped: adopters intuit a nested `{ key_value: { key, value } }` and
// write that, even though the schema flattens `key`/`value` onto the
// `ActivationKey` itself. SHAPE-GOTCHAS §1.
//
// Same pattern as `asset-builders.ts` / `render-builders.ts`: spread order
// writes the discriminator last, so a runtime cast that smuggles `type`
// in via `fields` cannot clobber it.

import type { ActivationKey } from '../types/core.generated';

type SegmentIdKey = Extract<ActivationKey, { type: 'segment_id' }>;
type KeyValueKey = Extract<ActivationKey, { type: 'key_value' }>;
type SegmentIdKeyFields = { segment_id: SegmentIdKey['segment_id'] };
type KeyValueKeyFields = { key: KeyValueKey['key']; value: KeyValueKey['value'] };
/** Build a `segment_id`-variant `ActivationKey`. */
export function segmentIdActivationKey(fields: SegmentIdKeyFields): SegmentIdKey {
  return { ...fields, type: 'segment_id' };
}

/** Build a `key_value`-variant `ActivationKey`. `key`/`value` flatten on the top level. SHAPE-GOTCHAS §1. */
export function keyValueActivationKey(fields: KeyValueKeyFields): KeyValueKey {
  return { ...fields, type: 'key_value' };
}

/** Grouped accessor for both `ActivationKey` variants. */
export const activationKey = {
  segment: segmentIdActivationKey,
  keyValue: keyValueActivationKey,
} as const;
