---
'@adcp/sdk': patch
---

A buyer no longer signs a request just because it carries webhook credentials when the seller's fetched capabilities advertise no request signing. Such a request includes `push_notification_config.authentication`, a reporting or artifact webhook's `authentication`, or `accounts[].notification_configs[].authentication`.

The AdCP 3.x rule that elevates these requests to a signature applies only to sellers that support request signing (security.mdx, webhook callbacks, condition (b), deprecated in 3.x and removed in 4.0). A seller that advertises no `request_signing` cannot verify the signature, so it buys nothing. Some of those sellers rejected the signed request outright with `request_signature_required` (adcontextprotocol/adcp#9204).

Behavior is otherwise unchanged:

- A seller that advertises `request_signing.supported: true` still gets these requests signed, whether or not the operation is in `required_for`.
- A cold capability cache, or one whose discovery failed, still signs, because the seller's advertisement is unknown. Negative cache entries now carry `discoveryFailed: true` so the two cases can be told apart.
- `always_sign`, `required_for`, `warn_for` and `sign_supported` decide signing exactly as before.
