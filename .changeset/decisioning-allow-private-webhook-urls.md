---
'@adcp/sdk': minor
---

`CreateAdcpServerFromPlatformOptions.allowPrivateWebhookUrls?: boolean` opt for sandbox / local-testing flows. The framework's request-ingest validator rejects loopback / RFC 1918 / link-local destinations on `push_notification_config.url` by default — accepting them in production is a SSRF / cloud-metadata exfiltration path. Setting the flag to `true` bypasses ONLY the private-IP branch; malformed-URL, non-http(s) scheme, and the `http://` reject (separately gated by NODE_ENV / `ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS`) all still fire. Construction emits a one-shot footgun warn when the flag is `true` AND `NODE_ENV` is not `test` / `development` (and `ADCP_DECISIONING_ALLOW_PRIVATE_WEBHOOK_URLS` isn't set as ack), so accidental production toggles are visible. Adopters typically scope the flag on their own `NODE_ENV !== 'production'` check. Surfaced by training-agent v6 spike round 5 (Issue 6 / F11).
