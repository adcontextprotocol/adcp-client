---
'@adcp/sdk': patch
---

Throw a typed `ProtocolFeatureUnsupportedError` before schema validation when a client pinned below AdCP 3.1 sends 3.1-only discovery controls such as `get_signals` `discovery_mode: "wholesale"` or discovery `push_notification_config`, including `push_notification_config` injected from `webhookUrlTemplate`. This protocol preflight runs independently of request schema validation. The error remains catch-compatible with `FeatureUnsupportedError`, exposes protocol code `UNSUPPORTED_FEATURE`, and includes `required_version` and `capability_path` details for buyer recovery.
