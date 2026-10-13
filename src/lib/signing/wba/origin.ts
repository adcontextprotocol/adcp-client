import { canonicalAgentOrigin } from '../agent-resolver/canonicalize';
import { canonicalAgentUrl } from '../agent-resolver/select-agent';

export class WebBotAuthOriginError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'WebBotAuthOriginError';
  }
}

/**
 * Canonical HTTPS origin of a Web Bot Auth identity (spec R0 and R1): scheme
 * and authority after URL canonicalization steps 1–4, without path, query, or
 * fragment. Rejects non-HTTPS URLs, userinfo, whitespace and controls.
 *
 * `wire: true` applies the received-value rules on top: a raw non-ASCII or
 * percent-encoded hostname is rejected rather than normalized, so a
 * `Signature-Agent` value cannot reach a directory lookup through an escaped
 * spelling. Producers (signer configuration) may pass IDN U-labels.
 */
export function webBotAuthOrigin(url: string, options: { wire?: boolean } = {}): string {
  if (typeof url !== 'string' || url.length === 0 || /[\u0000- \u007f]/.test(url)) {
    throw new WebBotAuthOriginError('Web Bot Auth origin contains whitespace or controls');
  }
  const authority = /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i.exec(url)?.[1];
  if (authority === undefined || authority.includes('@')) {
    throw new WebBotAuthOriginError('Web Bot Auth origins require an absolute URL without userinfo');
  }
  let origin: string;
  try {
    origin = canonicalAgentOrigin(url);
    if (options.wire === true) {
      if (authority.includes('%')) throw new TypeError('percent-encoded host');
      canonicalAgentUrl(url);
    }
  } catch {
    throw new WebBotAuthOriginError('Invalid Web Bot Auth origin');
  }
  if (!origin.startsWith('https://')) {
    throw new WebBotAuthOriginError('Web Bot Auth origins require HTTPS');
  }
  return origin;
}

/** Non-throwing variant for comparisons. */
export function tryWebBotAuthOrigin(url: string, options: { wire?: boolean } = {}): string | undefined {
  try {
    return webBotAuthOrigin(url, options);
  } catch {
    return undefined;
  }
}
