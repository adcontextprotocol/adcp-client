/**
 * eTLD+1 computation against a pinned, dated PSL snapshot. Backed by
 * `tldts`, which ships its PSL bundled into the published package — pinning
 * the dependency in `package.json` pins the snapshot. Runtime PSL fetches are
 * never performed: a runtime fetch creates both a denial-of-service oracle
 * (PSL host outage stalls verification) and a non-deterministic eTLD+1
 * across deployments running on different snapshot ages
 * (security.mdx §"Quickstart: implement a `brand_json_url`-based verifier"
 * step 3).
 *
 * Both ICANN and PRIVATE PSL sections are in scope: platforms like
 * `vercel.app`, `pages.dev`, `github.io` MUST be treated as suffixes so an
 * attacker on `attacker.vercel.app` cannot pretend to share an eTLD+1 with
 * a legitimate publisher on `legit.vercel.app`.
 */
import { parse as parseTld } from 'tldts';

import { canonicalizeHost } from './canonicalize';

export const PSL_SNAPSHOT_VERSION = 'tldts@7';

export class EtldComputationError extends Error {
  constructor(
    message: string,
    readonly meta: { hostOrUrl?: string }
  ) {
    super(message);
    this.name = 'EtldComputationError';
  }
}

/**
 * Compute eTLD+1 for a hostname or URL. Caller should pass either a bare
 * hostname (`buyer.example.com`) or a full URL (`https://buyer.example.com/mcp`).
 *
 * Returns the registrable domain in canonical form (ASCII-lowercased, IDNA-2008
 * A-label). Throws when the input has no PSL match — typically because the host
 * is an IP literal or a single-label name.
 */
export function eTldPlusOne(hostOrUrl: string): string {
  const host = canonicalizeHost(extractHost(hostOrUrl));
  const result = parseTld(host, { allowPrivateDomains: true });
  if (result.isIp) {
    throw new EtldComputationError(`Cannot compute eTLD+1 for IP literal`, { hostOrUrl });
  }
  if (!result.domain) {
    throw new EtldComputationError(`No PSL match for hostname`, { hostOrUrl });
  }
  return canonicalizeHost(result.domain);
}

/**
 * Convenience: do two hostnames share an eTLD+1? Returns false when either
 * input has no PSL match (rather than throwing) — callers comparing two
 * hostnames typically want a non-match boolean, not an exception.
 */
export function sameEtldPlusOne(a: string, b: string): boolean {
  let aEtld: string;
  let bEtld: string;
  try {
    aEtld = eTldPlusOne(a);
    bEtld = eTldPlusOne(b);
  } catch {
    return false;
  }
  return aEtld === bEtld;
}

function extractHost(hostOrUrl: string): string {
  if (hostOrUrl.includes('://')) {
    return new URL(hostOrUrl).hostname;
  }
  return hostOrUrl;
}
