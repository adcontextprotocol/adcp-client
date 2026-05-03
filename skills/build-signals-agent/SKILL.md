---
name: build-signals-agent
description: Use when building an AdCP signals agent — a marketplace data provider, identity provider, CDP, or any system that serves audience or contextual signals to buyers.
---

# Build a Signals Agent

A signals agent serves audience and contextual targeting segments to buyer agents. The fastest path to a passing agent is to **fork the worked adapter** and replace its `// SWAP:` markers with calls to your backend.

## Pick your fork target

| Specialism | Archetype | Fork this | Mock upstream | Storyboard |
| --- | --- | --- | --- | --- |
| `signal-marketplace` | Multi-provider data marketplace (Oracle Data Cloud, LiveRamp, third-party data) | [`hello_signals_adapter_marketplace.ts`](../../examples/hello_signals_adapter_marketplace.ts) | `npx adcp mock-server signal-marketplace` | `signal_marketplace` |
| `signal-owned` | First-party / single-provider data (CDP, identity provider, contextual) | Fork the marketplace adapter; collapse the multi-provider seed | — | `signal_owned` |

Both specialisms share the same tool surface (`get_signals`, `activate_signal`, `list_accounts`); the difference is whether you serve segments from multiple `data_provider_domain` values or one. A `signal-owned` adapter is the marketplace adapter with the multi-provider directory simplified to a single seed.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference. The fork target stays in sync with the spec because PR #1394's three-gate contract fails CI when it drifts.

## When to use this skill

- User wants to serve audience segments, identity data, or contextual targeting to buyers
- User mentions `get_signals`, `activate_signal`, or the AdCP signals protocol
- User describes themselves as a CDP, DMP, identity provider, or data marketplace

**Not this skill:**

- Selling ad inventory → `skills/build-seller-agent/`
- Audience push (sync to a walled garden) → that's the `audience-sync` track in `skills/build-seller-agent/`

## Cross-cutting rules

Every signals agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). Two signals-specific notes on top of those:

### Async platform activation

Platform activations (`type: 'platform'`) take minutes-to-hours to propagate to the DSP. Return `is_live: false` with `estimated_activation_duration_minutes` on first call; the buyer polls `activate_signal` again until `is_live: true`. **Commit `activation_key` up front** so the buyer can trust it across the poll window. Agent activations (`type: 'agent'`) are instant — return `is_live: true` immediately.

`forceDeploymentStatus` in your `TestControllerStore` flips pending deployments to live for deterministic compliance tests.

### Provenance — `data_provider_domain` must resolve

Buyers fetch `https://{domain}/adagents.json` out-of-band to verify the provider. Use real domains even in demos, not `example.com`. For marketplace adopters, seed ≥2 different `data_provider_domain` values so the multi-provider nature is visible to the storyboard.

## Specialism deltas at a glance

**`signal-marketplace`** — multi-provider directory (`signals[].data_provider_domain` varies), platform-activation polling pattern, marketplace governance sub-scenario in the storyboard exercises consent flows.

**`signal-owned`** — single `data_provider_domain` across all signals. `value_type` drives targeting semantics: `binary` (in/out), `categorical` (with `allowed_values: [...]`), `numeric` (with `min`, `max`, optional `units`). `signal_type: 'custom'` is for first-party signals outside the `owned` user-identity model (e.g. contextual signals from page content) — use `owned` by default.

## Validate locally

```bash
# Run the fork-matrix gate
npm run compliance:fork-matrix -- --test-name-pattern="hello-signals-adapter-marketplace"

# Or validate your forked agent directly against its storyboard
adcp storyboard run http://127.0.0.1:3001/mcp signal_marketplace \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md)
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
