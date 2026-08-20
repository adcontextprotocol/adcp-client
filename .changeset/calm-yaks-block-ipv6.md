---
'@adcp/sdk': patch
---

Harden SSRF address classification by refusing additional non-routable and special-purpose IPv6 ranges. Globally reachable IETF protocol assignments remain allowed, while IPv6 metadata endpoints and unsafe translation or tunnel prefixes that cannot exclude metadata targets remain blocked even with private-network opt-in.
