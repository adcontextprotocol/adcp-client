---
"@adcp/sdk": patch
---

Rename `examples/hello_*_adapter_*.ts` reference adapters by AdCP role and strip redundant family prefixes. Two motivations: (1) signal-marketplace agents are signals/data agents (not sellers — they don't sell media), and creative-template agents are stateless transforms (no inventory); the inherited `hello_seller_adapter_` prefix was wrong for both. (2) The specialism portion was redundant when the role already implies the family — `hello_creative_adapter_creative_template.ts` repeats `creative` twice; same for the sales variants.

New convention: `hello_<role>_adapter_<specialism>.ts` where `<specialism>` is the part of the specialism name AFTER the family-implied prefix is stripped. Concretely:

| Before | After |
| --- | --- |
| `hello_seller_adapter_signal_marketplace.ts` | `hello_signals_adapter_marketplace.ts` |
| `hello_seller_adapter_creative_template.ts` | `hello_creative_adapter_template.ts` |
| `hello_seller_adapter_sales_social.ts` | `hello_seller_adapter_social.ts` |
| `hello_seller_adapter_sales_guaranteed.ts` | `hello_seller_adapter_guaranteed.ts` |

Roles map to AdCP protocol layers: `seller` for `media-buy`, `creative` for `creative`, `signals` for `signals`, with `governance` / `brand` reserved for the corresponding agent kinds. Test files, changesets, and cross-references in `docs/`, `skills/`, `examples/hello-cluster.ts`, and `scripts/` rewritten correspondingly. Aspirational `hello-cluster.ts` entrypoints for adapters not yet shipped (governance, brand, additional creative variants, sales-non-guaranteed) updated to follow the same convention so future PRs land at the right path. No behavioral change.
