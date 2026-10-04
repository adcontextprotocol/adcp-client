# Cause-aware signing discovery recovery

SDK issue #3109 identifies a gap in the protocol's generated recovery metadata:
`request_signature_capabilities_unreachable` and
`request_signature_brand_json_unreachable` classify every non-2xx failure as
transient, including an SSRF policy refusal and a missing brand.json.

The SDK keeps those wire codes and the generated enum metadata unchanged.
`AgentResolverError.recovery` provides local cause-aware recovery, and webhook
verification uses it to choose `WebhookSignatureError.retryable`. SSRF policy
refusals and HTTP 4xx (including 401, 403, 404, 408, 410, and 429) are terminal. DNS
failures, timeouts, resets, and HTTP 5xx retain transient recovery. Error details
carry only coarse `dns_error` and `http_status`, never resolved addresses or
transport error messages. DNS errors wrapped by the SSRF fetch boundary remain
network failures rather than policy refusals.

A matching protocol change should add cause-aware metadata for these two codes
in `static/schemas/source/enums/request-signing-error-code.json` and the signing
discovery section of `docs/building/implementation/security.mdx`. Suggested
normative rule: consult structured cause overrides before the code's fallback
recovery; use terminal recovery for `dns_error: ssrf_refused` or `http_status`
in the range 400–499. All other causes retain the existing transient fallback.
Update discovery and webhook-verifier vectors for private addresses, HTTP 4xx,
DNS failure, timeout, and HTTP 5xx. This proposal is prepared for the companion
spec change; no upstream issue or PR has been filed by this SDK change.

This change covers capabilities and brand.json discovery. JWKS HTTP recovery
retains its existing protocol rule; changing that rule is outside issue #3109.
