const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-adcp-auth', 'x-api-key']);

const CREDENTIAL_HEADER_RE =
  /(^|[-_])(auth(?:entication|orization)?|credentials?|secrets?|tokens?|keys?|api[-_]?keys?|access[-_]?keys?|private[-_]?keys?|password|passwd|signatures?|cert(?:ificate)?s?)([-_]|$)/i;

/** @internal Shared A2A credential-header classifier for origin isolation. */
export function isCredentialHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return CREDENTIAL_HEADER_NAMES.has(normalized) || CREDENTIAL_HEADER_RE.test(normalized);
}
