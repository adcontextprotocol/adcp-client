---
'@adcp/sdk': patch
---

chore: enter changesets pre-mode (tag `beta`) on `main`

Following the accidental GA publish of `8.0.0`, the 8.x line moves into a beta cycle. From this commit forward, every changeset on `main` accumulates into a prerelease (`8.0.1-beta.N` for patch, `8.1.0-beta.N` for minor, `9.0.0-beta.N` for major) and ships under the `@beta` npm dist-tag.

The `latest` dist-tag is moved back to `7.11.0` separately via `npm dist-tag add @adcp/sdk@7.11.0 latest`, so `npm install @adcp/sdk` continues to resolve to the stable `7.x` line.

To exit pre-mode and ship a real GA, run `npx changeset pre exit` on `main` and merge the resulting Release PR.
