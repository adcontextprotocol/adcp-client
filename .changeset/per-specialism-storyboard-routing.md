---
'@adcp/sdk': minor
---

feat(testing): per-specialism storyboard routing — `runStoryboard({ agents })` (#1066)

Storyboards that span specialisms (e.g. `sync_governance` then `activate_signal` in a `signal_marketplace/governance_denied` flow) can now route each step to the tenant that actually owns that tool, instead of fanning every step at one URL and relying on cross-tenant comply seeds. Maps directly to the prod test-agent topology (`/sales`, `/signals`, `/governance`, `/creative`, `/creative-builder`, `/brand`) and to local Hello-cluster setups.

**API**:

```ts
runStoryboard('', storyboard, {
  auth: { type: 'bearer', token: '...' },
  agents: {
    sales:      { url: 'https://test-agent.adcontextprotocol.org/sales/mcp' },
    signals:    { url: 'https://test-agent.adcontextprotocol.org/signals/mcp' },
    governance: { url: 'https://test-agent.adcontextprotocol.org/governance/mcp' },
  },
  default_agent: 'sales',
});
```

Per-step `agent: <key>` override for cross-domain tools (`sync_creatives`, `list_creative_formats`) when the same protocol is claimed by multiple tenants. Per-agent auth and transport overrides supported via `AgentEntry.auth` / `AgentEntry.transport`.

**Routing**: tool → `TASK_FEATURE_MAP` → first protocol → unique agent in the map that claims it via `get_adcp_capabilities`. Multi-claim conflicts fail-fast at storyboard-build time **for affected steps lacking a `step.agent` override** — the override is the per-step disambiguator and resolves the conflict cleanly. Tools with no specialism mapping fall back to `default_agent`, or fail-fast as `unroutable_task` when no default is set.

**Discovery**: parallel per-agent `get_adcp_capabilities` at storyboard start. Any tenant's discovery failure surfaces as a hard storyboard failure, not a per-step skip — a broken tenant in a multi-tenant flow is a topology bug, not a coverage gap.

**CLI**: `adcp storyboard run --agents-map ./agents.yaml <storyboard_id>`. Repeatable `--agent <key>=<url>` for inline maps. `--default-agent <key>` for fallback. URL validation matches existing `--url` (HTTPS in prod, HTTP only with `--allow-http`).

**Result shape**: new `StoryboardResult.agent_map?: Record<string, string>` echoes the resolved `key → url` so JUnit/CI consumers and bug reports show which agent served which tool. Per-step `agent_url` and `agent_index` are populated in routed mode (previously only in multi-instance replica mode).

**Mutually exclusive** with `multi_instance_strategy` (replica round-robin, different concept), `_client` (single client cannot serve multiple agents), and a positional URL alongside the map (ambiguous routing intent). All three combinations throw at `runStoryboard()` entry.

Closes #1066. Hello-cluster adapters for governance/creative/brand and a one-command cluster orchestrator are tracked separately as #1332/#1333/#1334/#1335.
