---
'@adcp/sdk': patch
---

Wire up `examples/hello-cluster.ts` to boot all 7 hello-adapter specialisms + multi-tenant. Closes #1461 (final sub-issue of #1381 hello-adapter-family completion).

Cluster manifest now lists 8 live entries (signals 3001, creative-template 3002, sales-social 3003, sales-guaranteed 3004, sales-non-guaranteed 3005, creative-ad-server 3006, sponsored-intelligence 3007, multi-tenant 3008) plus 3 pending placeholders (governance / brand-rights / retail-media — auto-skipped until those examples land). Universal `/_debug/traffic` probe replaces per-specialism lookup paths; every mock-server already exposes it. `npm run hello-cluster` boots 8 adapters in ~2.2s with mocks running.

Skill prose collapsed onto fork-target pointers per the #1385 collapse pattern:

- `skills/build-seller-agent/specialisms/sales-non-guaranteed.md` reduced from 41 → 17 lines; inline code samples removed (the worked adapter is the canonical reference).
- `skills/build-creative-agent/SKILL.md` § creative-ad-server reduced from ~100 → ~25 lines; same shape.

Closes #1381 with all five sub-issues (#1457, #1458, #1459, #1460, #1461) merged.
