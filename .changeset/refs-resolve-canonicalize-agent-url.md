---
'@adcp/client': patch
---

`refs_resolve` scope: canonicalize `$agent_url` by stripping transport
suffixes instead of comparing raw target URL to bare agent origins.

Before this fix, storyboards using `scope: { key: 'agent_url', equals:
'$agent_url' }` silently graded every source ref `out_of_scope` on MCP
and A2A runners, because `$agent_url` expanded to the runner's target
URL (with `/mcp`, `/a2a`, or `/.well-known/agent.json` suffixes) while
refs carried the bare agent URL per AdCP convention. Net effect: the
check degraded from integrity enforcement to a no-op on every MCP agent.

The scope comparator now mirrors `SingleAgentClient.computeBaseUrl`:
strip `/mcp`, `/a2a`, `/sse`, and `/.well-known/agent[-card].json`
suffixes; lowercase scheme and host; drop default ports; strip
userinfo, query, and fragment. Path below the transport suffix is
preserved, so sibling agents at different subpaths on a shared host
(e.g. `https://publisher.com/.well-known/adcp/sales` vs
`/.well-known/adcp/creative`) remain distinguishable. Closes #710.
