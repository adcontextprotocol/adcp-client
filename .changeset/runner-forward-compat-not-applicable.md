---
"@adcp/sdk": patch
---

fix(storyboard): grade unrecognized check kinds as not_applicable for forward compatibility

Replaces the hard-fail `default` case in the validation dispatcher with a
`not_applicable` pass so storyboards authored against a newer spec version
don't hard-fail on older runners. Adds `ValidationResult.not_applicable` flag
and `StoryboardResult.validations_not_applicable` counter so consumers can
distinguish "runner is older than the storyboard" from a clean pass.
Per runner-output-contract.yaml v2.0.0 (adcp#3816). Refs #1253.
