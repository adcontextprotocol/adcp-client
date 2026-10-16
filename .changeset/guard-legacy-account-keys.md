---
'@adcp/sdk': patch
---

Reject `sync_accounts` provisioning entries and natural-key settings references with AdCP 3.2 account identity fields when the client or negotiated seller release is below 3.2, or seller support cannot be established. The pre-dispatch error identifies the unsupported field and requires callers to explicitly choose any legacy account-key projection, preventing silent account identity collisions even when schema validation is disabled. Upgrade both sides to AdCP 3.2, or explicitly remove `operator_unit`, `currency`, `timezone`, and `brand.countries` to accept legacy account identity.
