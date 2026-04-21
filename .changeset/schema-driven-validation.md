---
'@adcp/client': minor
---

Add schema-driven validation against the bundled AdCP JSON schemas on both
the client and the server (closes adcp-client#688).

**Client hooks** (on the `AdcpClient` / `SingleAgentClient` `validation`
config, applied automatically via `TaskExecutor`):

- `validation.requests: 'strict' | 'warn' | 'off'` — validate outgoing
  payloads before dispatch. `strict` throws `ValidationError`
  (`code: 'VALIDATION_ERROR'`) with a JSON Pointer to the offending field;
  `warn` logs to debug logs and continues. Default: `warn`.
- `validation.responses: 'strict' | 'warn' | 'off'` — validate incoming
  payloads on receive. `strict` fails the task; `warn` logs and continues.
  Default: strict in dev/test, warn in production. Overrides the legacy
  `strictSchemaValidation` flag when set.

**Server middleware** (opt-in on `createAdcpServer`'s `validation` config):

- `validation.requests: 'strict'` — dispatcher returns
  `adcpError('VALIDATION_ERROR', …)` before the handler runs.
- `validation.responses: 'strict'` — handler-returned drift surfaces as a
  `VALIDATION_ERROR` envelope; `warn` logs to the configured logger and
  returns the response unchanged.

Validation uses the bundled JSON schemas shipped at
`dist/lib/schemas-data/<adcp_version>/` — async response variants
(`-submitted`, `-working`, `-input-required`) are selected by payload shape
(`status` field), matching issue #688's spec. `additionalProperties` is
left permissive so vendor extensions don't trip the validator. The
`VALIDATION_ERROR` envelope carries the full issue list (pointer, message,
keyword, schema path) under `details.issues` for programmatic indexing.
