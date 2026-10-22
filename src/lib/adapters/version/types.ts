/**
 * Registry pattern for AdCP protocol-version adapters.
 *
 * Each AdCP tool that needs hand-written adaptation between two consecutive
 * minor releases registers a `VersionAdapter` under the older release's key.
 * `adaptRequest` converts a request from the next minor down to the key's
 * release, and `adaptResponse` converts a response from the key's release up
 * to the next minor. Both return the (possibly modified) payload and an
 * optional `VersionDrift` describing what changed.
 *
 * Hand-written adapters cover renames and moves. Fields the older release
 * cannot express at all are removed by the schema-driven projection in
 * `schema-projection.ts`, which runs after the adapter on each step.
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
  /** Names (or JSON paths) of the fields removed from the payload. */
  strippedFields?: string[];
  /** Fields whose values were moved or rewritten rather than removed. */
  movedFields?: Array<{ from: string; to: string }>;
  /** Individual drift types when one adaptation aggregates multiple changes. */
  constituentTypes?: string[];
  /** Release the payload was converted from. Set by the translation chain. */
  fromVersion?: string;
  /** Release the payload was converted to. Set by the translation chain. */
  toVersion?: string;
}

export interface VersionAdapter {
  /** AdCP tool name this adapter handles (snake_case, e.g. `create_media_buy`). */
  readonly toolName: string;

  /**
   * Adapt a request from the next minor release down to this adapter's
   * release. Returns the (possibly modified) params and an optional drift
   * description. When no adaptation is needed the original params reference
   * is returned unchanged.
   */
  adaptRequest?(params: unknown): { params: unknown; drift?: VersionDrift };

  /**
   * Adapt a response from this adapter's release up to the next minor
   * release. Returns the original reference when nothing changes.
   */
  adaptResponse?(data: unknown): { data: unknown; drift?: VersionDrift };
}
