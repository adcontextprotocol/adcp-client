/**
 * Probe policy for buyer-side discovery (adcp-client#1618).
 *
 * Whether the SDK is willing to issue an outbound probe to a given URL
 * during agent discovery (`detectProtocol` well-known card fetches,
 * `createTestClient` agent URL acceptance). Sits one layer above the
 * `src/lib/net/address-guards.ts` IP classifiers and the `ssrfSafeFetch`
 * primitive — those operate on already-resolved addresses; this layer
 * applies a higher-level allow/deny decision keyed on the URL hostname
 * before anything reaches DNS.
 *
 * ## Default policy
 *
 * | Range                                       | Default | Why                                                     |
 * | ------------------------------------------- | ------- | ------------------------------------------------------- |
 * | Loopback (`127.0.0.0/8`, `::1`, `localhost`)| allow   | Local dev loops, mock-server tests, `npm run dev`       |
 * | RFC 1918 / link-local / IPv6 ULA            | deny    | Internal subnets behind a server-side comply runner     |
 * | Cloud metadata (`169.254.169.254`, `fe80::/10`) | deny | IMDS exfiltration is never a legitimate buyer use case  |
 * | Public IPv4/IPv6                            | allow   | The whole point                                         |
 *
 * ## Single opt-out
 *
 * `ADCP_ALLOW_INTERNAL_PROBES=1` (read once at module load) widens the
 * default to allow RFC-1918/link-local/ULA. IMDS stays blocked even with
 * this flag — cloud metadata reach is never legitimate.
 *
 * NOT controlled by `NODE_ENV`: a multi-tenant staging image with
 * `NODE_ENV=test` MUST NOT inherit looser SSRF posture than production.
 *
 * ## Known gap (TOCTOU)
 *
 * `classifyProbeUrl` does NOT do DNS resolution — it inspects the
 * URL's hostname literal. A hostname like `evil.example.com` that
 * resolves to `169.254.169.254` will pass this gate; the per-IP block
 * inside `ssrfSafeFetch` (which DOES resolve and pin) catches it.
 * Use both: this gate refuses obvious literal attacks; `ssrfSafeFetch`
 * refuses DNS-based attacks. Tracked separately for the rebind defense
 * deferral discussed in the issue.
 */

import { BlockList, isIP } from 'node:net';
import { isAlwaysBlocked, isPrivateIp } from '../net/address-guards';

// Loopback canonicalization. Node's URL parser canonicalizes IPv4-mapped
// IPv6 (`::ffff:127.0.0.1`) into binary form (`::ffff:7f00:1`), which
// would slip past a textual regex. `BlockList` handles all canonical forms
// natively, including IPv4-mapped IPv6 against the v4 subnet.
const loopbackBlock = new BlockList();
loopbackBlock.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackBlock.addAddress('::1', 'ipv6');

/**
 * Operator opt-in to allow RFC-1918 / link-local / ULA destinations.
 * Read once at module load — runtime mutation does not propagate. Operators
 * who flip this in CI should set it via the workflow `env:` block.
 *
 * IMDS stays refused regardless.
 */
const ALLOW_INTERNAL = process.env.ADCP_ALLOW_INTERNAL_PROBES === '1';

/**
 * Match a host literal that resolves trivially to loopback. Allowed even
 * in strict mode because local dev loops are not an SSRF target — the
 * attacker would have to be on the buyer's own machine to reach them, at
 * which point they have strictly more powerful primitives.
 *
 * `localhost` is hardcoded rather than DNS-resolved so an attacker can't
 * point `localhost.attacker.example.com` at `169.254.169.254` and slip
 * past as "loopback-named". Hostname must be exactly `localhost` (case
 * insensitive). IP literals must be in 127/8 or `::1`.
 */
function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  // Strip URL-style brackets in case the caller didn't (defensive — internal
  // callers strip first).
  let bare = host;
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  const family = isIP(bare);
  if (family === 4) return loopbackBlock.check(bare, 'ipv4');
  if (family === 6) return loopbackBlock.check(bare, 'ipv6');
  return false;
}

export type ProbePolicyResult =
  | { allowed: true }
  | { allowed: false; code: 'invalid_url' | 'always_blocked' | 'private_address'; reason: string };

/**
 * Decide whether the SDK should issue a discovery probe to `url`. Returns
 * `{ allowed: true }` when the probe may proceed, otherwise a refusal
 * with a human-readable reason and a typed code for callers that want
 * to map the refusal into their own error envelope.
 *
 * Designed to be cheap and synchronous — call this BEFORE any try/catch
 * in the discovery loop so refusal can't be silently swallowed and
 * converted into "host doesn't speak A2A, fall back to MCP" (the
 * code-reviewer-flagged catch-swallow class from #1618 triage).
 *
 * **Error messages do NOT echo resolved IP addresses** — the `address`
 * field on the rejection carries them when present, but the user-visible
 * text names only the hostname so that compliance reports and log
 * aggregators don't leak internal network topology.
 */
export function classifyProbeUrl(url: string): ProbePolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Don't refuse here — let the underlying call surface its own error
    // (it'll fail with a clearer "Invalid URL" downstream). This function
    // is not the URL validator, only the SSRF policy.
    return { allowed: true };
  }

  // `URL.hostname` returns IPv6 literals wrapped in brackets; the address
  // classifiers want the bare form.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // IMDS / IPv6 link-local: ALWAYS refused. Cloud metadata reach is never
  // a legitimate buyer-side use case — refuse even when the operator has
  // explicitly opted into private probes.
  if (isAlwaysBlocked(host)) {
    return {
      allowed: false,
      code: 'always_blocked',
      reason: `Refusing to probe '${host}': cloud-metadata or link-local address.`,
    };
  }

  // Loopback: ALWAYS allowed. CLI dev loops, mock-server tests, local
  // adapter integration tests all hit this path. Even in strict mode the
  // attacker would need to be on-host already to exploit it.
  if (isLoopbackHost(host)) {
    return { allowed: true };
  }

  // Private/RFC-1918/ULA: refused unless the operator opted in via env.
  // The opt-in is read once at module load — see ALLOW_INTERNAL above.
  if (isPrivateIp(host)) {
    if (ALLOW_INTERNAL) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: 'private_address',
      reason:
        `Refusing to probe '${host}': private/RFC-1918 address. ` +
        `Set ADCP_ALLOW_INTERNAL_PROBES=1 to allow private-network probes (operator-only).`,
    };
  }

  return { allowed: true };
}

/** Test-only accessor for the env flag — exported for unit-test reset semantics. */
export function isInternalProbesAllowed(): boolean {
  return ALLOW_INTERNAL;
}
