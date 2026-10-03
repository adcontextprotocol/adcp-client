import type { AdcpLogger } from './create-adcp-server';

/**
 * Compatibility-window warnings for account-reference behavior that becomes
 * strict by default in the next major release (`strictAccountReferences`).
 */
export type AccountReferenceWarningCode =
  | 'ADCP_UNRESOLVED_ACCOUNT_REFERENCE'
  | 'ADCP_IMPLICIT_ACCOUNT_IDENTITY_MISMATCH'
  | 'ADCP_REQUIRED_FOR_PRODUCTS_NOT_ENFORCED'
  | 'ADCP_LIST_ACCOUNTS_FILTER_RESOLVED';

// Process-wide, not per server: `serve()` can construct a server per request,
// so a per-instance flag would still flood logs.
const warnedCodes = new Set<AccountReferenceWarningCode>();

/**
 * Warn once per process per code (`logger.warn`, plus `process.emitWarning`
 * outside production). Later occurrences go to `logger.debug`. Messages and
 * metadata are server-side only; never echo them to the buyer.
 */
export function warnAccountReferenceDeprecation(
  logger: AdcpLogger,
  code: AccountReferenceWarningCode,
  message: string,
  meta: Record<string, unknown> = {}
): void {
  const fields = { ...meta, code };
  if (warnedCodes.has(code)) {
    logger.debug(message, fields);
    return;
  }
  warnedCodes.add(code);
  logger.warn(message, fields);
  if (process.env.NODE_ENV !== 'production') {
    try {
      process.emitWarning(message, { type: 'DeprecationWarning', code });
    } catch {
      // `--throw-deprecation` must not turn a compatibility warning into a request failure.
    }
  }
}

/** @internal Test hook: forget which compatibility warnings were emitted. */
export function _resetAccountReferenceWarnings(): void {
  warnedCodes.clear();
}
