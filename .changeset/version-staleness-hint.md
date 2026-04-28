---
"@adcp/client": minor
---

feat(testing): version-staleness suffix on shape-drift hints when agent reports old SDK version

When a storyboard drift hint recommends a server-side helper (e.g. `buildCreativeResponse()`)
and the agent's `get_adcp_capabilities` response reports a `library_version` below the
minimum release that shipped that helper, the hint message is now suffixed with an upgrade
note: "Note: your agent reports @adcp/client@X.Y.Z — helperFn() ships in @adcp/client ≥N.N.N.
Upgrade your SDK dep."

The `createAdcpServer` capabilities handler now stamps `library_version: "@adcp/client@X.Y.Z"` in
the `get_adcp_capabilities` response so agents built on this SDK surface the version automatically.
Agents that don't emit `library_version` are unaffected — the suffix is silently omitted.
