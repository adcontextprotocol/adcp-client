---
'@adcp/sdk': minor
---

Origin-only `authorized_agents[].url` entries authorize the agent at that origin under AdCP 3.3 (adcp-client#3695, the SDK side of adcontextprotocol/adcp#8943). adcontextprotocol/adcp#8939 documents the rule under DR-0023: an entry whose canonical form has the root path and no query, such as `https://agent.example.com`, matches any agent URL with the same canonical origin, including `https://agent.example.com/mcp`. An entry with a path still matches only that canonical URL, so a trailing slash, path case and the query stay significant for it.

- **`resolveAgentProperties(adAgents, agentUrl, { adcpVersion })`** applies the rule when `adcpVersion` is 3.3 or later (any 3.3 prerelease included). It defaults to the SDK's pinned `ADCP_VERSION`, which targets 3.3. Pass the negotiated release, for example `'3.2'`, to keep exact canonical-URL matching. An unparseable version also keeps exact matching. When an entry names the agent's exact URL it wins over an origin-only entry, so no agent loses the scope it had under 3.2. Two origin-only entries for the same origin, with no exact entry, fail closed as `ambiguous_agent_url`.
- **New `agentUrlMatchesAuthorizedEntry(entryUrl, agentUrl, { adcpVersion })`** answers whether one entry matches an agent, with the same rule. **New `usesOriginOnlyAgentMatching(adcpVersion?)`** reports whether a release applies it. Both are exported from `@adcp/sdk` and `@adcp/sdk/discovery`.
- **`PropertyCrawler`** matches each agent under the release the agent served for `get_adcp_capabilities`, falling back to the new `adcpVersion` crawler option (default the SDK pin). The option is also passed to each agent's client.
- **Supply-path verification is unchanged.** Semantics version 1 keeps exact canonical-URL matching, origin-only entries included, until a new semantics version adopts the rule.
- `validateAdAgents` only locates and loads the file, so it has no matching to change. Its docs now point at `resolveAgentProperties` for the authorization check.
