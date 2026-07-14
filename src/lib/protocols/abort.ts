export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveRequestTimeoutMs(timeoutMs: number | undefined, defaultTimeoutMs?: number): number | undefined {
  const resolved = timeoutMs ?? defaultTimeoutMs;
  if (resolved == null) return undefined;
  if (resolved === 0) return undefined;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`requestTimeoutMs must be a finite non-negative number <= ${MAX_TIMER_DELAY_MS}`);
  }
  return resolved;
}

export function resolveClientRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === 0) return MAX_TIMER_DELAY_MS;
  return resolveRequestTimeoutMs(timeoutMs);
}

export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && (reason.name === 'AbortError' || reason.name === 'TimeoutError')) return reason;
  const error = new Error(reason == null ? 'The operation was aborted' : String(reason));
  error.name = 'AbortError';
  if (reason instanceof Error) {
    (error as Error & { cause?: unknown }).cause = reason;
    error.message = reason.message;
  }
  return error;
}

export function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Request timed out after ${timeoutMs} ms`);
  error.name = 'TimeoutError';
  return error;
}

export function isAbortOrTimeoutError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  if (value.name === 'AbortError' || value.name === 'TimeoutError') return true;
  // MCP SDK v1 raises JSON-RPC RequestTimeout (-32001); the v2 packages use
  // the typed SDK error code REQUEST_TIMEOUT. Both represent the same
  // timeout/cancellation boundary and must bypass endpoint fallback.
  return value.code === -32001 || value.code === 'REQUEST_TIMEOUT';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

export async function withAbortSignal<T>(
  signals: Array<AbortSignal | null | undefined>,
  timeoutMs: number | undefined,
  fn: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal != null);
  for (const signal of activeSignals) {
    throwIfAborted(signal);
  }

  if (timeoutMs == null && activeSignals.length === 0) {
    return fn(undefined);
  }

  if (timeoutMs == null && activeSignals.length === 1) {
    const signal = activeSignals[0]!;
    try {
      return await fn(signal);
    } catch (error) {
      if (signal.aborted) {
        throw createAbortError(signal.reason);
      }
      throw error;
    }
  }

  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const listeners = activeSignals.map(signal => {
    const listener = () => abort(createAbortError(signal.reason));
    signal.addEventListener('abort', listener, { once: true });
    return { signal, listener };
  });
  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => {
          abort(createTimeoutError(timeoutMs));
        }, timeoutMs);

  try {
    return await fn(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
    for (const { signal, listener } of listeners) {
      signal.removeEventListener('abort', listener);
    }
  }
}
