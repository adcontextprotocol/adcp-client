---
"@adcp/client": minor
---

feat(server): PostgresTaskStore.createTask accepts optional caller-supplied taskId

Compliance storyboard controller scenarios (`force_create_media_buy_arm`,
`force_task_completion`) need to inject buyer-supplied task IDs for storyboard
determinism. `PostgresTaskStore.createTask` now accepts an optional `taskId`
field on its first argument: when supplied, the ID is used verbatim; when
omitted, a random hex ID is generated as before. Throws with a descriptive
message if the supplied ID already exists (detected via PG uniqueness
constraint, not a pre-check race).
