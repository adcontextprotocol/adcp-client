// Typed factory helpers for `ActivationKey` — schema oneOf on
// `type: "segment_id" | "key_value"`. The `key_value` arm is consistently
// mis-shaped: adopters intuit a nested `{ key_value: { key, value } }` and
// write that, even though the schema flattens `key`/`value` onto the
// `ActivationKey` itself. SHAPE-GOTCHAS §1.
//
// Same pattern as `asset-builders.ts` / `render-builders.ts`: spread order
// writes the discriminator last, so a runtime cast that smuggles `type`
// in via `fields` cannot clobber it.

import type { ActivationKey } from "../types/core.generated";

type SegmentIdKey = Extract<ActivationKey, { type: "segment_id" }>;
type KeyValueKey = Extract<ActivationKey, { type: "key_value" }>;
type Tagged<T, Tag extends string> = Omit<T, "type"> & { type: Tag };

/** Build a `segment_id`-variant `ActivationKey`. */
export function segmentIdActivationKey(fields: Omit<SegmentIdKey, "type">): Tagged<SegmentIdKey, "segment_id"> {
  return { ...fields, type: "segment_id" };
}

/** Build a `key_value`-variant `ActivationKey`. `key`/`value` flatten on the top level. SHAPE-GOTCHAS §1. */
export function keyValueActivationKey(fields: Omit<KeyValueKey, "type">): Tagged<KeyValueKey, "key_value"> {
  return { ...fields, type: "key_value" };
}

/** Grouped accessor for both `ActivationKey` variants. */
export const activationKey = {
  segment: segmentIdActivationKey,
  keyValue: keyValueActivationKey,
} as const;
