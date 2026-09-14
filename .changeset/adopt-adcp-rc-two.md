---
'@adcp/sdk': minor
---

Adopt the signed AdCP 3.2.0-rc.2 schema and compliance bundles as the default wire release.
Idempotency fingerprints now preserve distinct malformed lone-surrogate payloads, so a
durable record created from such a payload may correctly conflict instead of replaying a
previous colliding response; well-formed request fingerprints remain unchanged.
