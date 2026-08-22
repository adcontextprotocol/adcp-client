---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.2.0-beta.5 schema and compliance bundle, including the
webhook delivery retry horizon and normative async identity, convergence, and
continuation-generation contract. Webhook publishers now advertise and enforce
their retry horizon, atomically bind each SDK-local `delivery_id` to one
I-JSON canonical payload and delivery key within trusted publisher/tenant
scopes, retain an un-rebindable tombstone after expiry, and keep that identity
separate from the AdCP `operation_id` carried in the payload. Production
emitters require both a durable binding store and a durable delivery-recovery
outbox, and synchronous terminal responses remain silent on the task-webhook
channel even when the deprecated compatibility flag is supplied.
