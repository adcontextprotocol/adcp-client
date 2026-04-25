---
'@adcp/client': patch
---

**Add request signing guide (`docs/guides/SIGNING-GUIDE.md`).** End-to-end RFC 9421 walkthrough: key generation, JWKS publication, brand.json discovery, buyer-side signing via `createAgentSignedFetch`, seller-side verification via `requireAuthenticatedOrSigned` + `mcpToolNameResolver`, capability declaration on `request_signing`, key rotation, conformance vectors, and the full `request_signature_*` error code table cross-referenced against `compliance/cache/3.0.0/test-vectors/request-signing/`. README and `BUILD-AN-AGENT.md` cross-link to the new guide; the inline Request Signing snippet in `BUILD-AN-AGENT.md` is updated to match.

**Widen `mcpToolNameResolver` parameter type.** Previously typed against `IncomingMessage & { rawBody?: string }`, which prevented passing it as `resolveOperation` on `createExpressVerifier` (`ExpressLike` request type). The function only reads `req.rawBody`, so the parameter is now typed as `{ rawBody?: string }` — both call sites typecheck without casts. No runtime change.
