# Multi-instance AdCP agent harness

Two replicas of an AdCP agent sharing one Postgres store, fronted by a round-robin Caddy proxy. Copy-paste scaffolding for local multi-instance storyboard testing.

## What's in here

| File              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `docker-compose.yml` | 2 app replicas + Postgres + Caddy. Ports 4100, 4101, 4099. |
| `Caddyfile`       | Round-robin reverse proxy on :4099 fronting both replicas.   |
| `.env.example`    | Secrets/config placeholders — copy to `.env` before starting.|

## Quickstart

1. Swap `image: CHANGEME/your-adcp-agent:latest` in `docker-compose.yml` for your agent image (or add a `build:` context).
2. Copy env:
   ```bash
   cp .env.example .env
   ```
3. Bring it up:
   ```bash
   docker compose up -d --wait
   ```
4. Run storyboards. Two valid shapes:

   **Runner-level round-robin** (client alternates per step, distinct MCP sessions per replica):
   ```bash
   npx @adcp/client storyboard run \
     --url http://localhost:4100/mcp/ \
     --url http://localhost:4101/mcp/ \
     property_lists --auth "$AGENT_TOKEN" --allow-http
   ```

   **LB-level rotation** (single MCP session; Caddy round-robins per request; matches production fronting):
   ```bash
   npx @adcp/client storyboard run http://localhost:4099/mcp/ \
     property_lists --auth "$AGENT_TOKEN" --allow-http
   ```

Both exercise cross-replica state persistence. The runner-level shape gives per-step `[#1]/[#2]` attribution in failure output; the LB shape is closer to production traffic but has no per-step attribution.

## Why two shapes

[Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state) in the AdCP docs lists two test topologies:

- **Explicit multi-URL** — you control which replica each step hits; `--url` repeated at the client.
- **LB-round-robin** — you deploy behind an LB, the client hits one endpoint, the LB distributes.

Either is valid. The docker-compose here gives you both on the same stack so you can pick without reconfiguring.

## Picking storyboards worth running

The multi-instance failure mode only surfaces on storyboards that have write→read chains. List them with:

```bash
npx @adcp/client storyboard list --stateful
```

That returns the ~40 compliance storyboards with at least one step marked `stateful: true`. Run those; stateless probes (capability discovery, schema validation, auth rejection) don't exercise the cross-replica invariant.

## Caveats

- **Placeholder image.** This compose file has `image: CHANGEME/your-adcp-agent:latest`. Replace with a real image that exposes `/healthz` and can connect to Postgres via env vars (`POSTGRES_PASSWORD` is injected; build `DATABASE_URL` from `PGHOST`/`PGUSER`/`POSTGRES_PASSWORD` inside the container, or override by adding `DATABASE_URL=...` to your `.env`). An agent that stores state in-process will correctly fail multi-instance testing with this harness.
- **Local-only.** `allow_http` is required because these are HTTP, not HTTPS. Do not run production traffic through this setup.
- **State schema.** Your agent needs to run migrations against the shared Postgres on startup (or you need to run them separately before `up`). That's agent-specific.
- **No default password.** `.env.example` ships placeholder values — copy to `.env` and replace every `<...>` with real values before running `docker compose up`. No defaults are inlined in `docker-compose.yml`, so compose fails fast if `.env` is missing.
- **Caddyfile is DEV ONLY.** The reverse proxy config exposes internal container hostports via `X-Replica` (for debugging) and terminates plain HTTP without TLS. Do not deploy this Caddyfile to production.

## Related

- Runner docs: [`docs/guides/MULTI-INSTANCE-TESTING.md`](../../guides/MULTI-INSTANCE-TESTING.md)
- Spec requirement: [State persistence and horizontal scaling](https://adcontextprotocol.org/docs/protocol/architecture#state-persistence-and-horizontal-scaling)
- Builder guidance: [Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state)
