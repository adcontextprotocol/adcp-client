export type ReportingRowStoreErrorCode =
  | 'INVALID_INPUT'
  | 'CONTENT_CONFLICT'
  | 'ROWS_INTEGRITY_FAILED'
  | 'ROWS_UNAVAILABLE'
  | 'ROWS_EXPIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'ABORTED'
  | 'UNSAFE_BINDING'
  | 'STATE_UNAVAILABLE';

/** Stable, secret-free row-storage failure. Switch on `code`. */
export class ReportingRowStoreError extends Error {
  constructor(
    readonly code: ReportingRowStoreErrorCode,
    detail?: string
  ) {
    super(detail ? `Reporting row store: ${code}: ${detail}` : `Reporting row store: ${code}`);
    this.name = 'ReportingRowStoreError';
    Object.defineProperty(this, Symbol.for('adcp.reportingRowStoreError'), { value: true });
  }
}

export function isReportingRowStoreError(error: unknown): error is ReportingRowStoreError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reportingRowStoreError')] === true
  );
}
