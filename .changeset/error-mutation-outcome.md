---
'@adcp/sdk': patch
---

A failed task now tells the buyer whether the seller applied the failed mutation (#3689). Without that, a buyer must treat every failure as unknown, or risk double-booking after a retry and reporting a refusal for an order that is actually live.

- `result.adcpError.mutation_outcome` carries AdCP 3.3 `error.mutation_outcome` (`applied`, `not_applied` or `unknown`). It is read from `adcp_error` and falls back to the first `errors[]` entry. Before, the projection dropped it, although the raw body kept it.
- A thrown transport error that carries the seller's structured error body (`error.data` or `error.response.data` with `adcp_error` or `errors[]`) now returns that body as `result.data`, as a returned failure does. Before, both the body and the outcome were lost. This also applies to the per-agent failures of the multi-agent client's parallel operations.
- An A2A JSON-RPC error now keeps its structured `data` on the thrown error, instead of being replaced with a plain message.
- `is401Error` no longer classifies an error as HTTP 401 from its message text, such as "Unauthorized upstream", when the error carries a structured AdCP error body. Such an error is the seller's application error with its own code. Treating it as an auth failure replaced it with `AuthenticationRequiredError` and lost the body. Real 401 status codes are unchanged.
- The exported `extractAdcpErrorFromMcp` and `extractAdcpErrorFromTransport` read the same `errors[]` fallback for `mutation_outcome`, and a malformed `errors[]` entry no longer throws during extraction.
