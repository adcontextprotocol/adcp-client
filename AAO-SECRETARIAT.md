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
- test/**
- tests/**
- **/*.test.ts
- **/*.spec.ts
- package-lock.json
