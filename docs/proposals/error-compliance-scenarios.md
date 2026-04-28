# Error Compliance Scenarios for `comply`

**Status:** Proposal
**Date:** 2026-03-19

## Problem

The `comply` tool tests whether agents handle valid requests correctly. It does not test whether agents return **properly structured errors** when things go wrong.

The existing `edge-cases.ts` scenarios (error_handling, validation, pricing_edge_cases, temporal_validation) provoke errors but only check a binary: did the agent reject it? They never inspect the error response for:

- AdCP error codes (`PRODUCT_NOT_FOUND`, `BUDGET_TOO_LOW`, etc.)
- Recovery classification (`transient`, `correctable`, `terminal`)
- Structured transport delivery (`structuredContent.adcp_error`)
- Actionable fields (`field`, `suggestion`, `retry_after`)

With the transport error mapping spec landed, we can now grade agents on error quality.

## Decisions

**L3 is the default expectation for all agents.** We'll ship a server-side `adcpError()` helper in `@adcp/sdk` that makes L3 a one-liner. If every agent builder imports it, there's no excuse for unstructured errors. Comply should expect `structuredContent.adcp_error` and flag its absence as a warning.

**Stress testing is in scope.** Gate behind `--stress-test` flag. Send a burst of rapid requests to intentionally trigger rate limits, then validate the response structure matches the transport error mapping spec (correct code, `retry_after` present, proper transport delivery).

**Error compliance does not demote other tracks.** It's its own track with its own pass/partial/fail. Poor error quality is a separate dimension from behavioral correctness.

## Server-Side Helper: `adcpError()`

The key to making L3 the default. Ships in `@adcp/sdk` so agent builders get structured errors for free.

### API

```typescript
import { adcpError, adcpErrors } from '@adcp/sdk';

// Single error — returns a complete MCP tool response
server.tool("get_products", schema, async ({ query }) => {
  if (!products.length) {
    return adcpError('PRODUCT_NOT_FOUND', {
      message: 'No products match query',
      field: 'query',
      suggestion: 'Try a broader search term',
    });
  }
  return { content: [...], structuredContent: { products } };
});

// With details
return adcpError('BUDGET_TOO_LOW', {
  message: 'Budget below minimum',
  field: 'packages[0].budget',
  suggestion: 'Increase budget to at least $500',
  details: { minimum_budget: 500, currency: 'USD' },
});

// Rate limit (transient) with retry_after
return adcpError('RATE_LIMITED', {
  message: 'Too many requests',
  retry_after: 5,
  details: { limit: 100, remaining: 0, window_seconds: 60 },
});
```

### What It Produces

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"adcp_error\":{\"code\":\"PRODUCT_NOT_FOUND\",\"message\":\"No products match query\",\"recovery\":\"correctable\",\"field\":\"query\",\"suggestion\":\"Try a broader search term\"}}"
    }
  ],
  "isError": true,
  "structuredContent": {
    "adcp_error": {
      "code": "PRODUCT_NOT_FOUND",
      "message": "No products match query",
      "recovery": "correctable",
      "field": "query",
      "suggestion": "Try a broader search term"
    }
  }
}
```

Three layers in one call:
1. `structuredContent.adcp_error` — L3 programmatic extraction
2. `content[0].text` — JSON text fallback for L2 clients
3. `isError: true` — MCP error signal

### Behavior

- **Auto-populates `recovery`** from the standard error code table if not provided. `PRODUCT_NOT_FOUND` → `correctable`, `RATE_LIMITED` → `transient`, etc.
- **Validates code** — warns if code is non-standard and missing `X_` vendor prefix
- **Validates `retry_after`** — warns if `RATE_LIMITED` without `retry_after`
- **Type-safe** — TypeScript overloads for standard codes with correct option shapes

### Implementation

```typescript
// src/lib/server/errors.ts

import { STANDARD_ERROR_CODES, type StandardErrorCode } from '../types/error-codes';

