---
'@adcp/sdk': patch
---

Backport the patched MCP client and server 2.3.1 and Node adapter 2.1.1 used on the current SDK line. This clears the maintenance release's high-severity transport security audit findings without changing the SDK public API or legacy MCP peer range. Refresh in-range lockfile dependencies required by the security audit.
