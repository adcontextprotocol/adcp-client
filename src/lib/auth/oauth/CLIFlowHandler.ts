/**
 * CLI OAuth flow handler
 *
 * Opens the user's browser for authorization and
 * starts a local HTTP server to receive the callback.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { URL } from 'url';
import { platform } from 'os';
import type { OAuthFlowHandler } from './types';
import { OAuthCancelledError, OAuthTimeoutError } from './types';

/**
 * Configuration for CLI OAuth flow
 */
export interface CLIFlowHandlerConfig {
  /** Port for the callback server (default: 8766) */
  callbackPort?: number;
  /** Timeout in ms for waiting for callback (default: 300000 = 5 min) */
  timeout?: number;
  /** Custom callback path (default: /callback) */
  callbackPath?: string;
  /** Suppress console output */
  quiet?: boolean;
}

/**
 * CLI OAuth flow handler implementation
 *
 * Handles the OAuth flow for command-line tools by:
 * 1. Opening the authorization URL in the user's default browser
 * 2. Starting a local HTTP server to receive the callback
 * 3. Extracting and returning the authorization code
 *
 * @example
 * ```typescript
 * const flow = new CLIFlowHandler({ callbackPort: 8766 });
 * await flow.redirectToAuthorization(new URL('https://auth.example.com/authorize?...'));
 * const code = await flow.waitForCallback();
 * await flow.cleanup();
 * ```
 */
export class CLIFlowHandler implements OAuthFlowHandler {
  private readonly port: number;
  private readonly timeout: number;
  private readonly callbackPath: string;
  private readonly quiet: boolean;
  private server: Server | null = null;
  private pendingCallback: {
    resolve: (code: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(config: CLIFlowHandlerConfig = {}) {
    this.port = config.callbackPort ?? 8766;
    this.timeout = config.timeout ?? 300000; // 5 minutes
    this.callbackPath = config.callbackPath ?? '/callback';
    this.quiet = config.quiet ?? false;
  }

  getRedirectUrl(): string {
    return `http://localhost:${this.port}${this.callbackPath}`;
  }

  /**
   * Open URL in the user's default browser
   *
   * Uses spawn with separate arguments to avoid command injection risks.
   * The URL is passed as an argument, not interpolated into a shell command.
   */
  private async openBrowser(url: string): Promise<void> {
    return new Promise((resolve) => {
      let command: string;
      let args: string[];

      switch (platform()) {
        case 'darwin':
          command = 'open';
          args = [url];
          break;
        case 'win32':
          command = 'cmd';
          args = ['/c', 'start', '', url];
          break;
        default:
          // Linux and others - try xdg-open
          command = 'xdg-open';
          args = [url];
      }

      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });

      child.on('error', (error) => {
        if (!this.quiet) {
          console.error(`Failed to open browser: ${error.message}`);
          console.log(`Please manually open: ${url}`);
        }
        // Don't reject - user can manually open the URL
        resolve();
      });

      // Unref so the parent process can exit
      child.unref();
      resolve();
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();

    if (!this.quiet) {
      console.log('');
      console.log('Opening browser for authorization...');
      console.log(`URL: ${url}`);
      console.log('');
    }

    await this.openBrowser(url);
  }

  async waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.cleanup();
        reject(new OAuthTimeoutError(undefined, this.timeout));
      }, this.timeout);

      this.pendingCallback = {
        resolve: (code: string) => {
          clearTimeout(timeoutId);
          resolve(code);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      };

      // Start the callback server
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        if (this.pendingCallback) {
          this.pendingCallback.reject(
            new Error(`Callback server error: ${error.message}`)
          );
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        if (!this.quiet) {
          console.log(`Waiting for authorization callback on port ${this.port}...`);
          console.log('(Press Ctrl+C to cancel)');
          console.log('');
        }
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);

    // Ignore favicon requests
    if (url.pathname === '/favicon.ico') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Only handle the callback path
    if (url.pathname !== this.callbackPath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      const errorMsg = errorDescription || error;
      this.sendErrorResponse(res, errorMsg);

      if (this.pendingCallback) {
        if (error === 'access_denied') {
          this.pendingCallback.reject(new OAuthCancelledError());
        } else {
          this.pendingCallback.reject(new Error(`OAuth error: ${errorMsg}`));
        }
      }
      return;
    }

    if (!code) {
      this.sendErrorResponse(res, 'No authorization code received');
      if (this.pendingCallback) {
        this.pendingCallback.reject(new Error('No authorization code received'));
      }
      return;
    }

    // Success!
    this.sendSuccessResponse(res);

    if (this.pendingCallback) {
      this.pendingCallback.resolve(code);
    }

    // Clean up after a short delay to ensure response is sent
    setTimeout(() => this.cleanup(), 1000);
  }

  private sendSuccessResponse(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authorization Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .card {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      text-align: center;
      max-width: 400px;
    }
    h1 { color: #22c55e; margin-top: 0; }
    p { color: #666; line-height: 1.6; }
    .icon { font-size: 48px; margin-bottom: 20px; color: #22c55e; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to your terminal.</p>
    <p><small>This window will close automatically in 3 seconds...</small></p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>
    `);
  }

  private sendErrorResponse(res: ServerResponse, error: string): void {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #f87171 0%, #dc2626 100%);
    }
    .card {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      text-align: center;
      max-width: 400px;
    }
    h1 { color: #dc2626; margin-top: 0; }
    p { color: #666; line-height: 1.6; }
    .error { color: #dc2626; background: #fef2f2; padding: 10px; border-radius: 6px; }
    .icon { font-size: 48px; margin-bottom: 20px; color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10007;</div>
    <h1>Authorization Failed</h1>
    <p class="error">${escapeHtml(error)}</p>
    <p>Please close this window and try again.</p>
  </div>
</body>
</html>
    `);
  }

  async cleanup(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }
}

/**
 * Escape HTML entities to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