interface AdcpErrorOptions {
  message: string;
  recovery?: 'transient' | 'correctable' | 'terminal';
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

export function adcpError(code: string, options: AdcpErrorOptions) {
  const recovery = options.recovery
    ?? (code in STANDARD_ERROR_CODES
      ? STANDARD_ERROR_CODES[code as StandardErrorCode].recovery
      : 'terminal');

  const adcp_error: Record<string, unknown> = {
    code,
    message: options.message,
    recovery,
  };

  if (options.field != null) adcp_error.field = options.field;
  if (options.suggestion != null) adcp_error.suggestion = options.suggestion;
  if (options.retry_after != null) adcp_error.retry_after = options.retry_after;
  if (options.details != null) adcp_error.details = options.details;

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ adcp_error }) }],
    isError: true,
    structuredContent: { adcp_error },
  };
}
```

## Design

### New Track: `error_handling`

Add an `error_handling` capability track alongside the existing 9 tracks. This track:

- Is always applicable (like `core`) — every agent should handle bad input
- Runs deliberately invalid requests against tools the agent advertises
- Validates the **structure** of error responses, not just that errors occurred
- Grades agents on compliance level (L1/L2/L3)

### Error Compliance Levels

| Level | What we check | Score |
|-------|--------------|-------|
| **L1** | Error has `code` from standard vocabulary + `message` | Minimum pass |
| **L2** | L1 + `recovery` matches code, `field` points to bad input, `suggestion` present for correctable | Full pass |
| **L3** | L2 + delivered via `structuredContent.adcp_error` (MCP) or artifact `DataPart` (A2A) | Expected default |

### Scenario Definitions

#### `error_codes` — Standard Error Code Usage

Provoke known error conditions and validate the response uses the correct AdCP error code.

| Provocation | Expected Code | Recovery |
|------------|---------------|----------|
| `create_media_buy` with `product_id: "NONEXISTENT"` | `PRODUCT_NOT_FOUND` | correctable |
| `create_media_buy` with `budget: -1` | `INVALID_REQUEST` | correctable |
| `create_media_buy` with `budget: 0.01` (below any min) | `BUDGET_TOO_LOW` | correctable |
| `create_media_buy` with `end_time` before `start_time` | `INVALID_REQUEST` | correctable |
| `get_media_buy_delivery` with fake `media_buy_id` | `PRODUCT_NOT_FOUND` or empty result | correctable |
| `sync_creatives` with invalid `format_id` | `INVALID_REQUEST` or `CREATIVE_REJECTED` | correctable |

**Validation per response:**

```
1. Did the agent reject the request? (baseline — existing behavior)
2. Is response.isError === true? (MCP)
3. Extract AdCP error using detection order:
   a. structuredContent.adcp_error
   b. JSON.parse(content[0].text).adcp_error
   c. Plain text (no structured error found)
4. If structured error found:
   a. Does code match expected? (or is it a reasonable alternative?)
   b. Is recovery present and correct for the code?
   c. Is field present and pointing to the bad input?
   d. Is suggestion present for correctable errors?
5. Assign compliance level based on what's present
```

#### `error_structure` — Response Format Validation

Run one provocation and deeply validate the response structure against the `error.json` schema.

- `code` is a string (required)
- `message` is a string (required)
- `recovery` is one of `transient | correctable | terminal` (if present)
- `retry_after` is a non-negative number (if present)
- `field` is a string with dot-notation path (if present)
- `suggestion` is a string (if present)
- `details` is an object (if present)
- No extra top-level fields outside the schema

#### `error_transport` — Transport Binding Compliance

Check whether the error is delivered through the correct transport channel.

**MCP:**
- `isError: true` on the tool response
- `structuredContent.adcp_error` contains the full error object (L3)
- `content[0].text` contains JSON-stringified `{adcp_error: {...}}` (L2 fallback)
- Both paths present and consistent (ideal)

**A2A:**
- Task status is `failed`
- Artifact `DataPart` with `data.adcp_error` present
- `TextPart` with human-readable message also present

#### `stress_test` — Rate Limit Response Quality (gated)

Only runs with `--stress-test` flag. Validates that rate limiting responses are properly structured.

```
1. Send 10 rapid sequential requests to a single tool (e.g., get_products)
2. If any response is a rate limit:
   a. Validate it uses RATE_LIMITED code
   b. Check retry_after is present and > 0
   c. Check recovery is "transient"
   d. Check transport delivery (structuredContent or text fallback)
   e. If details present, validate against rate-limited details schema
