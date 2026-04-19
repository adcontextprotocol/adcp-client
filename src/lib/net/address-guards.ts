/**
 * IP address classification for SSRF defense.
 *
 * Two tiers of blocking:
 *   - {@link isAlwaysBlocked}: link-local + cloud metadata endpoints (IMDS).
 *     Refused even when the caller opts into private networks (dev loops).
 *   - {@link isPrivateIp}: RFC 1918, loopback, CGNAT, IPv6 ULA/link-local,
 *     multicast, broadcast, unspecified, plus defense-in-depth on IPv6
 *     wrappers (NAT64 well-known prefix, 6to4) so a v4-in-v6 address can't
 *     sneak a private target past the classifier. Refused by default; allowed
 *     when the caller passes `allowPrivateIp: true` (storyboard runner's
 *     `--allow-http`).
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

function normalize(address: string): { addr: string; family: 'ipv4' | 'ipv6' } | null {
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

// Private, loopback, multicast, and reserved ranges. Defense-in-depth adds the
// NAT64 well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`) so a
// wrapped-v4 address can't bypass the classifier by choosing a representation
// BlockList doesn't natively canonicalize.
const privateIp = new BlockList();
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
privateIp.addAddress('255.255.255.255', 'ipv4'); // limited broadcast
// v6
privateIp.addAddress('::', 'ipv6'); // unspecified
privateIp.addAddress('::1', 'ipv6'); // loopback
privateIp.addSubnet('fe80::', 10, 'ipv6'); // link-local
privateIp.addSubnet('fc00::', 7, 'ipv6'); // ULA
privateIp.addSubnet('ff00::', 8, 'ipv6'); // multicast
// Wrapper prefixes — refuse unconditionally. Tunnels at the caller's edge can
// translate these into private targets we can't see; safer to refuse than to
// hope the gateway is configured the way we expect.
privateIp.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 well-known
privateIp.addSubnet('2002::', 16, 'ipv6'); // 6to4

/**
 * Addresses blocked even when `allowPrivateIp` is on. Cloud metadata services
 * (AWS/GCP/Azure IMDS) live at 169.254.169.254 and would exfiltrate
 * credentials if a CI runner or long-lived server followed an attacker URL to
 * them. IPv6 link-local (`fe80::/10`) is the v6 equivalent reach into the
 * host's local segment.
 *
 * Returns `false` for non-IP inputs (hostnames).
 */
export function isAlwaysBlocked(address: string): boolean {
  const n = normalize(address);
  if (!n) return false;
  return alwaysBlocked.check(n.addr, n.family);
}

/**
 * Reject loopback, link-local, RFC 1918 private ranges, CGNAT (RFC 6598),
 * broadcast, multicast, the unspecified address, NAT64/6to4 wrapper prefixes,
 * and IPv6 equivalents. BlockList handles IPv4-mapped IPv6 canonicalization
 * natively so `::ffff:10.0.0.1` is matched against the v4 rule set.
 *
 * Returns `false` for non-IP inputs (hostnames).
 */
export function isPrivateIp(address: string): boolean {
  const n = normalize(address);
  if (!n) return false;
  return privateIp.check(n.addr, n.family);
}
