---
'@adcp/sdk': minor
---

Add `resolveAgent`, `getAgentJwks`, `createAgentJwksSet`, and the `adcp resolve` CLI — bootstrap from an agent URL to its signing keys via the 8-step `identity.brand_json_url` discovery chain defined in security.mdx (added by spec PR adcontextprotocol/adcp#3690).

```ts
import { resolveAgent, createAgentJwksSet } from '@adcp/sdk/signing/server';

// Full chain + per-step trace.
const r = await resolveAgent('https://buyer.example.com/mcp');
// r.agentUrl, r.brandJsonUrl, r.agentEntry, r.jwksUri, r.jwks,
// r.identityPosture, r.consistency, r.freshness, r.trace

// JOSE adapter — required allowedAlgs at construction time + verify time
// (defense-in-depth against alg-confusion).
const getKey = createAgentJwksSet('https://buyer.example.com/mcp', {
  allowedAlgs: ['EdDSA', 'ES256'],
});
await jwtVerify(jwt, getKey, { algorithms: ['EdDSA', 'ES256'] });
```

CLI: `npx @adcp/sdk resolve <agent-url> [--json] [--quiet]` — prints which step rejected when triaging `request_signature_brand_*` failures.

The implementation:

- Steps 1 (capabilities) goes through `ProtocolClient` (`createMCPClient` / `createA2AClient`) — never a raw HTTP `GET` against the agent URL.
- Steps 4 / 8 (brand.json / JWKS) go through `ssrfSafeFetch` with no redirects, body caps (256 KiB / 64 KiB), and a strict-JSON parser that rejects duplicate keys + `__proto__` / `constructor` pollution.
- Step 3 eTLD+1 binding uses a pinned PSL via `tldts` with ICANN+PRIVATE both in scope (so `vercel.app` is treated as a suffix). Runtime PSL fetches are explicitly disabled.
- All wire-shape rejections surface as `AgentResolverError` with a `request_signature_*` code. The 9 spec-defined codes (`brand_json_url_missing`, `capabilities_unreachable`, `brand_json_unreachable`, `brand_json_malformed`, `brand_origin_mismatch`, `agent_not_in_brand_json`, `brand_json_ambiguous`, `key_origin_mismatch`, `key_origin_missing`) are joined by two SDK-side codes (`jwks_unreachable`, `jwks_alg_disallowed`) for distinct trust failures the spec hands to the verifier checklist post-bootstrap. Counterparty-controlled detail fields (`brand_json_url`, `jwks_uri`, `matched_entries[]`, `parse_error`) carry the `[ATTACKER_INFLUENCED]` symbol marker so admin-UI rendering downstream can detect and HTML-escape; SSRF refusals translate to a coarse `dns_error` classification rather than leaking the resolved IP.
- `allowPrivateIp: true` is gated by `NODE_ENV in {test, development}` plus an explicit `ADCP_RESOLVER_ALLOW_PRIVATE_IP=1` ack, matching the existing pattern around `createAdcpServer`'s in-memory state — a security-critical entry point should fail closed when the carve-out gets wired from a misconfigured env var.
- The field is forward-compat: 3.0-conformant operators can populate `identity.brand_json_url` today (the schema bump lands in 3.x's next minor; this SDK reads the field via a narrow accessor that codegen will catch up to on the next schema pin). No version bump required to adopt.

**Schema pin: 3.0.4 → 3.0.5.** Picks up the `identity.additionalProperties: true` relaxation (upstream changeset `a4bd513`) so a 3.0-pinned seller emitting `identity.brand_json_url` on its `get_adcp_capabilities` response passes our strict response-validation gate. Without 3.0.5, the spec's "3.0 implementers can adopt the field today" narrative would have contradicted the SDK's default validator. Test `test/agent-resolver-publisher-side.test.js` asserts the publisher-side path; would have failed on 3.0.4 and earlier.

Closes #1268.
