/**
 * Aggregate signing barrel. Re-exports the `client` and `server` sub-barrels
 * so existing consumers of `@adcp/client/signing` keep working.
 *
 * New code should import from the narrower surface that matches its role:
 *
 *   import { createSigningFetch } from '@adcp/client/signing/client';
 *   import { createExpressVerifier } from '@adcp/client/signing/server';
 *
 * — coding agents reading a file cold only need to hold one half of the
 * taxonomy, not all 30+ symbols. This aggregate barrel remains the stable
 * entry point until a future major release drops it.
 */
export * from './client';
export * from './server';
