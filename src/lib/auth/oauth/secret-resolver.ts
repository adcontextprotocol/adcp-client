/**
 * Secret resolution for OAuth client credentials.
 *
 * Values stored in `AgentOAuthClientCredentials.client_id` /
 * `client_secret` may be either literal strings or env-var references in
 * the form `$ENV:VAR_NAME`. Literal secrets end up on disk in
 * `~/.adcp/config.json` (chmod 600); env-var references stay in the config
 * but the secret itself is pulled from the environment at token-exchange
 * time — the CI path where secrets come from the pipeline and should never
 * hit the filesystem.
 *
 * There is no auto-detection: a value without the `$ENV:` prefix is treated
 * as a literal. The CLI's `--client-secret-env VAR` flag writes the
 * reference form.
 */

const ENV_PREFIX = '$ENV:';

/**
 * Raised when a `$ENV:VAR` reference cannot be resolved. The
 * {@link reason} discriminator separates "variable not set at all" from
 * "set to empty string" — the latter is a common CI footgun (`.env` with
 * `CLIENT_SECRET=`) that deserves a different nudge to the user.
 */
export class MissingEnvSecretError extends Error {
  readonly code = 'missing_env_secret';
  constructor(
    public readonly envVar: string,
    public readonly reason: 'unset' | 'empty' = 'unset'
  ) {
    const detail =
      reason === 'empty'
        ? `is set but empty. Assign a non-empty value to ${envVar} (empty strings are ignored to catch '.env' typos).`
        : `is not set. Export ${envVar} or re-save the agent with a literal secret.`;
    super(`OAuth credential references environment variable '${envVar}' but it ${detail}`);
    this.name = 'MissingEnvSecretError';
  }
}

/**
 * Resolve a credential value that may be a `$ENV:VAR` reference.
 *
 * - Literal strings pass through unchanged.
 * - `$ENV:VAR` reads `process.env.VAR` and returns it. Throws
 *   {@link MissingEnvSecretError} with `reason: 'unset'` if the variable
 *   is not set, and `reason: 'empty'` if it is set to the empty string.
 *   We treat empty as missing to catch `.env` typos — a compliance run
 *   should loudly fail rather than silently POST an empty secret.
 *
 * Whitespace around the variable name (`$ENV: FOO`) is tolerated — a common
 * copy/paste mistake that we don't want to punish at runtime.
 */
export function resolveSecret(value: string): string {
  if (!value.startsWith(ENV_PREFIX)) {
    return value;
  }
  const envVar = value.slice(ENV_PREFIX.length).trim();
  if (!envVar) {
    throw new Error(
      `Invalid OAuth credential reference '${value}': expected '$ENV:VAR_NAME' with a variable name.`
    );
  }
  const resolved = process.env[envVar];
  if (resolved === undefined) {
    throw new MissingEnvSecretError(envVar, 'unset');
  }
  if (resolved === '') {
    throw new MissingEnvSecretError(envVar, 'empty');
  }
  return resolved;
}

/** True if `value` is a `$ENV:VAR` reference (not a literal secret). */
export function isEnvSecretReference(value: string): boolean {
  return value.startsWith(ENV_PREFIX);
}

/** Build a `$ENV:VAR` reference string from an env-var name. */
export function toEnvSecretReference(envVar: string): string {
  return `${ENV_PREFIX}${envVar}`;
}
