/**
 * Platform identifiers on `sync_event_sources` and `sync_audiences` rows.
 *
 * AdCP 3.3 renamed the object's identifier on the seller's ad platform from
 * `seller_id` to `platform_id`. In 3.3 and later 3.x responses a seller that
 * reports the identifier MUST emit both names with identical values; buyers
 * MUST prefer `platform_id` and fall back to `seller_id` only when
 * `platform_id` is absent. Releases below 3.3 define `seller_id` only.
 */
/** A result row that may carry the object's platform identifier under either name. */
export interface PlatformIdentifiedRow {
  platform_id?: string;
  /** @deprecated AdCP 3.3 alias of `platform_id`; retained through 3.x. */
  seller_id?: string;
}

/**
 * The object's identifier on the seller's ad platform, read from a
 * `sync_event_sources` `event_sources[]` or `sync_audiences` `audiences[]`
 * row: `platform_id`, else the deprecated `seller_id`, else `undefined`.
 *
 * The fallback also reads rows from sellers on AdCP 3.2 and earlier, which
 * send `seller_id` only. Requests keep using `event_source_id` and
 * `audience_id`; this identifier is the platform's, never the seller's
 * identity.
 */
export function platformIdOf(item: PlatformIdentifiedRow | null | undefined): string | undefined {
  if (item == null || typeof item !== 'object') return undefined;
  if (typeof item.platform_id === 'string') return item.platform_id;
  return typeof item.seller_id === 'string' ? item.seller_id : undefined;
}

/** Tools whose result rows carry the platform identifier, and the array that holds them. */
const PLATFORM_ID_ROW_ARRAYS: Readonly<Record<string, string>> = {
  sync_event_sources: 'event_sources',
  sync_audiences: 'audiences',
};
const ROW_ARRAY_KEYS: readonly string[] = Object.values(PLATFORM_ID_ROW_ARRAYS);

/** @internal Whether a tool's result rows carry the platform identifier. */
export function toolHasPlatformIdRows(toolName: string | undefined): boolean {
  return toolName !== undefined && Object.prototype.hasOwnProperty.call(PLATFORM_ID_ROW_ARRAYS, toolName);
}

/** @internal A row whose `platform_id` and `seller_id` differ. */
export interface PlatformIdMismatch {
  /** JSON Pointer to the row, e.g. `/audiences/2`. */
  pointer: string;
  platform_id: string;
  seller_id: string;
}

/** @internal Thrown when a result row carries two different platform identifiers. */
export class PlatformIdMismatchError extends Error {
  readonly mismatch: PlatformIdMismatch;

  constructor(mismatch: PlatformIdMismatch) {
    super(
      `${mismatch.pointer} carries platform_id ${JSON.stringify(mismatch.platform_id)} and seller_id ` +
        `${JSON.stringify(mismatch.seller_id)}; AdCP 3.3 requires the two to be identical. Return one of them, ` +
        'or the same value in both.'
    );
    this.name = 'PlatformIdMismatchError';
    this.mismatch = mismatch;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rewrite each identifier-bearing row with `rewrite`, keeping references for
 * unchanged rows and arrays. Rows without either name, non-object rows, and
 * rows whose two names differ are left as they are.
 */
function mapPlatformIdRows<T>(
  result: T,
  rewrite: (row: Record<string, unknown>, id: string) => Record<string, unknown>
): T {
  if (!isRecord(result)) return result;
  let next: Record<string, unknown> | undefined;
  for (const key of ROW_ARRAY_KEYS) {
    const rows = result[key];
    if (!Array.isArray(rows)) continue;
    let changed = false;
    const mapped = rows.map(row => {
      if (!isRecord(row)) return row;
      const { platform_id, seller_id } = row;
      const hasPlatform = typeof platform_id === 'string';
      const hasSeller = typeof seller_id === 'string';
      if (!hasPlatform && !hasSeller) return row;
      if (hasPlatform && hasSeller && platform_id !== seller_id) return row;
      const rewritten = rewrite(row, (hasPlatform ? platform_id : seller_id) as string);
      if (rewritten !== row) changed = true;
      return rewritten;
    });
    if (changed) {
      next ??= { ...result };
      next[key] = mapped;
    }
  }
  return (next ?? result) as T;
}

/** @internal The first row whose `platform_id` and `seller_id` differ, if any. */
export function findPlatformIdMismatch(result: unknown): PlatformIdMismatch | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of ROW_ARRAY_KEYS) {
    const rows = result[key];
    if (!Array.isArray(rows)) continue;
    for (const [index, row] of rows.entries()) {
      if (!isRecord(row)) continue;
      const { platform_id, seller_id } = row;
      if (typeof platform_id === 'string' && typeof seller_id === 'string' && platform_id !== seller_id) {
        return { pointer: `/${key}/${index}`, platform_id, seller_id };
      }
    }
  }
  return undefined;
}

/** @internal Throw {@link PlatformIdMismatchError} when a row's two identifiers differ. */
export function assertPlatformIdsAgree(result: unknown): void {
  const mismatch = findPlatformIdMismatch(result);
  if (mismatch) throw new PlatformIdMismatchError(mismatch);
}

/**
 * @internal Give every identifier-bearing row both `platform_id` and
 * `seller_id`, as AdCP 3.3 and later 3.x responses require. Idempotent;
 * returns the input reference when nothing changes. Rows whose two names
 * differ are left untouched: check with {@link findPlatformIdMismatch}.
 */
export function withDualPlatformIds<T>(result: T): T {
  return mapPlatformIdRows(result, (row, id) =>
    row.platform_id === id && row.seller_id === id ? row : { ...row, platform_id: id, seller_id: id }
  );
}

/**
 * @internal Give every identifier-bearing row `seller_id` only, the one name
 * AdCP 3.2 and earlier define. Returns the input reference when nothing
 * changes. Rows whose two names differ are left untouched.
 */
export function withSellerIdOnly<T>(result: T): T {
  return mapPlatformIdRows(result, (row, id) => {
    if (!('platform_id' in row) && row.seller_id === id) return row;
    const { platform_id: _platformId, ...rest } = row;
    void _platformId;
    return { ...rest, seller_id: id };
  });
}

/** @internal Whether a release carries both identifier names (AdCP 3.3 and later). */
export function releaseCarriesPlatformId(release: string): boolean {
  // Compare at release precision: a 3.3 prerelease such as `3.3-rc.3` is 3.3.
  const match = /^v?(\d+)\.(\d+)/.exec(release.trim());
  if (!match) return false;
  const major = Number(match[1]);
  return major > 3 || (major === 3 && Number(match[2]) >= 3);
}

/** @internal Project identifier-bearing rows for the release a reader is served. */
export function projectPlatformIdsForRelease<T>(result: T, release: string): T {
  return releaseCarriesPlatformId(release) ? withDualPlatformIds(result) : withSellerIdOnly(result);
}

/**
 * @internal In-place form of {@link withDualPlatformIds} for sanitizers that
 * mutate the result they persist. Rows whose two names differ are left
 * untouched.
 */
export function addDualPlatformIdsInPlace(result: unknown): void {
  if (!isRecord(result)) return;
  for (const key of ROW_ARRAY_KEYS) {
    const rows = result[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const { platform_id, seller_id } = row;
      if (typeof platform_id === 'string' && seller_id === undefined) row.seller_id = platform_id;
      else if (typeof seller_id === 'string' && platform_id === undefined) row.platform_id = seller_id;
    }
  }
}
