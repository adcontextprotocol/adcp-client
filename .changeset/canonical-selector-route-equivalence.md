---
'@adcp/sdk': patch
---

Fix canonical-format storyboard grading to resolve every supplied format selector route independently before applying precedence (#3454). Co-present product references, legacy format IDs and direct canonical selectors must select identical product-option sets; unresolved or conflicting secondary routes now correctly satisfy authored negative cases instead of being ignored.
