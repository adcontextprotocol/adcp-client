---
---

docs: revert #1437 + remove redundant docs/architecture/adcp-stack.md; point readers at the protocol docs

The layered architecture / decision page / version-adaptation / hand-rolled migration content shipped here in #1437 was the wrong target — that material is language-agnostic protocol orientation and belongs on docs.adcontextprotocol.org, not on the @adcp/sdk SDK docs site. The canonical version now lives at /docs/building/sdk-stack and the four sibling pages.

This PR:

1. Reverts #1437 (deletes the four new pages, restores the pre-#1437 callouts in index.md / getting-started.md / guides/BUILD-AN-AGENT.md, removes the changeset).
2. Additionally removes docs/architecture/adcp-stack.md (introduced separately in #1436) — the same content, also redundant with the protocol docs.
3. Adds a single pointer at the top of docs/index.md so SDK readers find the protocol docs for protocol-level orientation.
