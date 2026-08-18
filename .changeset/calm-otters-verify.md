---
'@adcp/sdk': minor
---

Verify inbound task-status webhooks with the authentication mode selected at registration time. The client now persists secretless callback provenance before seller dispatch, verifies those registrations with RFC 9421 using seller keys resolved through `brand.json`, rejects HMAC/RFC mode substitution, binds signatures to raw bytes and the trusted public callback URL, and provides injectable registration, replay, revocation, and JWKS stores for durable deployments. Legacy HMAC receivers remain compatible and never persist secret-derived material.
