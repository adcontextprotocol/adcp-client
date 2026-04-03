import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ====== CursorStore Interface ======

/** Abstraction for persisting the event feed cursor between restarts. */
export interface CursorStore {
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
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
}
