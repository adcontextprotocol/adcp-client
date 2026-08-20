/**
 * IP address classification for SSRF defense.
 *
 * Two tiers of blocking:
 *   - {@link isAlwaysBlocked}: link-local, cloud metadata endpoints (IMDS),
 *     and opaque translation/tunnel prefixes that cannot safely exclude IMDS.
 *     Refused even when the caller opts into private networks (dev loops).
 *   - {@link isPrivateIp}: RFC 1918, loopback, CGNAT, IPv6 ULA/link-local,
 *     multicast, broadcast, unspecified, non-routable special-purpose ranges,
 *     plus defense-in-depth on IPv6 wrappers (NAT64, IPv4-translated, 6to4)
 *     so a v4-in-v6 address can't sneak a private target past the classifier.
 *     Refused by default; allowed when the caller passes `allowPrivateIp: true`
 *     (storyboard runner's `--allow-http`).
 *
 * Classifiers normalize before matching:
 *   - Zone IDs (`%eth0`) are stripped — they're a host-local concept, not part
 *     of the address, and Node's IP parsers don't accept them.
 *   - Surrounding URL brackets (`[::1]`) are stripped — `URL.hostname` returns
 *     bracketed form for IPv6 literals; classifiers need bare input.
 *   - IPv4-mapped IPv6 is resolved natively by `BlockList` — `::ffff:10.0.0.1`
 *     matches the `10.0.0.0/8` subnet regardless of textual form
 *     (`0:0:0:0:0:ffff:a.b.c.d` works too).
 */
import { BlockList, isIP } from 'net';

type NormalizedAddress = { addr: string; family: 'ipv4' | 'ipv6' };

function normalize(address: string): NormalizedAddress | null {
  // Strip surrounding brackets (URL-hostname form) and zone ID.
  let bare = address;
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1);
  const pctIdx = bare.indexOf('%');
  if (pctIdx >= 0) bare = bare.slice(0, pctIdx);
  const family = isIP(bare);
  if (family === 4) return { addr: bare, family: 'ipv4' };
  if (family === 6) return { addr: bare, family: 'ipv6' };
  return null;
}

// Addresses blocked even when the dev opt-in `allowPrivateIp` is set. Cloud
// metadata services live at 169.254.169.254 and leak credentials if reached;
// IPv6 link-local (`fe80::/10`) is the v6 equivalent reach into the host's
// local segment.
const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
// Oracle Cloud IMDS lives at 192.0.0.192 (inside RFC 6890's 192.0.0.0/24
// IETF-protocol assignments) rather than the 169.254.0.0/16 everyone else
// uses, so it needs its own entry to be refused even under the private opt-in.
alwaysBlocked.addAddress('192.0.0.192', 'ipv4');
// AWS exposes IMDS over this ULA address on Nitro instances. It is a direct
// credential endpoint, so private-network opt-in must never make it reachable.
alwaysBlocked.addAddress('fd00:ec2::254', 'ipv6');
// Deterministic IPv4-in-IPv6 wrappers: block only encodings of the IPv4
// always-blocked ranges so `allowPrivateIp` can still reach explicitly trusted
// public translation targets. `a9fe` is 169.254 and `c000:c0` is 192.0.0.192.
alwaysBlocked.addSubnet('::a9fe:0', 112, 'ipv6'); // IPv4-compatible IMDS/link-local
alwaysBlocked.addAddress('::c000:c0', 'ipv6'); // IPv4-compatible Oracle IMDS
alwaysBlocked.addSubnet('::ffff:0:a9fe:0', 112, 'ipv6'); // IPv4-translated IMDS/link-local
alwaysBlocked.addAddress('::ffff:0:c000:c0', 'ipv6'); // IPv4-translated Oracle IMDS
alwaysBlocked.addSubnet('64:ff9b::a9fe:0', 112, 'ipv6'); // NAT64 WKP IMDS/link-local
alwaysBlocked.addAddress('64:ff9b::c000:c0', 'ipv6'); // NAT64 WKP Oracle IMDS
alwaysBlocked.addSubnet('2002:a9fe::', 32, 'ipv6'); // 6to4 IMDS/link-local
alwaysBlocked.addSubnet('2002:c000:c0::', 48, 'ipv6'); // 6to4 Oracle IMDS
// RFC 8215 deliberately defines no fixed embedded-IPv4 layout, so the local
// translation prefix cannot be inspected safely for an IMDS destination.
alwaysBlocked.addSubnet('64:ff9b:1::', 48, 'ipv6');
// Teredo also carries obfuscated endpoint information whose ultimate reach is
// relay-dependent. Refuse it even under the private-network opt-in.
alwaysBlocked.addSubnet('2001::', 32, 'ipv6');

