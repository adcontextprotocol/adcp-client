/**
 * Non-interactive OAuth flow handler for background / headless contexts
 * (storyboard runs, scheduled compliance jobs, CI).
 *
 * Use with {@link MCPOAuthProvider} when you want to **use and refresh**
 * previously-saved OAuth tokens, but do not want to initiate a new
 * authorization flow (which would require a browser). Any attempt to
 * redirect to authorization throws with an actionable error message.
 *
 * The MCP SDK will still call this handler's lifecycle — `getRedirectUrl`,
 * `redirectToAuthorization`, `waitForCallback`, `cleanup` — but only the
 * first is expected to succeed in practice. The others throw if reached.
 */
import type { OAuthFlowHandler } from './types';
import { OAuthError } from './types';

export interface NonInteractiveFlowHandlerConfig {
  /**
   * Redirect URL reported back to the MCP SDK. Should match the
   * `redirect_uris` of the saved client registration (usually
   * `http://localhost:8766/callback`). Defaults to that value.
   */
  redirectUrl?: string | URL;

  /**
   * Optional hint shown in the error message when a browser flow is
   * attempted — e.g., the alias name to pass to `adcp --save-auth`.
   */
  agentHint?: string;
}

export class NonInteractiveFlowHandler implements OAuthFlowHandler {
  private readonly _redirectUrl: URL;
  private readonly agentHint?: string;

  constructor(config: NonInteractiveFlowHandlerConfig = {}) {
    this._redirectUrl = new URL((config.redirectUrl ?? 'http://localhost:8766/callback').toString());
    this.agentHint = config.agentHint;
  }

  getRedirectUrl(): URL {
    return this._redirectUrl;
  }

  async redirectToAuthorization(): Promise<void> {
    const target = this.agentHint
      ? `adcp --save-auth ${this.agentHint} --oauth`
      : 'adcp --save-auth <alias> <url> --oauth';
    throw new OAuthError(
      `OAuth authorization required but this context is non-interactive. ` +
        `Run \`${target}\` from a terminal with a browser, then retry.`,
      'interactive_required'
    );
  }

  async waitForCallback(): Promise<string> {
    throw new OAuthError('waitForCallback() is not supported in non-interactive mode.', 'interactive_required');
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up — no server was started, no resources allocated.
  }
}
