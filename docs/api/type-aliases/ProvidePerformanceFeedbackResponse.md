[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProvidePerformanceFeedbackResponse

# Type Alias: ProvidePerformanceFeedbackResponse

> **ProvidePerformanceFeedbackResponse** = \{ `success`: `true`; `context?`: \{ \}; \} \| \{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

Defined in: [src/lib/types/tools.generated.ts:3176](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3176)

Response payload for provide_performance_feedback task. Returns either success confirmation OR error information, never both.

## Type Declaration

\{ `success`: `true`; `context?`: \{ \}; \}

### success

> **success**: `true`

Whether the performance feedback was successfully received

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.

\{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

### errors

> **errors**: \[`Error`, `...Error[]`\]

Array of errors explaining why feedback was rejected (e.g., invalid measurement period, missing campaign data)

#### Min Items

1

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
