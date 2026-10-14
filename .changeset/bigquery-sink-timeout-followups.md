---
'@adcp/sdk': patch
---

Two follow-ups to the BigQuery warehouse sink convergence fix (#3239), from a live run. Deadline and timeout errors now name the table (role `rows` or `revisions`, and its table ID), the deadline in force and that table's own timeout count, so a deadline that differs between the two tables is no longer confusing; they never include file paths or credentials. A rerun in the same process now waits, within its own deadline, for any still-pending upload of the same deterministic job ID instead of replacing it once its age exceeds the run's deadline (that age included the pause between runs, so a 12 MB file was uploaded twice before BigQuery refused the duplicate with 409). Only an upload still pending after 6 hours (`MAX_LOAD_TIMEOUT`, the largest deadline) is abandoned and replaced, so a hung upload cannot block forever. A run whose deadline expires while waiting on a reused upload counts as a timeout, so the deadline still grows.
