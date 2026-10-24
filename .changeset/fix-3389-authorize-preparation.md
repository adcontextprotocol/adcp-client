---
'@adcp/sdk': minor
---

Add optional authorization for fresh fixture preparation before seller contact (#3389).

`prepareStoryboardFixtures` accepts `PrepareStoryboardFixturesOptions.prepared_fixtures_preparation_authorizer`. Its new `PreparedFixturesPreparationLookup` carries `gate: 'prepare'` and the SDK-computed proposed `current` scope, with no fabricated stored binding, reference, or seller profile. The callback runs exactly once before client creation, initialization, discovery, controller activity, or catalog reads. Only literal `authorized: true` grants; other decisions throw `PreparedFixturesDeniedError('authorizer_denied')` with zero seller contact and private canonical audit evidence. Authorized dispatch detaches mutable account, brand, credential, route, and storyboard data across awaits; runtime transport and OAuth storage keep their host-owned identity. Scope drift refuses with `binding_mismatch` before fixture calls after discovery and before state can be minted.

This is additive on SDK 16: `PreparedFixturesLookup.binding` remains required, its gate union is unchanged, and `prepared_fixtures_authorizer` remains exclusively the every-lookup reuse hook. Supplying only that existing hook to preparation retains legacy behavior and does not authorize preparation. Hosts requiring the fresh gate must explicitly adopt the new option. A preparation grant never replaces later reuse authorization.

The preparation-only option is rejected before contact on run, step, and compliance entry points. Existing integrations that omit it retain their behavior. Host refusal details are not echoed at the preparation gate; audit sink failures never grant access.
