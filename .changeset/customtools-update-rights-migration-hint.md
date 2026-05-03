---
"@adcp/sdk": patch
---

`createAdcpServer` collision-check error now points at the platform handler that supersedes a colliding `customTools` entry (for example, `BrandRightsPlatform.updateRights` for `customTools["update_rights"]`, which was promoted to a framework-registered first-class tool in 6.7.0). The previous "rename the custom tool or remove the handler from the conflicting domain group" advice was misleading for adopters carrying a pre-6.7 customTool registration across the version boundary — the throw surfaces as HTTP 500 HTML on every MCP probe in lazily-built tenant servers, masquerading as a client-side discovery regression. The hint now names the migration so the next adopter who hits this lands on the right fix.

`docs/migration-6.6-to-6.7.md` adds recipe **#16** with the audit recipe (`grep -rn 'customTools.*update_rights'`) and the platform-handler swap, and the breaking-changes preamble now lists this alongside #10 and #11.
