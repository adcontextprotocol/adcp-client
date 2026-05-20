import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ====== CursorStore Interface ======

/** Abstraction for persisting the event feed cursor between restarts. */
export interface CursorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  /**
   * Remove the persisted cursor. Used by sync engines on `RETENTION_EXPIRED`
   * recovery — the agent no longer holds events for our cursor, so we
   * re-bootstrap and want subsequent `getCursor()` calls to return `null`.
   *
   * Implementations may delete the underlying storage (file) or store a
   * sentinel value, as long as `getCursor()` returns `null` afterward.
   */
  clearCursor(): Promise<void>;
}

// ====== InMemoryCursorStore ======

/** Default cursor store that holds the cursor in memory. Lost on process restart. */
export class InMemoryCursorStore implements CursorStore {
  private cursor: string | null = null;

  async getCursor(): Promise<string | null> {
    return this.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
  }

  async clearCursor(): Promise<void> {
    this.cursor = null;
  }
}

// ====== FileCursorStore ======

/** File-based cursor store for CLI/server use. Survives process restarts. */
export class FileCursorStore implements CursorStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async getCursor(): Promise<string | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const trimmed = data.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async setCursor(cursor: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, cursor, 'utf-8');
  }

  async clearCursor(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(this.filePath);
    } catch (err: unknown) {
      // Already-gone is the desired post-state; any other error rethrows.
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}
