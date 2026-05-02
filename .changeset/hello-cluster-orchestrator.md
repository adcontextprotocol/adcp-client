---
'@adcp/sdk': patch
---

feat(example): hello-cluster orchestrator boots all hello-\* adapters with one command

`examples/hello-cluster.ts` (and `npm run hello-cluster`) spawns each per-specialism hello adapter on its declared port (signals 3001, sales 3002, governance 3003, creative 3004, brand 3005, retail-media 3006), preflights each adapter's upstream backend, health-checks each via MCP `tools/list`, and emits a YAML routing manifest the storyboard runner (#1066, landing as #1355) can consume via `--agents-map`. Manifest shape locked against `parseAgentsMapArgs` in PR #1355: top-level `default_agent` (omitted when `sales` is pending so storyboards expecting it fail loud), `agents.<key>.{ url, auth }` matching `TestOptions['auth']`'s bearer variant, plus a top-level `pending: [{ name, specialism, entrypoint, tracking }]` sibling that the runner ignores but tooling can surface.

Closes the local test loop for #1066 — adopters can stand up a multi-agent topology with one command instead of opening six terminals.

Pending hello adapters (#1332 governance, #1333 creative, #1334 brand, plus sales / retail-media) are listed in a `# pending:` block at the top of the manifest and skipped silently. Drop a file in at the documented path and the cluster picks it up next run — no edits to the orchestrator. Today only the signals adapter exists, so the cluster boots one agent and notes the rest as pending.

Behavior:

- Boots every present adapter in parallel; ready in ~2s for the current single-adapter set, well under the 5s budget.
- SIGINT/SIGTERM reap children cleanly (SIGTERM with 3s grace, then SIGKILL). A `tearingDown` guard prevents N concurrent reap cycles when a sibling crash fires every other child's exit handler.
- A child crash tears down the rest of the cluster and exits non-zero, surfacing the last 10 lines of the dying adapter's stderr in the cluster's error message — adopters see WHY the child died (e.g. EADDRINUSE), not just "fetch failed".
- `HELLO_CLUSTER_PORT_BASE=40000` shifts the whole range when 3001–3006 are busy or when running side-by-side clusters.
- Defaults `NODE_ENV=development` for spawned children so the in-memory task registry boots without the production-safety refusal. The cluster itself refuses to boot under a production parent unless `HELLO_CLUSTER_I_KNOW_NOT_PROD=1` is set — defense in depth so an LLM scaffolding from this file or an adopter copy-pasting into staging can't accidentally rewrite NODE_ENV on a real deployment.
- Manifest leads with a routing-key comment so first-time readers don't have to chase #1066 to understand what `agents.<name>` means. `default_agent` is omitted when its target (`sales`) is in the pending list — storyboards expecting `sales` fail loud rather than silently retargeting to whichever adapter sorted first.

Upstream preflight: each `AdapterConfig` declares the env var (e.g. `UPSTREAM_URL`), default URL, and probe path of the backend it proxies. Before spawning, the cluster fetches every distinct upstream URL once with a 1.5s timeout. Network refusal or 5xx → exit 1 with a copy-pasteable command (`run 'npx @adcp/sdk@latest mock-server <specialism> --port <inferred>' first`). The port in the hint is parsed from the supplied URL, so a user pointing `UPSTREAM_URL` at `:55555` gets a hint matching their port. Any 2xx/3xx/4xx is treated as "listener up" since the failure mode we care about is "process not running," not "request rejected."

Deferred:

- `HELLO_CLUSTER_HOST` for binding `0.0.0.0` so peer containers can reach the cluster (product expert's QA-env feedback).
- `HELLO_CLUSTER_STRICT=1` so CI fails when the expected adapter set isn't fully present (post-#1334 concern).

Out of scope: TLS termination, production-style supervision, upstream mock-server boot. Adopters wanting the full stack run docker-compose / foreman; this is the minimal one-command demo.