3. If no rate limit hit after 10 requests: skip (agent doesn't rate limit at this volume)
```

This is opt-in because:
- It's aggressive toward the agent
- It may trigger infrastructure-level alerts
- Not all test environments have rate limiting enabled

### Integration with Existing Scenarios

**Option B: Separate track.** New `error_handling` track with its own scenarios that reuse the same provocations but focus entirely on error response quality. Existing edge-case scenarios keep testing behavioral correctness.

The error handling track is independently gradeable. An agent might correctly reject bad input (edge-case pass) but return unstructured errors (error handling fail). These are different dimensions of quality.

### Reporting

```
Error Handling  L3  6/6 scenarios pass  (1.2s)
   ✅ error_codes (5/5 correct codes)
   ✅ error_transport (structuredContent.adcp_error present)
   ✅ error_structure (valid schema)
   Error Compliance: Level 3
     ✓ Standard error codes used
     ✓ Recovery classification present
     ✓ structuredContent.adcp_error delivered
     ✓ field and suggestion present on correctable errors
```

Or for a less compliant agent:

```
Error Handling  L1  3/6 scenarios pass  (0.8s)
   ⚠️ error_codes (3/5 — 2 returned plain text without codes)
   ❌ error_transport (no structuredContent, no JSON text fallback)
   ⚠️ error_structure (code + message only, no recovery/field/suggestion)
   Error Compliance: Level 1
     ⚠ Some error codes used, some plain text
     ✗ No recovery classification
     ✗ No structuredContent (use adcpError() helper from @adcp/sdk)
     ✗ No field or suggestion on correctable errors
```

### Observations

| Condition | Severity | Message |
|-----------|----------|---------|
| No structured errors at all (plain text only) | warning | "Error responses are unstructured text. Use `adcpError()` from @adcp/sdk for L3 compliance." |
| Codes present but no `recovery` field | suggestion | "Add recovery classification to enable automatic agent retry/fix behavior." |
| `recovery` present but no `field`/`suggestion` on correctable | suggestion | "Add field and suggestion to correctable errors so agents can self-correct." |
| No `structuredContent.adcp_error` | warning | "Missing structuredContent. Use `adcpError()` helper for automatic L3 transport binding." |
| Using `structuredContent.adcp_error` | info | "L3 error compliance: structured errors via transport binding." |
| `retry_after` missing on `RATE_LIMITED` | warning | "RATE_LIMITED without retry_after forces clients to guess backoff timing." |
| Non-standard error codes without `X_` prefix | suggestion | "Vendor-specific error codes should use X_{VENDOR}_{CODE} convention." |

### Configuration

```bash
# Run all tracks including error handling
adcp comply test-mcp

# Run only error handling track
adcp comply test-mcp --track error_handling

# Include stress test for rate limit validation
adcp comply test-mcp --stress-test

# Skip error handling (for agents in early development)
adcp comply test-mcp --skip-track error_handling
```

## Implementation Plan

### Stage 1: Server-Side Error Helper

Ship `adcpError()` so agent builders get L3 for free before we start grading them.

**Files:**
- `src/lib/server/errors.ts` — `adcpError()` function
- `src/lib/server/index.ts` — exports
- `src/lib/index.ts` — add to public exports

### Stage 2: Error Extraction Utility

Generalize the rate-limit-specific extraction in `mcp.ts` into a full AdCP error extractor usable by comply and downstream consumers.

**Files:**
- `src/lib/types/error-extraction.ts` — `extractAdcpError()`, `getRecovery()`, `getExpectedAction()`
- `src/lib/protocols/mcp.ts` — refactor to use shared extraction
- `src/lib/utils/response-unwrapper.ts` — teach `unwrapMCPResponse` to detect `structuredContent.adcp_error` on error responses

### Stage 3: Error Compliance Scenarios

**Files:**
- `src/lib/testing/scenarios/error-compliance.ts` — `testErrorCodes()`, `testErrorStructure()`, `testErrorTransport()`, `testStressRateLimit()`
- `src/lib/testing/compliance/types.ts` — add `error_handling` track, update `TestScenario` union

### Stage 4: Comply Integration

**Files:**
- `src/lib/testing/compliance/comply.ts` — wire up error_handling track
- `src/lib/testing/compliance/profiles.ts` — add error_handling to all platform coherence profiles
- `bin/adcp.js` — add `--stress-test` and `--track`/`--skip-track` CLI flags
- Update terminal output to show error compliance level
