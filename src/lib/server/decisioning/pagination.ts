/**
 * Cursor-based pagination primitive for all list-returning methods.
 * Cursor is opaque to the framework (platform-defined; usually a
 * base64-encoded internal offset).
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

export interface CursorPage<T> {
  items: T[];
  /** Opaque continuation token; absent on the last page. */
  nextCursor?: string;
}

export interface CursorRequest {
  /** Maximum items to return; framework caps to a sane upper bound. */
  limit?: number;
  /** Continuation token from a previous response's `nextCursor`. */
  cursor?: string;
}
