---
'@adcp/client': minor
---

Add `--webhook-receiver-auto-tunnel` for webhook-grading a remote agent from
a local machine. Autodetects `ngrok` or `cloudflared` on `PATH`, spawns the
tunnel pointed at the receiver, extracts the public URL, plumbs it into
proxy mode, and tears the tunnel down on exit (including on SIGINT/SIGTERM).

Use `ADCP_WEBHOOK_TUNNEL="<cmd> {port}"` to override detection with a
custom tunnel command — the CLI passes the auto-assigned port via `{port}`
substitution and captures the URL behind an explicit
`ADCP_TUNNEL_URL=https://…` marker the custom command must emit on
stdout/stderr. The marker convention avoids misrouting webhooks to docs or
diagnostic URLs that tunnel binaries often log at startup; ngrok and
cloudflared detections use vendor-pinned regexes for the same reason.

The flag is mutually exclusive with `--webhook-receiver-public-url` and
any `--webhook-receiver` mode (auto-tunnel already implies proxy), and
(like `--webhook-receiver`) incompatible with `--multi-instance-strategy
multi-pass`. Skipped during `--dry-run` (the conflict validation still
runs, but no tunnel is spawned).

No spec change: the tunnel forwards ordinary HTTPS to the local receiver,
so the `webhook_receiver_runner` parity invariant (`loopback_mock` ≡
`proxy_url` for the same agent emitter path) holds. Spec-compliant with the
test-kit's "MUST NOT require a specific tunnel vendor" rule — detection is
PATH-based and vendor-agnostic. A hosted rendezvous service for graders
that can't install a tunnel binary is tracked separately at
adcontextprotocol/adcp#2618 (milestone 3.1.0).
