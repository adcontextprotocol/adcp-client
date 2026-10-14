/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingGcsFenceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'UNSAFE_BUCKET'
      | 'REVOKED'
      | 'NOT_REVOKED'
      | 'CONTENT_CONFLICT'
      | 'ABORTED'
      | 'PROVIDER_UNAVAILABLE'
      | 'DEADLINE_EXCEEDED'
      | 'HOST_CALLBACK_FAILED'
      | 'STATE_UNAVAILABLE'
  ) {
    super(`Reporting GCS fence: ${code}`);
    this.name = 'ReportingGcsFenceError';
    Object.defineProperty(this, Symbol.for('adcp.reportingGcsFenceError'), { value: true });
  }
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function isReportingGcsFenceError(error: unknown): error is ReportingGcsFenceError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reportingGcsFenceError')] === true
  );
}