// IANA marks 2001::/23 non-global unless a more-specific allocation says
// otherwise. Keep the parent fail-closed and enumerate every currently
// globally reachable child so new gaps do not silently become SSRF targets.
const ietfProtocolAssignments = new BlockList();
ietfProtocolAssignments.addSubnet('2001::', 23, 'ipv6');
const globallyReachableIetfAssignments = new BlockList();
globallyReachableIetfAssignments.addAddress('2001:1::1', 'ipv6'); // PCP anycast
globallyReachableIetfAssignments.addAddress('2001:1::2', 'ipv6'); // TURN anycast
globallyReachableIetfAssignments.addAddress('2001:1::3', 'ipv6'); // DNS-SD anycast
globallyReachableIetfAssignments.addSubnet('2001:3::', 32, 'ipv6'); // AMT
globallyReachableIetfAssignments.addSubnet('2001:4:112::', 48, 'ipv6'); // AS112-v6
globallyReachableIetfAssignments.addSubnet('2001:20::', 28, 'ipv6'); // ORCHIDv2
globallyReachableIetfAssignments.addSubnet('2001:30::', 28, 'ipv6'); // DETs

// Private, loopback, multicast, and reserved ranges. Defense-in-depth adds the
// NAT64 well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`) so a
// wrapped-v4 address can't bypass the classifier by choosing a representation
// BlockList doesn't natively canonicalize.
const privateIp = new BlockList();
const nativeIpv4Loopback = new BlockList();
nativeIpv4Loopback.addSubnet('127.0.0.0', 8, 'ipv4');
const nativeIpv6Loopback = new BlockList();
nativeIpv6Loopback.addAddress('::1', 'ipv6');
// v4 — BlockList handles IPv4-mapped IPv6 (`::ffff:a.b.c.d`) against these
// subnets automatically per Node's check semantics.
privateIp.addSubnet('0.0.0.0', 8, 'ipv4');
privateIp.addSubnet('10.0.0.0', 8, 'ipv4');
privateIp.addSubnet('127.0.0.0', 8, 'ipv4');
privateIp.addSubnet('100.64.0.0', 10, 'ipv4'); // RFC 6598 CGNAT
privateIp.addSubnet('169.254.0.0', 16, 'ipv4');
privateIp.addSubnet('172.16.0.0', 12, 'ipv4');
privateIp.addSubnet('192.168.0.0', 16, 'ipv4');
privateIp.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
privateIp.addSubnet('192.0.0.0', 24, 'ipv4'); // RFC 6890 IETF protocol assignments (incl. Oracle IMDS)
privateIp.addSubnet('192.88.99.0', 24, 'ipv4'); // 6to4 relay anycast (RFC 7526, deprecated)
privateIp.addSubnet('192.0.2.0', 24, 'ipv4'); // documentation (TEST-NET-1)
privateIp.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
privateIp.addSubnet('198.51.100.0', 24, 'ipv4'); // documentation (TEST-NET-2)
privateIp.addSubnet('203.0.113.0', 24, 'ipv4'); // documentation (TEST-NET-3)
privateIp.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved for future use
privateIp.addAddress('255.255.255.255', 'ipv4'); // limited broadcast
// v6
privateIp.addAddress('::', 'ipv6'); // unspecified
privateIp.addAddress('::1', 'ipv6'); // loopback
privateIp.addSubnet('::', 96, 'ipv6'); // deprecated IPv4-compatible addresses (RFC 4291)
privateIp.addSubnet('fe80::', 10, 'ipv6'); // link-local
privateIp.addSubnet('fec0::', 10, 'ipv6'); // deprecated site-local addresses (RFC 3879)
privateIp.addSubnet('fc00::', 7, 'ipv6'); // ULA
privateIp.addSubnet('ff00::', 8, 'ipv6'); // multicast
privateIp.addSubnet('100::', 64, 'ipv6'); // discard-only (RFC 6666)
privateIp.addSubnet('100:0:0:1::', 64, 'ipv6'); // dummy prefix (RFC 9780)
privateIp.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
privateIp.addSubnet('3ffe::', 16, 'ipv6'); // returned 6bone space (RFC 5156)
privateIp.addSubnet('3fff::', 20, 'ipv6'); // documentation (RFC 9637)
// The former 6bone /8 remains unallocated except for 5f00::/16, which was
// reassigned to non-global SRv6 SIDs. Neither portion is publicly reachable.
privateIp.addSubnet('5f00::', 8, 'ipv6'); // RFC 5156 and RFC 9602
// Wrapper prefixes — refuse the entire prefix by default. Tunnels at the
// caller's edge can translate these into private targets we can't see; safer
// to refuse than to hope the gateway is configured the way we expect.
privateIp.addSubnet('::ffff:0:0:0', 96, 'ipv6'); // deprecated IPv4-translated (RFC 2765)
privateIp.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 well-known
privateIp.addSubnet('64:ff9b:1::', 48, 'ipv6'); // local-use IPv4/IPv6 translation (RFC 8215)
privateIp.addSubnet('2002::', 16, 'ipv6'); // 6to4

