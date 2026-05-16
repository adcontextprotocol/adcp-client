---
'@adcp/sdk': patch
---

docs: align bridge framing with revised single-dimension certification model

Maintainer walked back the two-badge "proxy-seller vs state-local-seller" split from #1782 and proposed a single-dimension "Wire Conformance / Live Integration Verified" framing instead — every seller faces the same verifiability gap; the bridge is one of two mechanisms for closing the seed→read loop, not a special path for one seller class. This change folds the revised framing back into the JSDoc on `AdcpServerConfig.testController` and into `skills/build-seller-agent/SKILL.md`.

JSDoc (`src/lib/server/create-adcp-server.ts`):

- Removed the "only upstream-proxy sellers" framing as primary. Now reads as "pick by where your read handlers fetch from, not by seller class": handler reads from a store you control → don't wire the bridge; handler reads from a system you don't control → wire it.
- Replaced the implicit "proxy sellers are a category" prose with "either path earns wire-conformance credit; it is *not* a separate certification category" — matches the unified framing.
- Cross-links unchanged.

Seller-agent skill (`skills/build-seller-agent/SKILL.md`):

- New "Test surfaces — making your agent verifiable without live credentials" section between "Validate locally" and "Deployment."
- Frames the verifiability gap as universal, names the two implementations (state-local store vs `TestControllerBridge`), explains the decision rule, and hedges on certification names while the badge model in #1782 settles.
- Calls out the `_bridge` marker's narrowed role: it tracks fixture-vs-upstream provenance per step, feeding live-integration eligibility, but is not itself a seller-class marker.

No SDK behavior change. The marker contract from #1786, the JSDoc trust-boundary section from #1787, and the construction-time dual-emit warn from #1788 all stay as-is — they correctly describe mechanism without committing to a certification taxonomy.
