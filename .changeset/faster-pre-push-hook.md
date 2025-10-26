---
"@adcp/client": patch
---

Optimize pre-push git hook for faster development workflow

- Reduced pre-push hook execution time from 5+ minutes to ~2-5 seconds
- Now only runs essential fast checks: TypeScript typecheck + library build
- Removed slow operations: schema sync, full test suite
- Full validation (tests, schemas) still runs in GitHub Actions CI
- Makes git push much faster while catching TypeScript and build errors early