/**
 * Addresses blocked even when `allowPrivateIp` is on. Cloud metadata services
 * (AWS/GCP/Azure IMDS) live at 169.254.169.254 and would exfiltrate
 * credentials if a CI runner or long-lived server followed an attacker URL to
 * them. IPv6 link-local (`fe80::/10`) is the v6 equivalent reach into the
 * host's local segment. Deterministic IPv4 wrappers block their encoded IMDS
 * ranges; opaque local-translation and Teredo prefixes fail closed because
 * their ultimate destination cannot be classified safely here.
 *
 * Returns `false` for non-IP inputs (hostnames).
 */
export function isAlwaysBlocked(address: string): boolean {
  const n = normalize(address);
  if (!n) return false;
  return isAlwaysBlockedNormalized(n);
}

function isAlwaysBlockedNormalized(n: NormalizedAddress): boolean {
  return alwaysBlocked.check(n.addr, n.family);
}

function isNonGlobalIetfAssignment(n: NormalizedAddress): boolean {
  return (
    n.family === 'ipv6' &&
    ietfProtocolAssignments.check(n.addr, 'ipv6') &&
    !globallyReachableIetfAssignments.check(n.addr, 'ipv6')
  );
}

/**
 * Reject loopback, link-local, RFC 1918 private ranges, CGNAT (RFC 6598),
 * broadcast, multicast, the unspecified address, non-routable special-purpose
 * ranges, NAT64/6to4 wrapper prefixes, and IPv6 equivalents. BlockList handles
 * IPv4-mapped IPv6 canonicalization natively so `::ffff:10.0.0.1` is matched
 * against the v4 rule set.
 *
 * Returns `false` for non-IP inputs (hostnames).
 */
export function isPrivateIp(address: string): boolean {
  const n = normalize(address);
  if (!n) return false;
  return isAlwaysBlockedNormalized(n) || isNonGlobalIetfAssignment(n) || privateIp.check(n.addr, n.family);
}

/** Return true only for native IPv4/IPv6 loopback, not wrapped forms. */
export function isLoopbackIp(address: string): boolean {
  const n = normalize(address);
  if (!n) return false;
  // Keep the families in separate lists. A mixed BlockList canonicalizes an
  // IPv4-mapped IPv6 value against its IPv4 entries, but the loopback policy
  // intentionally permits only native representations.
  return n.family === 'ipv4' ? nativeIpv4Loopback.check(n.addr, 'ipv4') : nativeIpv6Loopback.check(n.addr, 'ipv6');
}

/**
 * Best-effort check that a URL targets a development/private host, without
 * doing a DNS lookup. Matches loopback hostnames (`localhost`), Kubernetes
 * service DNS names (`.cluster.local` suffix), and any IP literal that
 * {@link isPrivateIp} would reject. Public domain names always return `false`.
 *
 * Used by higher layers that need to inherit the operator's "private is OK"
 * trust from a primary probe and propagate it to same-origin chain hops —
 * callers that pass this flag into `ssrfSafeFetch` should do so only when
 * they've already decided the target origin is trusted.
 *
 * Returns `false` on unparseable inputs.
 */
export function isLikelyPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Strip optional trailing DNS dot from FQDN form (e.g. "foo.svc.cluster.local.")
    const host = u.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (host === 'localhost') return true;
    // Kubernetes service DNS names end in .cluster.local and always resolve to
    // private ClusterIP addresses. Matching by suffix avoids a DNS round-trip.
    if (host.endsWith('.cluster.local')) return true;
    return isPrivateIp(host);
  } catch {
    return false;
  }
}
