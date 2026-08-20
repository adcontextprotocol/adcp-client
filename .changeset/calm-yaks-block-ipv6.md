---
'@adcp/sdk': patch
---

Harden SSRF address classification by refusing additional non-routable and special-purpose IPv6 ranges. Globally reachable IETF protocol assignments remain allowed, while unsafe translation and tunnel prefixes that cannot exclude metadata targets remain blocked even with private-network opt-in.
