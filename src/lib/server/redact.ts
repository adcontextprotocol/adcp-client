/**
 * Server compatibility export for the shared diagnostic credential redactor.
 *
 * The server uses the conservative default, including unlabeled token-shaped
 * values, before projecting adopter-thrown error messages onto the wire.
 *
 * @internal
 */
export { redactCredentialPatterns } from '../utils/redact-credential-patterns';
