const CREDENTIAL_IN_ARGS_LEGACY_AUTH_PROSE =
  'Distinct from `AUTH_REQUIRED` (no credentials presented or presented credentials rejected on the transport channel)';

const CREDENTIAL_IN_ARGS_SPLIT_AUTH_PROSE =
  'Distinct from `AUTH_MISSING` (no credentials presented on the transport channel) and `AUTH_INVALID` (credentials presented but rejected on the transport channel)';

const AUTH_INVALID_BETA_EXCEPTION_PROSE =
  "Credentials were presented but rejected — revoked, malformed signature, or a key no longer in the seller's keystore. Sellers MUST return this code when an `Authorization` header was present but verification failed. Exception: agents with a valid OAuth 2.1 refresh grant MAY treat this as correctable when the rejection reason is token expiry — silently refresh and retry once; if the refresh fails or the seller explicitly signals revocation, escalate to human.";

const AUTH_INVALID_SDK_PROSE =
  "Credentials were presented but rejected — revoked, expired, malformed signature, or a key no longer in the seller's keystore. Sellers MUST return this code when an `Authorization` header was present but verification failed. SDK server runtime treats this code as terminal and does not refresh or retry it; use `AUTH_MISSING` / legacy `AUTH_REQUIRED` for missing request credentials that can be refreshed via `AccountStore.refreshToken`.";

/**
 * SDK-side prose overlays for bundled beta manifests whose normative schema
 * shape is usable but whose explanatory text predates SDK compatibility work.
 * Fail loudly when an expected upstream sentence moves so the generated docs
 * never silently lose the compatibility patch.
 */
export function applySdkErrorCodeProseOverlay(code: string, description: string): string {
  if (code === 'AUTH_INVALID') {
    if (description.includes(AUTH_INVALID_SDK_PROSE)) return description;
    if (!description.includes(AUTH_INVALID_BETA_EXCEPTION_PROSE)) {
      throw new Error(
        'AUTH_INVALID prose overlay no longer matches the bundled manifest. ' +
          'Review the upstream description and update scripts/lib/error-code-prose-overlays.ts.'
      );
    }
    return description.replace(AUTH_INVALID_BETA_EXCEPTION_PROSE, AUTH_INVALID_SDK_PROSE);
  }

  if (code === 'CREDENTIAL_IN_ARGS') {
    if (description.includes(CREDENTIAL_IN_ARGS_SPLIT_AUTH_PROSE)) return description;
    if (!description.includes(CREDENTIAL_IN_ARGS_LEGACY_AUTH_PROSE)) {
      throw new Error(
        'CREDENTIAL_IN_ARGS prose overlay no longer matches the bundled manifest. ' +
          'Review the upstream description and update scripts/lib/error-code-prose-overlays.ts.'
      );
    }
    return description.replace(CREDENTIAL_IN_ARGS_LEGACY_AUTH_PROSE, CREDENTIAL_IN_ARGS_SPLIT_AUTH_PROSE);
  }

  return description;
}
