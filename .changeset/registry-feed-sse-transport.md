---
'@adcp/sdk': minor
---

Add the registry feed SSE transport and resilience to `RegistrySync` (adcp#5733).

`RegistryClient.streamFeed(query, { signal })` opens `GET /api/registry/feed/stream` and yields typed `feed` / `heartbeat` / `error` messages over a fetch-based SSE reader (carries the bearer, runs under Node, bounded per-frame buffer that fails closed on a runaway stream). `RegistryClient.getFeed` now maps a real HTTP 410 to a recoverable `{ cursor_expired: true }` response so the polling path recovers too.

`RegistrySync` defaults to `transport: 'auto'`: it tails the feed over SSE and falls back to polling `/api/registry/feed` on an unsupported endpoint (404/406), proxy/network failure, or stream parse failure. The persisted cursor advances only on `feed` events (never heartbeats), reconnects resume from the last persisted cursor, a `cursor_expired` error event (or `getFeed` 410) re-bootstraps then resumes, and cursors stay scoped to the configured `types` subscription. Resilience details: `stop()`/`reset()` are honored even mid-bootstrap/rebootstrap (generation-guarded — no stale loop resumes after the caller stops); a failed re-bootstrap keeps reconnecting in `'stream'` mode and counts toward fallback in `'auto'`; repeated `cursor_expired` recovery backs off rather than tight-looping; a permanent `400`/`401` is terminal (no hot reconnect/poll loop); and `feedPageLimit` / `streamPollIntervalSeconds` are range-validated at construction.

Feed `freshness` metadata (`generated_at`, `latest_event_created_at`, `lag_seconds`, `retention_days`) is exposed via a `freshness` event plus `getFreshness()` / `getLagSeconds()` for lag monitoring. The SDK never fabricates it — `freshness` is surfaced iff the server sent it (the type stays optional to accommodate the synthetic `cursor_expired` marker).

New `RegistrySync` config: `transport`, `types`, `feedPageLimit`, `streamPollIntervalSeconds`, `streamIdleTimeoutMs`, `streamReconnectMinMs`, `streamReconnectMaxMs`, `maxStreamFailures`. New events: `freshness`, `transport`. New accessors: `getTransport()`, `getFreshness()`, `getLagSeconds()`. New exports: `openFeedStream`, `parseSseStream`, `FeedStreamError` / `FeedStreamUnsupportedError` / `FeedStreamCursorExpiredError` / `FeedStreamHttpError` / `FeedStreamParseError`, and the `FeedStreamQuery` / `FeedStreamMessage` / `FeedHeartbeat` / `FeedStreamErrorData` / `FeedFreshness` / `RegistrySyncTransport` types.
