---
---

docs(mock-server): link two adopter surfaces to the upstream `spec → mock → SDK` triage anchor

Doc-only change. CLAUDE.md and the lifecycle-state proposal already point at [adcontextprotocol.org/docs/building/verification/conformance#mock-server-authority-and-failure-triage](https://adcontextprotocol.org/docs/building/verification/conformance#mock-server-authority-and-failure-triage); this PR closes the remaining adopter-facing surfaces:

- `docs/proposals/lifecycle-state-and-sandbox-authority.md` — second "cross-language referee" mention now carries the spec link inline so readers don't have to scroll
- `docs/guides/VALIDATE-YOUR-AGENT.md` — callout on the fork-matrix compliance gate explaining the mock-server IS the reference implementation
- `skills/triage-storyboard-failure/SKILL.md` — agent-facing rubric now cites the upstream anchor in its overview, so future agents loading the skill on a grader rejection get the normative URL on the first hop

Closes adcp-client#1524. Refs [adcp#4029](https://github.com/adcontextprotocol/adcp/issues/4029).
