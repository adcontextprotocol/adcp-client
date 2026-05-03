---
"@adcp/sdk": minor
---

mock-server/sales-guaranteed: add forecast endpoints and hello_seller_adapter_guaranteed example

Adds `POST /v1/forecast` to the sales-guaranteed mock server and extends `GET /v1/products` to accept `?start_date=&end_date=` query params that populate a deterministic `DeliveryForecast` on each product. Both paths use a `createHash`-based seed so storyboard runners get reproducible numbers.

Also adds `examples/hello_seller_adapter_guaranteed.ts` — a worked GAM-style seller adapter that calls the enriched `GET /v1/products` endpoint and maps the inline forecast onto `Product.forecast`, exercising the `AdCP Product.forecast` field that was previously never populated in any example.
