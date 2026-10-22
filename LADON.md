## Repo Context

`adcontextprotocol/adcp-client` is the official TypeScript SDK + CLI for the Ad
Context Protocol, published as `@adcp/sdk`. Stack: TypeScript (ESM), generated
types under `src/lib/types/*.generated.ts`, published via Changesets. The SDK is
a **witness, not a translator**: it returns exactly what upstream AdCP agents
send. Reviews weigh wire-shape fidelity, changeset correctness, and
official-client usage above style.

### Mandatory: witness-not-translator

Any code path that injects mock/fallback data, fabricates fields upstream did not
return, silently normalizes wire shapes, inflates flat responses, or substitutes
placeholders is a `critical`/`high` finding. Re-shaping at a seam is the same bug
as fabrication.

Exception: version translation between AdCP releases (adcontextprotocol/adcp
DR-0032), implemented in `src/lib/adapters/version/` and the server tool
handler. It is in bounds when every removed or moved field is reported
(`debug_logs` drift entries on the client, `onVersionTranslation` and logs on
the server), moves follow an exact older equivalent, and mutations refuse
rather than drop anything that changes what the seller commits to. A
translation step that drops or rewrites without reporting is still `high`.

### Mandatory: every 3.x wire change has a pathway back

Per adcontextprotocol/adcp DR-0033, a PR that adds or changes support for a
3.x wire field, enum value, task, union variant or semantic rule must also
handle it for the previous minor release. Pick one:

- **Droppable:** the schema projection removes it with no code. For a
  mutating request, confirm dropping does not change spend, targeting, caps or
  account identity; if it does, it must be refused.
- **Moves:** a `VersionAdapter` under `src/lib/adapters/version/<older>/`.
  Implement `adaptRequest`/`adaptResponse` for the client and
  `upgradeRequest`/`downgradeResponse` for the server where both directions
  exist.
- **Refused:** the call fails before sending with `ProtocolFeatureUnsupportedError`.
- **Identity-bearing:** goes through the account-key reduction rules in
  `src/lib/core/account-reduction.ts`.

The PR needs a test for its pathway in `test/lib/version-translation.test.js`
or `test/server-version-translation.test.js`. Missing pathway handling or a
missing test is `high`. A mutation-side field that is dropped when it should
be refused is `high`.

### Mandatory: official transport clients only

New code under `src/lib/protocols/` or `src/lib/client/` that reimplements HTTP or
SSE instead of using `@a2a-js/sdk` / `@modelcontextprotocol/sdk` is a `high`
finding unless the PR body justifies why the official client cannot serve it.

### Mandatory: changeset-vs-wire-impact

When the diff touches `src/lib/**` (excluding `*.generated.ts`), `bin/**`,
build-affecting `scripts/**`, or any `package.json` `files` path: a missing
`.changeset/*.md` is a `high` finding; a changeset whose type understates impact
(e.g. `patch` shipping a removed/renamed export, required-param flip, dropped enum
value, or response-shape change) is a `high` finding. A hand-edited
`package.json` `version` line is a `high` finding.

### Mandatory: doc-link integrity

Stale `blob/main/` or `tree/main/` links after a doc rename (enforced by
`ci:doc-links`) are a `medium` finding; adding to `EXEMPT_PATHS` to silence the
check is a smell — call it out.

## High-Risk Paths

- src/lib/protocols/**
- src/lib/auth/**
- src/lib/adapters/legacy/**
- src/lib/types/v*-*/**
- schemas/registry/**
- bin/**

## Escalation Reviewers

- bokelley

## Trivial Paths

- .changeset/**
- **/*.md
- **/*.mdx
- docs/**
- schemas/cache/**
- **/*.generated.ts
- package-lock.json
