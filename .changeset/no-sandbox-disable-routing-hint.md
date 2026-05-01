---
"@adcp/sdk": patch
---

feat(cli): `adcp storyboard run --no-sandbox` now signals adopters to bypass internal sandbox routing

Closes #841. The existing `--no-sandbox` flag set `account.sandbox: false` (a value), but agents that branch on env vars, brand-domain heuristics, or fixture substitutes still routed sandbox-shaped responses despite the production flag. Compliance passes against the sandbox path; buyer agents break against prod. (Surfaced empirically by `scope3data/agentic-adapters#100`.)

`--no-sandbox` now ALSO stamps `ext.adcp.disable_sandbox: true` on every outgoing request. Adopters that read this field bypass internal sandbox routing and exercise their real adapter path. Agents that don't recognize the field ignore it (`ext` is accepted-without-error per AdCP 3.0 spec).

Programmatic callers of `runStoryboard` can pass `disable_sandbox: true` in `StoryboardRunOptions` to get the same behavior without the flag. The pair (`sandbox: false` + `disable_sandbox: true`) is the strongest "production path only" signal the SDK can send.

The agent-side disclosure piece (surfacing "sandbox-masked: test did not exercise real handler" in reports when the agent's own heuristic still fires) is intentionally scoped out — a separate design discussion.
