---
'@adcp/sdk': patch
---

ES256 request, webhook and Web Bot Auth signatures now sign and verify on Cloudflare workerd (#3243). The asynchronous verifiers and signers (`verifyRequestSignature`, `verifyWebhookSignature`, `verifyWebBotAuth`, `signRequestAsync`/`InMemorySigningProvider`, `signWebBotAuth`) use WebCrypto `crypto.subtle` for ECDSA P-256 when the runtime provides it. Synchronous paths, and runtimes without WebCrypto, use node:crypto and fall back to passing the key as a JWK where the runtime rejects a `KeyObject` inside the options object, as workerd does; there every valid ES256 signature failed. Ed25519 already worked on current workerd and keeps node:crypto. `verifySignatureAsync` is exported from `@adcp/sdk/signing/server` for custom verifiers on edge runtimes. A test using the `workerd` binary (skipped where it is unavailable) runs the RFC 9421 vectors and both signing profiles inside workerd.
