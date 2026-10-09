import { ReportingRowStoreError, isReportingRowStoreError } from './row-storage-errors';

/**
 * Internal helpers shared by the bundled cloud row-object providers (GCS, S3,
 * Azure Blob). Not part of the public `reporting/ledger` surface.
 */

/** Stable code for an aborted operation: deadline expiry versus caller cancellation. */
export function reportingRowAbortError(signal: AbortSignal): ReportingRowStoreError {
  const reason = signal.reason as { name?: unknown } | undefined;
  if (isReportingRowStoreError(reason)) return reason;
  return new ReportingRowStoreError(reason?.name === 'TimeoutError' ? 'DEADLINE_EXCEEDED' : 'ABORTED');
}

/**
 * Run one provider operation under the caller's signal. Settles as soon as the
 * signal aborts, even when the official client ignores cancellation. Raw
 * provider errors never escape: anything that is not already a
 * `ReportingRowStoreError` becomes `PROVIDER_UNAVAILABLE`.
 */
export async function runReportingRowProviderOperation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (!(signal instanceof AbortSignal)) throw new ReportingRowStoreError('INVALID_INPUT', 'a signal is required');
  if (signal.aborted) throw reportingRowAbortError(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(reportingRowAbortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw reportingRowAbortError(signal);
    if (isReportingRowStoreError(error)) throw error;
    throw new ReportingRowStoreError('PROVIDER_UNAVAILABLE');
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Drain a byte stream, aborting once it exceeds `maxBytes`
 * (`ROWS_INTEGRITY_FAILED`) or the signal fires. The stream is always destroyed.
 */
export async function readReportingRowStream(
  stream: AsyncIterable<unknown> & { destroy?: (error?: Error) => unknown },
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const abort = () => stream.destroy?.(reportingRowAbortError(signal));
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    if (signal.aborted) throw reportingRowAbortError(signal);
    for await (const chunk of stream) {
      if (signal.aborted) throw reportingRowAbortError(signal);
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      count += bytes.byteLength;
      if (count > maxBytes) {
        throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'stored object exceeds its recorded size');
      }
      chunks.push(bytes);
    }
    if (signal.aborted) throw reportingRowAbortError(signal);
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy?.();
  }
}

/** Validate a get request's range and cap before any provider I/O. */
export function assertReportingRowReadBounds(input: {
  range?: { offset: number; length: number };
  maxBytes: number;
}): void {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'maxBytes must be a non-negative integer');
  }
  if (input.range === undefined) return;
  const { offset, length } = input.range;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'range must use non-negative integers');
  }
  if (length > input.maxBytes) {
    throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'requested range exceeds the read cap');
  }
}

/**
 * Pick the host-injected client for a binding. `credentialRef` selects from a
 * closed map; without one, the default client is used. Unknown references fail
 * closed with `UNSAFE_BINDING` and never echo the reference.
 */
export function selectReportingRowClient<T>(
  defaultClient: T | undefined,
  clients: ReadonlyMap<string, T>,
  credentialRef: string | undefined
): T {
  const client = credentialRef === undefined ? defaultClient : clients.get(credentialRef);
  if (client === undefined) {
    throw new ReportingRowStoreError('UNSAFE_BINDING', 'no client is configured for this binding');
  }
  return client;
}

/** Copy a host client map into a closed, frozen lookup. */
export function reportingRowClientMap<T>(clients: Readonly<Record<string, T>> | undefined): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  if (clients === undefined) return map;
  if (!clients || typeof clients !== 'object') {
    throw new ReportingRowStoreError('INVALID_INPUT', 'clients must map credential references to clients');
  }
  for (const [ref, client] of Object.entries(clients)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(ref) || !client) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'clients must map credential references to clients');
    }
    map.set(ref, client);
  }
  return map;
}

/** Throw `INVALID_INPUT` unless `location` has exactly the allowed keys (and every required one). */
export function assertReportingRowLocationKeys(
  location: Readonly<Record<string, string>>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'location must be an object');
  }
  const keys = Object.keys(location);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some(key => !allowed.has(key) || typeof location[key] !== 'string') ||
    required.some(key => !keys.includes(key))
  ) {
    throw new ReportingRowStoreError(
      'INVALID_INPUT',
      `location accepts only ${[...required, ...optional.map(key => `${key}?`)].join(', ')}`
    );
  }
}

/**
 * Whether an object-store prefix filter can match keys under the binding's
 * owned prefix. An absent or empty filter matches everything.
 */
export function reportingRowPrefixFilterOverlaps(filter: string | undefined, bindingPrefix: string): boolean {
  if (!filter) return true;
  const owned = `${bindingPrefix}/`;
  return owned.startsWith(filter) || filter.startsWith(owned);
}
