---
'@adcp/sdk': patch
---

Keep the experimental AdCP 3.3 identity preview types compatible with newer generated schemas.

- `CanonicalCreateMediaBuyInput.reporting_webhook.authentication` is now optional even with a caller-supplied `url`. This matches AdCP 3.3, where a seller that signs webhooks under its profile accepts a registration without it. Below 3.3, with `webhookUrlTemplate` configured, the client still refuses a caller URL that has no credentials and now says why. On 3.3 a caller URL is registered under its URL-scoped id instead of the client's monthly delivery operation id, so buys in the same month with different caller URLs no longer collide.
- `AgentOnboarding`, `AgentOnboardingTier`, `AgentOnboardingRequirement` and the mode/kind aliases (`@adcp/sdk/identity-3.3`) now derive from the generated `get_adcp_capabilities` types whenever the pinned schemas define `account.agent_onboarding`, and fall back to the hand-written draft otherwise. Two experimental type narrowings: `AgentOnboardingRequirement.kind` no longer accepts arbitrary strings, and `BuyerOnboardingPosture.requirements` items are now `ObservedAgentOnboardingRequirement`, whose arrays are `readonly`.
- `evaluateOnboardingRequirements` is now generic over `ObservedAgentOnboardingRequirement`, so requirements with unknown kinds are still accepted and still evaluate as unsatisfied. It returns the caller's requirement type and also reads the revised `verified_specialisms` name.
