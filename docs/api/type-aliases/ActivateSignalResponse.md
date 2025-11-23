[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ActivateSignalResponse

# Type Alias: ActivateSignalResponse

> **ActivateSignalResponse** = \{ `deployments`: `Deployment`[]; `context?`: \{ \}; \} \| \{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

Defined in: [src/lib/types/tools.generated.ts:4063](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4063)

Response payload for activate_signal task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - the signal is either fully activated or not activated at all.

## Type Declaration

\{ `deployments`: `Deployment`[]; `context?`: \{ \}; \}

### deployments

> **deployments**: `Deployment`[]

Array of deployment results for each destination

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.

\{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

### errors

> **errors**: \[`Error`, `...Error[]`\]

Array of errors explaining why activation failed (e.g., platform connectivity issues, signal definition problems, authentication failures)

#### Min Items

1

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
