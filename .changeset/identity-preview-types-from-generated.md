---
'@adcp/sdk': patch
---

Keep the experimental AdCP 3.3 identity preview types compatible with newer generated schemas. `CanonicalCreateMediaBuyInput.reporting_webhook.authentication` is now optional even with a caller-supplied `url`, matching AdCP 3.3 where sellers that sign webhooks under their profile accept registrations without it; below 3.3 the client still refuses a caller URL without credentials at runtime when `webhookUrlTemplate` is configured. `AgentOnboarding`, `AgentOnboardingTier`, `AgentOnboardingRequirement` and their mode/kind aliases now derive from the generated `get_adcp_capabilities` types whenever the pinned schemas define `account.agent_onboarding`, falling back to the hand-written draft otherwise. `evaluateOnboardingRequirements` accepts requirements with unknown kinds (`ObservedAgentOnboardingRequirement`) and returns the caller's requirement type.
