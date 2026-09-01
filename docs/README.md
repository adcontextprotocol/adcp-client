# @adcp/sdk documentation

Choose the path that matches what you are doing. SDK 14 and AdCP 3.2 use the
compact media-buy lifecycle by default; the older
`get_products` → `create_media_buy` lifecycle is a compatibility surface.

## Build a seller

Start with the [15-minute AdCP 3.2 seller](./guides/SELLER-QUICKSTART-3.2.md),
then use [Build an agent](./guides/BUILD-AN-AGENT.md) for accounts,
authentication, capabilities, async work, and conformance. The compact starter
is under 200 lines; the larger files in [`examples/`](../examples/README.md)
are advanced adapters and certification fixtures.

Canonical seller lifecycle:

```text
list_products → buy_products → control_media_buy
             ↘ request_proposals → refine_proposals → accept_proposal
```

## Call a seller

Use the [buyer quick start](./guides/BUYER-QUICKSTART-3.2.md). For the complete
tool and type inventory, use [llms.txt](./llms.txt) and the
[type summary](./TYPE-SUMMARY.md).

## Upgrade from SDK 13

Follow the [13-to-14 migration guide](./migration-13-to-14.md). The
[AdCP 3.1-to-3.2 proposal guide](./migration-adcp-3.1-to-3.2-proposals.md)
covers lifecycle migration specifically. Compatibility internals and explicit
loss reporting are documented in
[Media-buy 3.2 compatibility](./guides/MEDIA-BUY-3.2-COMPATIBILITY.md).

## Run in production

Use [Production durability](./guides/PRODUCTION-DURABILITY.md) as the checklist.
It points to the supported PostgreSQL webhook runtime, task-settlement intent
workflow, request signing, secret-handling rules, and conformance runner.

## Reference

- [CLI](./CLI.md)
- [Zod schemas](./ZOD-SCHEMAS.md)
- [Request and webhook signing](./guides/SIGNING-GUIDE.md)
- [Conformance](./guides/CONFORMANCE.md)
- [All examples](../examples/README.md)
- [AdCP specification](https://adcontextprotocol.org)
