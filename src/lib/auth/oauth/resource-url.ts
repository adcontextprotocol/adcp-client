import { OAuthError } from './types';

const MAX_RESOURCE_URL_LENGTH = 2048;

/**
 * RFC 9728 resource comparison semantics used by OAuth discovery and
 * compliance grading. Scheme and host are case-insensitive and default ports
 * are equivalent; the remainder stays byte-for-byte significant.
 */
export function normalizeOAuthResourceForComparison(value: string): string {
  const match = /^([A-Za-z][A-Za-z\d+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(value);
  if (!match) return value;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const remainder = match[3]!;
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : '';
  const hostAndPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port = '';
  if (hostAndPort.startsWith('[')) {
    const bracket = hostAndPort.indexOf(']');
    if (bracket < 0) return value;
    host = hostAndPort.slice(0, bracket + 1).toLowerCase();
    const suffix = hostAndPort.slice(bracket + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return value;
    port = suffix.slice(1);
  } else {
    const colon = hostAndPort.lastIndexOf(':');
    if (colon >= 0) {
      const suffix = hostAndPort.slice(colon + 1);
      if (!/^\d+$/.test(suffix)) return value;
      host = hostAndPort.slice(0, colon).toLowerCase();
      port = suffix;
    } else {
      host = hostAndPort.toLowerCase();
    }
  }
  if (!host) return value;
  const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : undefined;
  const renderedPort = port && port !== defaultPort ? `:${port}` : '';
  return `${scheme}://${userinfo}${host}${renderedPort}${remainder}`;
}

/** Build the RFC 9728 well-known metadata URL for a protected resource. */
export function buildProtectedResourceMetadataUrl(agentUrl: string): string {
  const url = new URL(agentUrl);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

/** Validate and canonicalize an operator-configured RFC 8707 resource URI. */
export function validateOAuthResourceUrl(value: string, options: { allowHttp?: boolean } = {}): URL {
  if (value.length === 0 || value.length > MAX_RESOURCE_URL_LENGTH) {
    throw new OAuthError('OAuth resource override must be between 1 and 2048 characters', 'invalid_resource_override');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('OAuth resource override must be an absolute URL', 'invalid_resource_override');
  }

  if (url.username || url.password) {
    throw new OAuthError('OAuth resource override must not contain URL userinfo', 'invalid_resource_override');
  }
  if (url.hash) {
    throw new OAuthError('OAuth resource override must not contain a fragment', 'invalid_resource_override');
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new OAuthError('OAuth resource override must use HTTPS', 'invalid_resource_override');
  }

  return url;
}
