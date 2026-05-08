---
'@adcp/sdk': patch
---

Docs corpus migration: rewrite remaining `createAdcpServer` v5 examples to v6 `createAdcpServerFromPlatform` across `skills/build-seller-agent/`, `skills/build-decisioning-*/`, `docs/guides/BUILD-AN-AGENT.md`, `docs/guides/CONCURRENCY.md`, `docs/guides/CTX-METADATA-SAFETY.md`, `docs/guides/account-resolution.md`, `docs/guides/SIGNING-GUIDE.md`, `docs/guides/VALIDATE-LOCALLY.md`, `docs/guides/VALIDATE-YOUR-AGENT.md`, and `docs/llms.txt`. Closes the corpus drift that left LLM-generated platforms starting from the v5 handler-bag shape despite the v6 surface being GA. Migration guides retain v5 references where the historical context is intentional.
