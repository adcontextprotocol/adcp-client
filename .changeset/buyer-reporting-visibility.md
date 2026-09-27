---
'@adcp/sdk': minor
---

Expose a focused `@adcp/sdk/reporting/consumer` buyer entrypoint and publish an
existing-application worker example with PostgreSQL persistence, signed webhook
intake, buyer-retained expectations, and explicit adjustment policy. Include
seller/principal scope and run reason in buyer worker results and error context;
emit a credential-safe structured warning when background errors have no
observer. Result objects now include `consumerScope`, and an omitted or failed
error observer produces a structured warning on stderr.
