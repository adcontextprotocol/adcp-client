import type { File } from '@google-cloud/storage';
import { isReportingObjectWriteConflictError, isReportingObjectWriteNotRevokedError } from '../ledger/object-writes';
import { ReportingGcsFenceError, isReportingGcsFenceError } from './errors';

export function activeGcsSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
const active = activeGcsSignal;

export async function withGcsDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  context: { signal?: AbortSignal; milliseconds?: number } = {}
): Promise<T> {
  const signal = context.signal;
  const deadline = context.milliseconds ?? 60_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60_000)
    throw new ReportingGcsFenceError('INVALID_INPUT');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ReportingGcsFenceError('INVALID_INPUT');
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ReportingGcsFenceError('ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new ReportingGcsFenceError('DEADLINE_EXCEEDED')), deadline);
  let rejectAbort: (() => void) | undefined;
  try {
    active(controller.signal);
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (isReportingGcsFenceError(error)) throw error;
    if (
      isReportingObjectWriteConflictError(error) ||
      (error instanceof Error && isReportingObjectWriteConflictError(error.cause))
    )
      throw new ReportingGcsFenceError('CONTENT_CONFLICT');
    if (
      isReportingObjectWriteNotRevokedError(error) ||
      (error instanceof Error && isReportingObjectWriteNotRevokedError(error.cause))
    )
      throw new ReportingGcsFenceError('NOT_REVOKED');
    // Raw state/provider errors can contain credentials or operational inputs.
    throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export async function readGcsBytes(file: File, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  active(signal);
  const stream = file.createReadStream();
  const abort = () => stream.destroy(new ReportingGcsFenceError('ABORTED'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    for await (const chunk of stream) {
      active(signal);
      count += chunk.length;
      if (count > maxBytes) throw new ReportingGcsFenceError('CONTENT_CONFLICT');
      chunks.push(Buffer.from(chunk));
    }
    active(signal);
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}
