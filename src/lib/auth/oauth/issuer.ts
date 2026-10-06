import type { AgentConfig } from './types';
import { OAuthError } from './types';

/** Preserve one trailing-slash tolerance; compare identifiers strictly, never just origins. */
export function oauthIssuersMatch(a: string, b: string): boolean {
  return a === b || (a.endsWith('/') && a.slice(0, -1) === b) || (b.endsWith('/') && b.slice(0, -1) === a);
}

function assertIssuerIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) throw issuerBindingError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw issuerBindingError();
  }
  const rawAuthority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    rawAuthority?.includes('@') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw issuerBindingError();
  }
}

/** Discovery validates identity; it never supplies trust for an older grant. */
export function validatedOAuthIssuer(selectedIssuer: unknown, metadataIssuer: unknown): string {
  assertIssuerIdentifier(selectedIssuer);
  assertIssuerIdentifier(metadataIssuer);
  if (!oauthIssuersMatch(selectedIssuer, metadataIssuer)) throw issuerBindingError();
  return metadataIssuer;
}

export function issuerBindingError(): OAuthError {
  return new OAuthError(
    'OAuth issuer binding is missing or differs from the selected authorization server. ' +
      'Use an independently trusted issuer for preconfigured credentials, or have the owner clear credentials and sign in again. ' +
      'CLI: adcp <alias> --clear-oauth, then adcp --save-auth <alias> --oauth.',
    'oauth_issuer_binding_required'
  );
}

/** Check both records before upstream can discard one and start registration. */
export function assertOAuthCredentialIssuers(
  agent: Pick<AgentConfig, 'oauth_tokens' | 'oauth_client'>,
  issuer: string
): void {
  assertIssuerIdentifier(issuer);
  for (const credentials of [agent.oauth_tokens, agent.oauth_client]) {
    if (!credentials) continue;
    assertIssuerIdentifier(credentials.issuer);
    if (!oauthIssuersMatch(credentials.issuer, issuer)) throw issuerBindingError();
  }
}
