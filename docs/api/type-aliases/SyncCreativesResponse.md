[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / SyncCreativesResponse

# Type Alias: SyncCreativesResponse

> **SyncCreativesResponse** = \{ `dry_run?`: `boolean`; `creatives`: `object`[]; `context?`: \{ \}; \} \| \{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

Defined in: [src/lib/types/tools.generated.ts:2133](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2133)

Response from creative sync operation. Returns either per-creative results (best-effort processing) OR operation-level errors (complete failure). This enforces atomic semantics at the operation level while allowing per-item failures within successful operations.

## Type Declaration

\{ `dry_run?`: `boolean`; `creatives`: `object`[]; `context?`: \{ \}; \}

### dry\_run?

> `optional` **dry\_run**: `boolean`

Whether this was a dry run (no actual changes made)

### creatives

> **creatives**: `object`[]

Results for each creative processed. Items with action='failed' indicate per-item validation/processing failures, not operation-level failures.

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.

\{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

### errors

> **errors**: \[`Error`, `...Error[]`\]

Operation-level errors that prevented processing any creatives (e.g., authentication failure, service unavailable, invalid request format)

#### Min Items

1

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
