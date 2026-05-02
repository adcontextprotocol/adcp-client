---
"@adcp/sdk": patch
---

Rename `examples/hello_seller_adapter_*.ts` reference adapters by AdCP role to fix two miscategorizations: signal-marketplace agents are signals/data agents (not sellers — they don't sell media), and creative-template agents are stateless transforms (no inventory). New names:

- `hello_seller_adapter_signal_marketplace.ts` → `hello_signals_adapter_marketplace.ts`
- `hello_seller_adapter_creative_template.ts` → `hello_creative_adapter_template.ts`
- `hello_seller_adapter_sales_social.ts` (unchanged — actually a seller)
- `hello_seller_adapter_sales_guaranteed.ts` (unchanged — actually a seller)

The naming convention is now `hello_<role>_adapter_<specialism>.ts` where `<role>` matches the AdCP protocol layer the adapter operates on (`seller` for `media-buy`, `signals` for `signals`, `creative` for `creative`, etc.). Test files and changeset references rewritten correspondingly. Aspirational `hello-cluster.ts` entrypoints for governance / brand / additional creative variants updated to follow the same convention so future adapters land at the right path. No behavioral change.
