---
'@adcp/client': minor
---

Governance: remove non-spec `'escalated'` status to align with AdCP v3.

AdCP v3 governance has three terminal `check_governance` statuses: `'approved' | 'denied' | 'conditions'`. `CheckGovernanceResponseSchema` already validates to this set, but the SDK core carried `'escalated'` as a fourth status from a pre-v3 model. Spec-compliant governance agents cannot emit it, so the code path was dead under validation and misrepresented the protocol to consumers branching on `govResult.status`.

Human review is modelled in v3 as a workflow on `denied` (governance agent denies with a critical-severity finding that says human review is required; the buyer resolves review off-protocol and calls `check_governance` again with the human's approval), not as a fourth terminal status.

Changes:
- `GovernanceCheckResult.status` narrows to `'approved' | 'denied' | 'conditions'`.
- `TaskStatus` drops `'governance-escalated'`; failing governance checks surface as `'governance-denied'`.
- `TaskResultFailure.status` narrows to `'failed' | 'governance-denied'`.
- `GovernanceMiddleware` drops the `'escalated'` branch in `checkProposed`.
- `TaskExecutor.buildGovernanceResult` signature no longer takes a status parameter.
- Test-scenario validator for `check_governance` rejects `'escalated'` as an unexpected status.

Migration: if you branch on `result.status === 'governance-escalated'` or `govResult.status === 'escalated'`, fold those branches into the `'governance-denied'` / `'denied'` paths. Inspect `governance.findings` for human-review signals if you need to distinguish the reason.

Fixes #589.
