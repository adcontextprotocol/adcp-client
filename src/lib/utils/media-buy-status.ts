import type { MediaBuyStatus } from '../types';
import { MediaBuyStatusSchema } from '../types/schemas.generated';

/**
 * Return true when a value is one of the SDK's current media-buy lifecycle
 * statuses.
 */
export function isMediaBuyStatus(value: unknown): value is MediaBuyStatus {
  return MediaBuyStatusSchema.safeParse(value).success;
}

/**
 * Extract the seller-authoritative media-buy lifecycle status from mixed-version
 * response payloads.
 *
 * AdCP 3.1 renamed the media-buy lifecycle field from top-level `status` to
 * `media_buy_status` to avoid colliding with task/envelope `status`. Prefer the
 * canonical field when it is present; otherwise fall back to legacy `status`
 * only when it is a valid MediaBuyStatus. Transport/task-only statuses such as
 * `submitted`, `working`, `failed`, and `input-required` return undefined.
 * For explicit 3.1+ payloads, bare `status` values that also appear in
 * TaskStatus (`completed`, `rejected`, `canceled`) are ambiguous because they
 * may be only the task envelope status; use `media_buy_status` to report those
 * media-buy lifecycle states.
 */
export function getAuthoritativeMediaBuyStatus(response: unknown): MediaBuyStatus | undefined {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return undefined;

  const record = response as Record<string, unknown>;
  if (record.media_buy_status !== undefined && record.media_buy_status !== null) {
    return isMediaBuyStatus(record.media_buy_status) ? record.media_buy_status : undefined;
  }

  if (isAmbiguousExplicit31Status(record)) return undefined;
  return isMediaBuyStatus(record.status) ? record.status : undefined;
}

const AMBIGUOUS_EXPLICIT31_STATUS = new Set(['completed', 'rejected', 'canceled']);

function isAmbiguousExplicit31Status(record: Record<string, unknown>): boolean {
  return (
    typeof record.status === 'string' &&
    AMBIGUOUS_EXPLICIT31_STATUS.has(record.status) &&
    isExplicit31OrLaterPayload(record)
  );
}

function isExplicit31OrLaterPayload(record: Record<string, unknown>): boolean {
  const version = record.adcp_version;
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)(?:\.|-|$)/.exec(version);
  if (!match) return false;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  return major > 3 || (major === 3 && minor >= 1);
}
