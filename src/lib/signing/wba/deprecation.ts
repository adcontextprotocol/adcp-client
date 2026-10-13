/**
 * Once-per-process deprecation notice for RFC 9421-profile configuration.
 * The profile is deprecated in AdCP 3.3, keeps working through 3.x, and is
 * removed in 4.0 (spec D5). Uses `process.emitWarning`, so `--no-deprecation`
 * or `ADCP_SUPPRESS_RFC9421_DEPRECATION=1` silences it. Under
 * `--throw-deprecation` Node raises it asynchronously, as it does for every
 * deprecation: set the variable in processes that run with that flag.
 */
const warned = new Set<string>();

export type Rfc9421DeprecationSurface = 'signing' | 'verification';

const MESSAGES: Record<Rfc9421DeprecationSurface, string> = {
  signing:
    'RFC 9421-profile request signing (adcp/request-signing/v1) is deprecated in AdCP 3.3 and remains supported ' +
    "through 3.x. Opt into the experimental Web Bot Auth profile with request_signing.profile: 'web-bot-auth' " +
    'once the seller advertises it. See docs/migration-agent-identity-3.3.md.',
  verification:
    'RFC 9421-profile request verification (adcp/request-signing/v1) is deprecated in AdCP 3.3 and remains ' +
    'supported through 3.x. Opt into the experimental Web Bot Auth profile with the webBotAuth option. ' +
    'See docs/migration-agent-identity-3.3.md.',
};

export function warnRfc9421ProfileDeprecated(surface: Rfc9421DeprecationSurface): void {
  if (warned.has(surface)) return;
  warned.add(surface);
  if (process.env.ADCP_SUPPRESS_RFC9421_DEPRECATION === '1') return;
  try {
    process.emitWarning(MESSAGES[surface], {
      type: 'DeprecationWarning',
      code: surface === 'signing' ? 'ADCP_RFC9421_SIGNING_PROFILE' : 'ADCP_RFC9421_VERIFICATION_PROFILE',
    });
  } catch {
    // Observability only; never fatal.
  }
}

/** @internal Test hook. */
export function _resetRfc9421DeprecationWarnings(): void {
  warned.clear();
}
