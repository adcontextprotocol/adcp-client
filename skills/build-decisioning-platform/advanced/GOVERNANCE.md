# Campaign governance specialism

If you claim `governance-spend-authority` or `governance-delivery-monitor`, implement `CampaignGovernancePlatform`. Buyers call governance tools to delegate spending authority, monitor delivery against caps, and revoke authority when caps are breached.

```ts
class MyPlatform implements DecisioningPlatform {
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'governance-spend-authority'] as const,
    ...
  };

  campaignGovernance: CampaignGovernancePlatform = {
    grantSpendAuthority: async (req, ctx) => { /* mint a JWS */ },
    revokeSpendAuthority: async (req, ctx) => { /* revoke + emit status change */ },
    getDeliveryAttestation: async (req, ctx) => { /* aggregate delivery vs cap */ },
  };
}
```

Framework owns JWS verification on inbound `governance_context` tokens; you receive `ctx.state.governanceContext()` already verified, plan-bound, and seller-bound.

Throw `GovernanceDeniedError` for revoked authority, `ComplianceUnsatisfiedError` for delivery cap breaches.

See `REFERENCE.md` for the full governance section.
