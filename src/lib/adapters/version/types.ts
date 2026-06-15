/**
 * Registry pattern for AdCP protocol-version request adapters.
 *
 * Each AdCP tool that needs adaptation when targeting a seller on an older
 * protocol version registers a `VersionAdapter`. The adapter's `adaptRequest`
 * strips or rewrites fields the target version does not accept, returning the
 * adapted params and an optional `VersionDrift` describing what changed.
 *
 * Adapters live in per-version directories (`version/<target>/`) and are
 * collected by the registry in `version/index.ts`. Adding support for a new
 * version transition means adding a sibling directory — nothing else changes.
 */

export interface VersionDrift {
  /** Machine-readable event type surfaced in `debug_logs`. */
  type: string;
  /** Human-readable description of what was stripped and why. */
  message: string;
  /** Names of the fields removed from the request. */
  strippedFields?: string[];
}

export interface VersionAdapter {
  /** AdCP tool name this adapter handles (snake_case, e.g. `create_media_buy`). */
  readonly toolName: string;

  /**
   * Adapt a request for the target protocol version. Returns the (possibly
   * modified) params and an optional drift description. When no adaptation is
   * needed the original params reference is returned unchanged.
   */
  adaptRequest(params: unknown): { params: unknown; drift?: VersionDrift };
}
