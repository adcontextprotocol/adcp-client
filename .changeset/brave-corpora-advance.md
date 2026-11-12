---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.1.33 and 3.2.10 compliance corpora, so `--compliance-version 3.1.33` and `--compliance-version 3.2.10` resolve to packaged storyboards. Hosted grading already uses both releases; on SDK 16.7.0 neither could be selected.

Both bundles are synced through the ordinary signature-required route from the official origin (`ADCP_REQUIRE_SIGNATURE=1`), with no mirror, trust or custom-bundle override. Their checksums match the published `.sha256` sidecars and the GitHub release assets, and `cosign verify-blob` passes against the repository's identity gate (`release.yml` on `refs/heads/3.1.x` and `refs/heads/3.2.x`).

Each new release advances its line in place, as every earlier patch adoption on 16.x did:

- The primary pin moves from AdCP 3.2.8 to 3.2.10 (`ADCP_VERSION`, generated types and provenance, canonical `principal` and `reporting-core` fixtures, the `latest` pointer).
- The maintained 3.1 slot moves from 3.1.32 to 3.1.33. The retained 3.1.30 corpus stays packaged, because it still runs storyboards that later 3.1 corpora gate behind the `collect_product_pages_runner` requirement, which SDK 16 does not implement.

This package therefore ships compliance corpora for 3.0.25, 3.1.30, 3.1.33 and 3.2.10, and no longer ships 3.1.32 or 3.2.8. Update explicit `--compliance-version 3.1.32` flags to `3.1.33` and `--compliance-version 3.2.8` flags to `3.2.10`, or keep SDK 16.7.0 for those exact corpora. `COMPATIBLE_ADCP_VERSIONS` gains `3.1.33`, `3.2.9` and `3.2.10`.

The schema trees differ from 3.1.32 and 3.2.8 only in release identifiers and `lastUpdated` dates; there are no structural validation-rule changes, and regenerated public types change only their provenance comments. The changes are in the compliance storyboards. For example, `media_buy_seller/product_signal_targeting` now selects agents through `requires_all_capabilities` — both `media_buy.buying_modes` and `signals.discovery_modes` must contain `wholesale` — instead of every agent that declares `signals.discovery_modes`.
