---
'@adcp/sdk': patch
---

Enforce the AdCP nonce alphabet and 16-byte minimum in request and RFC 9421 webhook verification. Reject invalid nonces before key resolution or replay insertion. After authenticating a frame and its body digest, record its nonce before rejecting malformed JSON, so repeated malformed frames stop at replay detection without repeating cryptographic verification. Malformed request bodies now report checklist step 14 instead of step 11. The shared body check refuses invalid UTF-8 and leading BOMs to avoid parser disagreements. Webhook verification now reports `webhook_body_malformed` at checklist step 14. Preserve operation-resolution prechecks, unsigned-request policy, and rejection of invalid signatures or digests before replay insertion.

Signers overriding `nonce` must supply at least 16 random bytes encoded as unpadded Base64URL; padded or standard-alphabet Base64 now produces `*_signature_params_incomplete`. Consumers handling `WebhookSignatureErrorCode` exhaustively must add `webhook_body_malformed`.
