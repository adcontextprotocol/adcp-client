# AdCP Transport Error Mapping

**Status:** Proposal
**Authors:** AdCP Working Group
**Date:** 2026-03-18

## Problem

AdCP defines a rich, structured error model with 20 standard error codes, recovery classifications, and fields like `retry_after`. When an AdCP agent is accessed over MCP or A2A, this structure is lost.

Today a rate-limited request returns:

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Rate limit exceeded. Please try again later."}}
```

The client has no way to know:
- That this is a `RATE_LIMITED` error (vs. any other `-32000`)
- How long to wait (`retry_after`)
- Whether to retry, fix the request, or escalate (`recovery`)

Clients must pattern-match on error message strings, which is fragile, language-dependent, and loses the structured data that AdCP already defines.

## Background

### AdCP Error Model

AdCP errors are well-specified (`/schemas/latest/core/error.json`):

```json
{
  "code": "RATE_LIMITED",
  "message": "Request rate exceeded",
  "retry_after": 5,
  "recovery": "transient"
}
```

Key fields:
- `code` — one of 20 standard codes (or seller-defined)
- `message` — human-readable
- `retry_after` — seconds to wait (for transient errors)
- `recovery` — `transient` | `correctable` | `terminal`
- `field`, `suggestion`, `details` — optional context

### Transport Protocols

**MCP** uses JSON-RPC 2.0 with:
- Standard codes: `-32700` (parse error) through `-32600` (invalid request)
- Server codes: `-32099` through `-32000` (implementation-defined)
- Tool-level errors: `isError: true` with unstructured text content

**A2A** uses JSON-RPC 2.0 with:
- Same standard codes as MCP
- Task-level errors in `TaskStatus.message`

Neither protocol defines how application-layer errors (like AdCP errors) should be carried over the transport.

## Proposal

### Principle

AdCP errors are **application-layer** errors. They should be carried in the tool/task response, not in the JSON-RPC error object. The JSON-RPC error channel is for **transport-layer** failures (connection refused, malformed request, internal crash). Mixing the two prevents clients from distinguishing "the agent understood your request and rejected it" from "the agent couldn't process your request at all."

The one exception is rate limiting, which straddles both layers — it may be enforced by infrastructure before the agent code runs. This proposal handles both cases.

### MCP Binding

#### Tool-Level Errors (Preferred)

When an AdCP tool encounters an error, the agent SHOULD return a successful MCP response with `isError: true` and the AdCP error as structured content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"code\":\"RATE_LIMITED\",\"message\":\"Request rate exceeded\",\"retry_after\":5,\"recovery\":\"transient\"}"
    }
  ],
  "isError": true,
  "structuredContent": {
    "adcp_error": {
      "code": "RATE_LIMITED",
      "message": "Request rate exceeded",
      "retry_after": 5,
      "recovery": "transient"
    }
  }
}
```

- `text` content provides backward compatibility for clients that don't parse structured errors
- `structuredContent.adcp_error` carries the full AdCP error object for capable clients
- The `adcp_error` key distinguishes AdCP errors from other structured content

#### Transport-Level Rate Limits

When rate limiting is enforced at the infrastructure layer (before MCP tool dispatch), the error arrives as a JSON-RPC error. Agents SHOULD use error code `-32029` and include the AdCP error in the `data` field:

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "adcp_error": {
        "code": "RATE_LIMITED",
        "message": "Request rate exceeded",
        "retry_after": 5,
        "recovery": "transient"
      }
    }
  }
}
```

- `-32029` is in the server-defined range (`-32099` to `-32000`) and is reserved by this spec for AdCP rate limits
- The `data` field is part of JSON-RPC 2.0 and carries additional error information
- Clients that don't understand `-32029` fall back to string matching (backward compatible)

#### Client Detection Order

Clients SHOULD detect AdCP errors in this order:

1. Check `structuredContent.adcp_error` on tool responses
2. Check JSON-RPC `error.data.adcp_error` on transport errors
3. Fall back to pattern matching on `error.message` or `content[].text`

### A2A Binding

#### Task-Level Errors

A2A agents SHOULD return AdCP errors in the task artifact with a dedicated MIME type:

```json
{
  "jsonrpc": "2.0",
  "id": "req-123",
  "result": {
    "id": "task-456",
    "status": {
      "state": "failed",
      "message": {
        "role": "agent",
        "parts": [
          {
            "type": "data",
            "mimeType": "application/vnd.adcp.error+json",
            "data": {
              "code": "RATE_LIMITED",
              "message": "Request rate exceeded",
              "retry_after": 5,
              "recovery": "transient"
            }
          },
          {
            "type": "text",
            "text": "Rate limit exceeded. Please retry after 5 seconds."
          }
        ]
      }
    }
  }
}
```

- `application/vnd.adcp.error+json` MIME type signals that the data part is an AdCP error
- Text part provides backward compatibility
- Task state is `failed` for terminal/correctable errors, or the agent MAY use `failed` with recovery hints for transient errors

#### Transport-Level Rate Limits

Same as MCP: use JSON-RPC error code `-32029` with `data.adcp_error`.

### Error Code Mapping

For reference, the recommended mapping of JSON-RPC codes to AdCP scenarios:

| JSON-RPC Code | Meaning | AdCP Usage |
|---|---|---|
| `-32700` | Parse error | Malformed JSON in request |
| `-32600` | Invalid request | Missing required JSON-RPC fields |
| `-32601` | Method not found | Unknown tool name |
| `-32602` | Invalid params | Schema validation failure |
| `-32029` | **AdCP rate limit** | `RATE_LIMITED` with `retry_after` |
| `-32000` | Server error (generic) | Other unhandled errors |

### Recovery Behavior

Clients SHOULD implement automatic recovery based on the `recovery` classification:

| Recovery | Client Behavior |
|---|---|
| `transient` | Retry after `retry_after` seconds (or exponential backoff if not provided) |
| `correctable` | Do not retry automatically. Surface `suggestion` and `field` to the caller. |
| `terminal` | Do not retry. Surface error to human operator. |

When `retry_after` is present, clients MUST respect it. When absent for `transient` errors, clients SHOULD use exponential backoff starting at 2 seconds.

## Migration Path

### Phase 1: Client-Side Detection (Now)

Clients implement the detection order above: check structured content first, fall back to string matching. This works with existing agents that return unstructured rate limit messages.

### Phase 2: Agent-Side Adoption

Agents adopt `structuredContent.adcp_error` for tool-level errors and `-32029` for transport-level rate limits. Clients that already implement Phase 1 automatically benefit.

### Phase 3: Deprecate String Matching

Once adoption is sufficient, clients MAY deprecate string-based rate limit detection and require structured errors.

## Open Questions

1. **Should `-32029` be an MCP SDK standard?** If rate limiting is common enough across MCP servers (not just AdCP), this could be proposed upstream to the MCP spec.

2. **Should AdCP define additional reserved JSON-RPC codes?** For example, `-32028` for `AUTH_REQUIRED`, `-32027` for `SERVICE_UNAVAILABLE`. Or is the `data.adcp_error` envelope sufficient for all cases?

3. **Should `retry_after` be a Retry-After HTTP header too?** For StreamableHTTP transport, the HTTP response could include a standard `Retry-After` header alongside the JSON-RPC error body. This would allow HTTP-aware middleware to handle rate limiting without parsing the response body.

4. **A2A task state for transient errors:** Should a rate-limited A2A task be `failed` (terminal) or should A2A define a `retryable` state? Currently `failed` implies the task won't make progress without intervention.
