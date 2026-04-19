/**
 * File-backed {@link OAuthConfigStorage} implementation.
 *
 * Persists refreshed OAuth tokens back to a JSON file so that subsequent
 * `callTool` invocations use the latest access + refresh tokens without
 * triggering a redundant refresh (or worse, a re-login).
 *
 * On-disk format is the shape used by the `adcp` CLI's agents.json — agents
 * keyed by alias, each with `{ url, protocol, auth_token?, oauth_tokens?, oauth_client? }`.
 * Library consumers who want a different shape can implement
 * {@link OAuthConfigStorage} directly.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { AgentConfig } from '../../types/adcp';
import type { OAuthConfigStorage } from './types';

/**
 * Shape of a single agent record on disk (matches the `adcp` CLI's config format).
 */
interface StoredAgent {
  url: string;
  protocol?: 'mcp' | 'a2a';
  auth_token?: string;
  oauth_tokens?: AgentConfig['oauth_tokens'];
  oauth_client?: AgentConfig['oauth_client'];
  oauth_code_verifier?: string;
}

/**
 * Shape of the whole config file.
 */
interface StoredConfig {
  agents: Record<string, StoredAgent>;
  defaults?: Record<string, unknown>;
}

/**
 * Options for {@link createFileOAuthStorage}.
 */
export interface FileOAuthStorageOptions {
  /** Absolute path to the config JSON file. Must be a file, not a directory. */
  configPath: string;
  /**
   * Key persistence under a stable alias regardless of `agent.id`. Use this
   * when the in-memory `AgentConfig` carries an ephemeral identifier (e.g.
   * a per-request tenant id, or a synthetic `cli-agent`) but on-disk storage
   * should be organized by a long-lived alias chosen by the operator.
   */
  agentKey?: string;
  /**
   * Create the parent directory (with mode 0o700) if it doesn't exist.
   * Default true — CLI users expect first-run to create `~/.adcp/`.
   */
  autoCreateDir?: boolean;
  /** File mode for the config file when we create it. Default 0o600. */
  fileMode?: number;
}

/**
 * Create a file-backed `OAuthConfigStorage`.
 *
 * Reads are cheap: a single JSON.parse per call. Writes are atomic via
 * `write-then-rename` so a crash mid-save cannot produce a half-written file.
 *
 * Does NOT touch fields outside the OAuth envelope (`auth_token`, custom
 * fields) when saving — the MCP provider only mutates `oauth_tokens`,
 * `oauth_client`, and `oauth_code_verifier`, and we preserve everything else.
 *
 * @example
 * ```ts
 * const storage = createFileOAuthStorage({ configPath: '/home/user/.adcp/config.json' });
 * const provider = createNonInteractiveOAuthProvider(agent, { storage });
 * ```
 */
export function createFileOAuthStorage(options: FileOAuthStorageOptions): OAuthConfigStorage {
  const configPath = options.configPath;
  const agentKeyOverride = options.agentKey;
  const autoCreateDir = options.autoCreateDir ?? true;
  const fileMode = options.fileMode ?? 0o600;

  async function readConfig(): Promise<StoredConfig> {
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as StoredConfig;
      if (!parsed.agents || typeof parsed.agents !== 'object') parsed.agents = {};
      return parsed;
    } catch (err) {
      if (isNotFound(err)) return { agents: {} };
      throw err;
    }
  }

  async function writeConfig(config: StoredConfig): Promise<void> {
    if (autoCreateDir) {
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    }
    // Atomic write: stage next to the target, then rename. Same filesystem →
    // rename is atomic on POSIX and on NTFS (MoveFileEx under the hood).
    // Random suffix guards against two concurrent saves in the same process
    // racing on the same temp path.
    const tempPath = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const serialized = JSON.stringify(config, null, 2);
    await fs.writeFile(tempPath, serialized, { mode: fileMode });
    await fs.rename(tempPath, configPath);
  }

  return {
    async loadAgent(agentId: string): Promise<AgentConfig | undefined> {
      const key = agentKeyOverride ?? agentId;
      const config = await readConfig();
      const stored = config.agents[key];
      if (!stored) return undefined;
      return {
        id: agentId,
        name: agentId,
        agent_uri: stored.url,
        protocol: stored.protocol ?? 'mcp',
        auth_token: stored.auth_token,
        oauth_tokens: stored.oauth_tokens,
        oauth_client: stored.oauth_client,
        oauth_code_verifier: stored.oauth_code_verifier,
      };
    },

    async saveAgent(agent: AgentConfig): Promise<void> {
      const key = agentKeyOverride ?? agent.id;
      const config = await readConfig();
      const existing = config.agents[key] ?? { url: agent.agent_uri };
      config.agents[key] = {
        ...existing,
        url: agent.agent_uri,
        protocol: agent.protocol,
        ...(agent.auth_token !== undefined ? { auth_token: agent.auth_token } : {}),
        ...(agent.oauth_tokens !== undefined ? { oauth_tokens: agent.oauth_tokens } : {}),
        ...(agent.oauth_client !== undefined ? { oauth_client: agent.oauth_client } : {}),
        ...(agent.oauth_code_verifier !== undefined ? { oauth_code_verifier: agent.oauth_code_verifier } : {}),
      };
      await writeConfig(config);
    },
  };
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT');
}
