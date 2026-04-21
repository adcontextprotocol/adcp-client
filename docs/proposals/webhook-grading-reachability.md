# Webhook-grading reachability: tunnel, sockets, or rendezvous?

**Status:** Option A shipping; Option B tracked as [adcontextprotocol/adcp#2618](https://github.com/adcontextprotocol/adcp/issues/2618) (milestone 3.1.0)
**Date:** 2026-04-20
**Follows:** #675 (CLI `--webhook-receiver`) / PR #679

## Problem

The storyboard runner grades outbound webhook conformance by hosting an HTTP
listener and observing deliveries from the agent under test. This requires the
listener to be reachable from the agent. Three topologies:

| Runner | Agent | Listener needs public IP? |
|---|---|---|
| Local | Local (same process or same host) | No — loopback is fine |
| Local (laptop) | Remote (hosted service) | **Yes** — the agent can't reach `127.0.0.1:PORT` on a developer's machine |
| CI | Remote | Yes, but CI typically has ingress |

The painful case is the middle row — a developer on a laptop grading a remote
agent. `--webhook-receiver proxy --webhook-receiver-public-url <tunnel>` works,
but setting up the tunnel is manual friction.

A client surfaced this and suggested we support something like Slack's Socket
Mode. This doc explains why that's the wrong answer, why bundling ngrok is also
the wrong answer, and what we're doing instead.

## Why Socket Mode is the wrong answer

Slack's Socket Mode lets an app open an outbound WebSocket to Slack and receive
events over it instead of hosting a public HTTPS endpoint. Applied to AdCP
webhook grading, the analog would be: the agent opens a WebSocket to the
grader and pushes "webhook" messages over it instead of HTTP POSTing to a URL.

This defeats the purpose of the conformance test. The
`webhook_receiver_runner` test-kit explicitly calls out what the runner is
grading: "an agent that passes under `loopback_mock` MUST also pass under
`proxy_url` for the same storyboard — any divergence is a conformance bug."
The shared invariant across both modes is that the agent's production
outbound-HTTP emitter runs end to end: TLS handshake, RFC 9421 signature math
over the wire, `idempotency_key` presence across retries, body preservation
through proxies, retry back-off against real 5xx responses.

Swap HTTP for a WebSocket push and none of that gets exercised. An agent could
pass socket-mode grading while its production webhook emitter is silently
broken — missing signature headers, mutating `idempotency_key` across retries,
choking on chunked-encoding bodies. That's exactly the class of bug the
outbound-webhook conformance surface exists to catch.

Slack's own testing doesn't conflate Socket Mode with Events API conformance
— they're parallel delivery mechanisms, tested independently. AdCP has one
delivery mechanism in production (HTTP POST) and conformance grading has to
match.

## Why bundling ngrok is the wrong answer

Tempting: auto-launch ngrok when the operator asks for a public URL. Easy
ergonomics win. But:

1. The `webhook_receiver_runner` test-kit explicitly says: "Operators MAY
   configure a tunnel as the proxy_url provider, but the runner MUST NOT
   require a specific tunnel vendor." Pinning ngrok violates the spec.
2. ngrok's free tier has session-length caps, reserved-domain paywalls, and
   requires an auth token. Making first-run compliance grading depend on a
   third-party SaaS account is bad DX.
3. `cloudflared`, `frp`, `bore`, and `localtunnel` are all legitimate
   alternatives. Hardcoding one picks a winner.

## Decisions

### Option A: auto-tunnel helper — **shipping in this PR**

`--webhook-receiver-auto-tunnel` autodetects a tunnel binary on `PATH`,
spawns it pointed at the receiver port, captures its public URL, plugs it
into proxy mode, and tears the tunnel down on exit.

```
adcp storyboard run <remote-agent> webhook-emission --webhook-receiver-auto-tunnel
```

Detection order (first match wins; override with `ADCP_WEBHOOK_TUNNEL="<cmd> {port}"`):

1. `ngrok http <port> --log=stdout --log-format=logfmt` — URL captured from
   the logfmt `url=<https://…ngrok-free.app>` field, pinned to ngrok's own
   tunnel domains so a stray `url=` in startup diagnostics can't be mistaken
   for the forwarding URL.
2. `cloudflared tunnel --url http://localhost:<port> --no-autoupdate` — URL
   captured from the printed `https://<slug>.trycloudflare.com` line.
3. Custom command from `$ADCP_WEBHOOK_TUNNEL` — must emit a line containing
   `ADCP_TUNNEL_URL=<https://…>` to stdout/stderr. The marker convention
   avoids the ambiguity of "first `https://` URL in output" (many binaries
   log docs or diagnostic URLs at startup).
4. error: "no supported tunnel binary found on PATH — install ngrok or
   cloudflared, or set `ADCP_WEBHOOK_TUNNEL`, or pass
   `--webhook-receiver-public-url` with your own tunnel."

Why this is the right near-term answer:

- **Spec-compliant.** HTTP on the wire — the `loopback_mock ≡ proxy_url`
  parity invariant holds.
- **No vendor lock.** Detection is PATH-based and override-friendly. The
  test-kit's "MUST NOT require a specific tunnel vendor" rule is honored.
- **One-command UX.** `--webhook-receiver-auto-tunnel` subsumes the manual
  tunnel setup.
- **Works offline** once the tunnel binary is installed.

Tradeoffs:

- Tunnel binaries are still a prerequisite (mitigated by actionable error).
- Tunnel startup time adds 2–5s to run overhead.
- Doesn't help graders on networks that can't reach public tunnel services
  (Option B's target case).

Implementation: ~200 LOC in `bin/adcp.js` (detection, spawn, URL capture,
cleanup on SIGINT/SIGTERM/exit) plus integration tests that use a stubbed
tunnel via `$ADCP_WEBHOOK_TUNNEL`, so CI doesn't depend on ngrok/cloudflared
being installed.

### Option B: AdCP-hosted rendezvous service — **tracked in spec repo**

A public service at `rendezvous.adcontextprotocol.org` that mints
short-lived HTTPS endpoints, accepts agent POSTs, and fans out to a
grader-side WebSocket subscription. Socket-mode-style ergonomics on the
*grader's* side without compromising what gets graded on the *agent's* side.

Full design in [adcontextprotocol/adcp#2618](https://github.com/adcontextprotocol/adcp/issues/2618)
(milestone 3.1.0). This is the right long-term answer for graders who
can't install a tunnel binary or can't reach public tunnel services — e.g.
CI inside private VPCs, corporate laptops with egress restrictions, AdCP
Verified's grading pipeline. It lives as a spec-repo issue rather than an
in-repo RFC because it requires hosting commitment, operational ownership,
and an abuse-prevention story the AdCP stewards own — none of which block
the auto-tunnel helper.

## Rejected: Socket Mode (explicitly)

Not acceptable. It fails the conformance-parity invariant the
`webhook_receiver_runner` test-kit is built on. If a client wants
"socket-mode-style ergonomics," Option B delivers that on the grader side
without compromising what's actually being graded on the agent side.

## Out of scope

- In-process mock webhooks for unit tests. Already covered by the
  `loopback_mock` mode documented in the test-kit.
- Webhook signature verification design. Already handled by the
  `signature_replay_store` contract in `webhook-receiver-runner.yaml`.
- Multi-pass multi-instance + webhooks. Already rejected at the runtime
  layer (`runStoryboard` throws) and at the CLI layer (guard added in #679).
