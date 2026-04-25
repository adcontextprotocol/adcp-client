---
"@adcp/client": minor
---

Cross-domain specialism-declaration runtime check on `createAdcpServer`.

When a domain handler group (`creative`, `signals`, `brandRights`) is wired but `capabilities.specialisms` doesn't include any of that domain's specialisms, `createAdcpServer` now logs an error via the configured logger:

```
createAdcpServer: creative handlers are wired but capabilities.specialisms
does not include any creative specialism. Add at least one of
'creative-ad-server', 'creative-generative', 'creative-template' to
capabilities.specialisms — without it, the conformance runner reports
"No applicable tracks found" and the agent grades as failing despite
working tools.
```

The matrix v18 run (issue #785) had this drift class account for ~30% of "agent built every tool but storyboard reports no applicable tracks" cases. The conformance runner gates tracks on the `capabilities.specialisms` claim, so an agent with working tools but no claim grades as failing silently.

Logged via `logger.error` (matching the idempotency-disabled precedent) rather than thrown — middleware-only test harnesses legitimately wire handlers without declaring specialisms, and a hard throw would create more friction than it removes. Production agents will see the warning in boot logs and conformance failure in the matrix.

`mediaBuy` is intentionally exempt from the check. Its specialism choices (sales-non-guaranteed vs sales-guaranteed vs sales-broadcast-tv vs sales-social etc.) are commercially significant and an agent may legitimately defer the declaration to a follow-up. The `build-seller-agent` skill cross-cutting pitfalls section already covers the right declaration.

Tests in `test/server-create-adcp-server.test.js` lock the new behavior:
- Throws-equivalent: error logged when handlers wired without specialism
- No-error: handlers + matching specialism aligned
- No-error: no domain handlers wired
- No-error: mediaBuy without specialism (commercial-significance carve-out)

This is dx-expert priority #5 from the matrix-v18 review (CI defenses #1–#4 shipped in #945, #957, #961, #970). With this, the cheap-CI-defense ladder is complete.
