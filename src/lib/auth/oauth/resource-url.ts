import { OAuthError } from './types';

const MAX_RESOURCE_URL_LENGTH = 2048;

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
