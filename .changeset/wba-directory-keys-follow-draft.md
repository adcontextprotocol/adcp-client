---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 identity: `verifyKeyDirectory` and `SignatureDirectoryResolver` now use each Ed25519 key that has a valid signature on the directory response, and ignore every other key and its signatures, as the profile in adcontextprotocol/adcp#7894 requires. draft-ietf-webbotauth-httpsig-protocol-00 Appendix B.1 says the proof matters for a domain-bound identifier, which an AdCP origin is, and the directory draft says in section 5 that clients SHOULD ignore keys without a valid signature.

- **Unsigned keys are ignored.** An Ed25519 key without a valid directory signature no longer refuses the directory with `directory_proof`. A request signed with that key fails as an unknown key (403).
- **Malformed keys are ignored.** An Ed25519 key the runtime cannot import, such as one with no `x` or a 31-byte `x`, no longer refuses the directory with `directory_unsupported_key` (RFC 7517 section 5).
- **Unchanged refusals.** A directory that publishes a private JWK member for any key is still refused, and that check still runs before any key is skipped. A directory with no validly signed Ed25519 key is still a discovery failure.

The Web Bot Auth interop harness pin and the vendored vectors move to adcontextprotocol/adcp#8298 at `f44785a5`.
