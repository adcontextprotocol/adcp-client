---
'@adcp/sdk': patch
---

Pick the most constrained legacy format ref when a legacy-format seller lists more than one for a canonical creative's kind.

`projectCreativeForDelivery` used to throw `the seller advertised N legacy refs for canonical kind ...` whenever several legacy refs of the creative's kind survived the package-level filters, even when the creative's own `format_parameters` named exactly one size. Sellers that list two spellings of one slot (`display_html` carrying width and height next to `display_300x250_html`) therefore rejected every create_media_buy that carried a canonical creative. Candidates are now narrowed by the creative's `format_parameters`, refs that pin those dimensions win over refs that leave them open, and among refs imposing identical constraints the legacy id whose own registry declaration pins that size wins over a generic parametrized id. Refs that still differ in their constraints for a creative that declares none keep failing closed.
