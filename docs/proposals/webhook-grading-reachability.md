# Webhook-grading reachability: tunnel, sockets, or rendezvous?

**Status:** Proposal
**Date:** 2026-04-21
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
the wrong answer, and what to do instead.

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

## Two acceptable answers

### Option A: auto-tunnel helper (ship soon)

A thin CLI flag that autodetects installed tunneling binaries on `PATH`,
starts a tunnel, captures its public URL, plugs it into proxy mode, and tears
it down on exit.

```
adcp storyboard run <remote-agent> webhook-emission --webhook-receiver-auto-tunnel
```

Detection order (first match wins; override with `ADCP_WEBHOOK_TUNNEL=<cmd>`):
1. `ngrok http <port>` (if `ngrok` is on `PATH` and authenticated)
2. `cloudflared tunnel --url http://localhost:<port>`
3. error: "no supported tunnel found — install ngrok or cloudflared, or pass
   `--webhook-receiver-public-url` with your own tunnel"

Pros:
- Spec-compliant (HTTP on the wire — no protocol change).
- No vendor lock: any `cmd PATH` detection entry works.
- One-command UX: `--webhook-receiver-auto-tunnel` subsumes the setup.
- Works offline if tunnel binary is already installed.

Cons:
- Tunnel binaries are still a prerequisite (mitigated by clear error message).
- Tunnel startup time adds 2–5s to run overhead.

Implementation scope: ~80 LOC in `bin/adcp.js` (child-process spawn + URL
extraction from stdout) plus an integration test that stubs the tunnel binary.

### Option B: AdCP-hosted rendezvous service (right long-term answer)

A public service at `rendezvous.adcontextprotocol.org` that:

1. Mints short-lived public HTTPS endpoints on request (e.g. 30-minute TTL).
2. Accepts incoming HTTP POSTs from agents under test at that endpoint.
3. Exposes a WebSocket subscription for the grader to receive inbound
   deliveries in real time.
4. Tears down the endpoint on grader disconnect or TTL expiry.

```
Grader ←──WebSocket──→ rendezvous ←──HTTPS─── Agent under test
```

Agent-side contract is unchanged — ordinary HTTP POST to a public URL,
exactly the production wire format. Grader-side ergonomics become
"socket-style": outbound WebSocket from the grader's machine, no inbound
listener required.

This is the socket-mode idea done right. The conformance-under-test invariant
is preserved (HTTP POST from agent exercises the real emitter); the
developer-side friction (public IP requirement) is removed; no third-party
dependency.

Pros:
- Zero developer setup — works out of the box from any network.
- Spec stewards own reliability and security posture.
- WebSocket grader-side → operates behind NAT, corporate proxies, CI
  boxes without ingress.
- Supports eventual integration with AdCP Verified grading pipeline.

Cons:
- Requires hosting + SRE commitment.
- Shared service = abuse vector; needs rate-limiting, short TTLs,
  unlisted URLs, probably a lightweight auth layer (short-lived bearer
  minted per grader session).
- Longer lead time than Option A.

Implementation scope: deferred to a spec-stewardship RFC. Rough sketch:
Cloudflare Workers / Fly.io for the edge + Durable Objects or Redis for the
endpoint→subscriber routing table.

## Recommendation

Ship **Option A** as a follow-up to PR #679. Track in a new GitHub issue.
Scope: one CLI flag, one integration test, a CHANGELOG entry.

Scope **Option B** as an AdCP stewardship initiative — separate RFC in the
upstream spec repo, own design doc, own rollout plan. Don't block Option A
on it.

Reject socket mode explicitly: it fails the conformance-parity invariant
the `webhook_receiver_runner` test-kit is built on. If a client wants
"socket-mode-style ergonomics," Option B delivers that on the grader side
without compromising what's actually being graded on the agent side.

## Out of scope

- In-process mock webhooks for unit tests. Already covered by the
  `loopback_mock` mode documented in the test-kit.
- Webhook signature verification design. Already handled by the
  `signature_replay_store` contract in `webhook-receiver-runner.yaml`.
- Multi-pass multi-instance + webhooks. Already rejected at the runtime
  layer (`runStoryboard` throws) and at the CLI layer (guard added in #679).
