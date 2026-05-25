---
'@adcp/sdk': minor
---

Export `parseWholesaleFeedWebhookNotification` /
`normalizeWholesaleFeedWebhookNotification` helpers for canonical wholesale-feed
webhook receivers and align `WholesaleFeedSync` dedupe semantics with delivery
`idempotency_key` plus canonical logical event identity
`notification_id === event.event_id`.

Add buyer-side signal discovery helpers that normalize `get_signals` rows,
expose the canonical `activate_signal.signal_agent_segment_id` handle, and
build activation requests without confusing `signal_id` provenance for the
activation key.
