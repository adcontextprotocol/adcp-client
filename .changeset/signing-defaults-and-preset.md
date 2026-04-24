---
"@adcp/client": minor
---

Four ergonomic upgrades to the RFC 9421 signing surface — all backwards compatible, all opt-in via omission:

- **`verifySignatureAsAuthenticator`** now defaults `replayStore` and `revocationStore` to fresh `InMemoryReplayStore` / `InMemoryRevocationStore` instances when omitted. Every authenticator instance gets its own default stores (no cross-talk). Wire explicit stores in multi-replica deployments where replay state must be shared.
- **`createExpressVerifier`** gets the same defaults — symmetric with `verifySignatureAsAuthenticator` so both the `serve()` and raw-Express paths have identical ergonomics.
- **`buildAgentSigningFetch`** now defaults `upstream` to `globalThis.fetch` when omitted. Throws a clear `TypeError` if `globalThis.fetch` isn't available, rather than binding `undefined` and failing cryptically on first request.
- **`createAgentSignedFetch(options)`** — new preset for the single-seller buyer case. Bundles `buildAgentSigningFetch` with a `CapabilityCache` lookup keyed by the target seller's `agent_uri`. One call replaces the four-object `buildAgentSigningFetch` + `CapabilityCache` + explicit `getCapability` wire-up:

  ```typescript
  // fetch.ts
  export const signedFetch = createAgentSignedFetch({
    signing: { kid, alg: 'ed25519', private_key: privateJwk, agent_url: 'https://agent.example.com' },
    sellerAgentUri: 'https://seller.example.com',
  });
  ```

  For multi-seller adapters, build one preset per seller or drop to `buildAgentSigningFetch` with a URL-dispatching `getCapability`.
