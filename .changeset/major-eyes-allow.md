---
'@adcp/client': minor
---

Catch stale CLI installs before users spend hours debugging phantom behavior.

- **Docs:** pin `@latest` in every documented `npx @adcp/client` invocation. Unpinned `npx` reuses whatever version is cached in `~/.npm/_npx/` — users can have six different versions co-existing and not know which one runs. `@latest` forces npx to re-resolve against the registry each invocation.
- **CLI:** add a startup staleness check. On every run, the CLI hits `registry.npmjs.org/@adcp/client/latest` (cached for 24h at `~/.adcp/version-check.json`, 800ms timeout, fire-and-forget) and prints a one-time stderr warning if the running version is behind the published latest. Catches every stale-install path, not just the npx copy-paste one: global installs, pinned `package.json`, corporate forks, `pnpm dlx` caches.
- **Silenced in:** CI (`CI=true`), non-TTY stderr, `--json` mode, and `ADCP_SKIP_VERSION_CHECK=1`.
