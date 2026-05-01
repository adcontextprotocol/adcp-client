# Validate Your Agent Locally in 10 Lines

If you're writing a server-side AdCP agent, the minimum loop you want is: **change code → run compliance → see failures**, with nothing else between you and the answer. No Express bootstrap. No webhook tunnel. No hand-seeded fixtures.

`runAgainstLocalAgent` from `@adcp/sdk/testing` composes `createAdcpServer` + `serve` + `seedComplianceFixtures` + the webhook receiver + the storyboard runner into one call. If you already know your handlers, ten lines is enough.

```ts
// tests/compliance.test.ts
import { runAgainstLocalAgent } from '@adcp/sdk/testing';
import { createAdcpServer, InMemoryStateStore } from '@adcp/sdk/server/legacy/v5';

const stateStore = new InMemoryStateStore();

const result = await runAgainstLocalAgent({
  createAgent: () =>
    createAdcpServer({
      name: 'My Publisher',
      version: '1.0.0',
      stateStore,
      mediaBuy: { getProducts, createMediaBuy, getMediaBuyDelivery },
    }),
  storyboards: {
    supported_protocols: ['media_buy'],
    specialisms: ['sales-non-guaranteed'],
  },
});

if (!result.overall_passed) process.exit(1);
```

That's it. The helper:

- Binds an ephemeral HTTP port and mounts your agent at `/mcp`
- Seeds `COMPLIANCE_FIXTURES` (`test-product`, `video_30s`, `test-pricing`, …) so storyboards referencing canonical ids pass
- Stands up a loopback webhook receiver so `expect_webhook*` steps grade instead of skipping
- Iterates the storyboards that apply to your declared capabilities
- Tears everything down when it's done

## The one rule: stateStore must be stable across requests

The helper calls your `createAgent` factory multiple times — once to seed fixtures, once per request `serve()` handles. Every call must see the **same** state. The pattern is to close over a module-level `stateStore`:

```ts
const stateStore = new InMemoryStateStore(); // outside the factory

const result = await runAgainstLocalAgent({
  createAgent: () => createAdcpServer({ ..., stateStore }), // inside the factory
});
```

If you create a fresh store inside the factory, seeds disappear between the seeding call and the first request, and every storyboard fails with `NOT_FOUND` on the canonical fixtures.

## CLI mode — same thing, one command

Prefer a one-shot from the shell? Point the CLI at a module file:

```bash
# agent.mjs exports `createAgent`
npx @adcp/sdk@latest storyboard run --local-agent ./agent.mjs

# Single storyboard, CI-friendly JUnit output
npx @adcp/sdk@latest storyboard run --local-agent ./agent.mjs capability_discovery \
  --format junit > junit.xml
```

The CLI imports the module, expects `default.createAgent` or a named `createAgent` export, and delegates to `runAgainstLocalAgent`. Same contract as the programmatic API.

## Running auth-dependent storyboards locally

`security_baseline` and the `signed-requests` negative vectors need real OAuth tokens. Don't reach for an external IdP — spin up the in-process test authorization server:

```ts
const result = await runAgainstLocalAgent({
  createAgent: () => createAdcpServer({ ..., stateStore }),
  authorizationServer: true,
  onListening: async ({ agentUrl, auth }) => {
    if (!auth) return;
    const token = await auth.issueToken({
      sub: 'acme-buyer',
      aud: agentUrl,
      scope: 'adcp:read adcp:write',
    });
    process.env.BUYER_TOKEN = token;
  },
  runStoryboardOptions: {
    auth: { type: 'bearer', token: () => process.env.BUYER_TOKEN! },
  },
  storyboards: ['security_baseline'],
});
```

`authorizationServer: true` starts an RFC 8414-compliant AS with a JWKS endpoint, wires `protectedResource` metadata on your agent's `/.well-known/oauth-protected-resource/mcp`, and exposes `auth.issueToken()` for minting RS256 JWTs bound to your agent's canonical URL.

Pass an options object to customize the AS — issuer URL, algorithm, preseeded subjects with default claims:

```ts
authorizationServer: {
  issuer: 'https://auth.fixture.example', // advertised in metadata and iss claim
  subjects: {
    'acme-buyer': { buyer_id: 'acme-buyer', brand_domain: 'acmeoutdoor.example' },
  },
},
```

Your agent's `verifyBearer({ jwksUri })` can then verify fixture-minted tokens without reaching the network — the AS runs on loopback in the same process.

## Picking the storyboard set

| `storyboards:` value | What runs |
|---|---|
| `'all'` (default) | Every storyboard in the compliance cache |
| `AgentCapabilities` | The same resolution the live assessment runner does against `get_adcp_capabilities` — universal bundles + protocol baselines + specialism bundles |
| `string[]` | Specific storyboard or bundle ids (e.g., `['sales-guaranteed', 'idempotency']`) |
| `Storyboard[]` | Already-loaded storyboard objects (for ad-hoc YAML under development) |

Use capability-based resolution in CI — it mirrors what the live runner does against your production agent, so a pass locally means a pass against AdCP Verified.

## Per-storyboard overrides

Most runs want one agent URL and one `runStoryboardOptions` for every storyboard. Two cases need to vary per storyboard:

- One storyboard targets a different route than the rest — the canonical example is `signed_requests` hitting a stricter `/mcp-strict` mount while everything else stays on `/mcp`.
- Different storyboards declare different `test_kit` or brand (a test-kit YAML file carries the brand domain the runner stamps on the request).

Supply `resolvePerStoryboard`:

```ts
const result = await runAgainstLocalAgent({
  createAgent: () => createAdcpServer({ ..., stateStore }),
  resolvePerStoryboard: (sb, defaultAgentUrl) => {
    if (sb.id === 'signed_requests') {
      return { agentUrl: defaultAgentUrl.replace(/\/mcp$/, '/mcp-strict') };
    }
    const kit = loadTestKit(sb); // your YAML loader
    if (!kit) return undefined;
    return { brand: brandFromKit(kit), test_kit: testKitFromKit(kit) };
  },
});
```

Return `undefined` to keep the defaults. `agentUrl` replaces the default; every other field is shallow-merged on top of the run-level `runStoryboardOptions`. `webhook_receiver` is helper-owned — the top-level `webhookReceiver` option still wins. The callback may be async if you need to load YAML or mint a scoped token per storyboard.

## What this doesn't do

- **Start tunnels.** For grading a remote agent from your laptop, use the CLI with `--webhook-receiver-auto-tunnel`, which spawns ngrok/cloudflared. `runAgainstLocalAgent` is loopback-only by design.
- **Auto-mint tokens per-storyboard.** The `onListening` hook fires once. If a flow needs a scoped or rotated token, either issue it inside `runStoryboardOptions.auth.token` as a function the runner calls per-step, or return a per-storyboard `auth` from `resolvePerStoryboard`.
- **Replace `adcp fuzz`.** Storyboards walk happy paths. Edge-case rejection is still fuzz's job. See [`VALIDATE-YOUR-AGENT.md`](./VALIDATE-YOUR-AGENT.md) for the full validation menu.

## Debugging a failing run

The helper returns `StoryboardResult[]` — the same shape the CLI consumes. Print the first failed step's validations to see what broke:

```ts
for (const sb of result.results) {
  if (sb.overall_passed) continue;
  for (const phase of sb.phases) {
    for (const step of phase.steps) {
      if (step.passed || step.skipped) continue;
      console.log(`${sb.storyboard_id} › ${step.title}`);
      console.log('  error:', step.error);
      for (const v of step.validations.filter(v => !v.passed)) {
        console.log('  -', v.description, ':', v.error);
      }
    }
  }
}
```

Or emit JSON for richer tooling:

```bash
npx @adcp/sdk@latest storyboard run --local-agent ./agent.mjs --json | jq '.results[] | select(.overall_passed | not)'
```

## Related

- [`BUILD-AN-AGENT.md`](./BUILD-AN-AGENT.md) — building the agent in the first place
- [`VALIDATE-YOUR-AGENT.md`](./VALIDATE-YOUR-AGENT.md) — the full validation checklist for remote agents
- [`TESTING-STRATEGY.md`](./TESTING-STRATEGY.md) — overall test architecture
