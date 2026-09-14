declare const cursorBrand: unique symbol;

/** A webhook wake-up target. Never a durable checkpoint or a request cursor. */
export interface AdvisoryThroughCursor {
  readonly kind: 'advisory';
  readonly value: string;
  readonly [cursorBrand]: 'advisory';
}

/** A page checkpoint acknowledged by the adopter's projection/checkpoint transaction. */
export interface DurableAccountChangeCursor {
  readonly kind: 'checkpoint';
  readonly value: string;
  readonly [cursorBrand]: 'checkpoint';
}

/**
 * Restore a previously acknowledged cursor from adopter storage. The caller
 * must select the same seller, authenticated principal, account and filters.
 * Never use this to promote a webhook target or a pre-snapshot checkpoint.
 */
export function restoreAccountChangeCursor(value: string): DurableAccountChangeCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('A persisted account change cursor must contain 1–4096 characters.');
  }
  return Object.freeze({ kind: 'checkpoint', value }) as DurableAccountChangeCursor;
}
