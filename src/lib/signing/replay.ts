export type ReplayInsertResult = 'ok' | 'replayed' | 'rate_abuse';

export interface ReplayStore {
  has(keyid: string, nonce: string, now: number): Promise<boolean>;
  isCapHit(keyid: string, now: number): Promise<boolean>;
  insert(keyid: string, nonce: string, ttlSeconds: number, now: number): Promise<ReplayInsertResult>;
}

interface Entry {
  nonce: string;
  expiresAt: number;
}

export interface InMemoryReplayStoreOptions {
  maxEntriesPerKeyid?: number;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, Entry[]>();
  private readonly capPerKeyid: number;
  private readonly forcedCapHit = new Set<string>();

  constructor(options: InMemoryReplayStoreOptions = {}) {
    this.capPerKeyid = options.maxEntriesPerKeyid ?? 1_000_000;
  }

  setCapHitForTesting(keyid: string): void {
    this.forcedCapHit.add(keyid);
  }

  async has(keyid: string, nonce: string, now: number): Promise<boolean> {
    this.prune(keyid, now);
    const list = this.entries.get(keyid);
    if (!list) return false;
    return list.some(e => e.nonce === nonce);
  }

  async isCapHit(keyid: string, now: number): Promise<boolean> {
    if (this.forcedCapHit.has(keyid)) return true;
    this.prune(keyid, now);
    const list = this.entries.get(keyid);
    return (list?.length ?? 0) >= this.capPerKeyid;
  }

  async insert(keyid: string, nonce: string, ttlSeconds: number, now: number): Promise<ReplayInsertResult> {
    this.prune(keyid, now);
    const list = this.entries.get(keyid) ?? [];
    if (list.some(e => e.nonce === nonce)) return 'replayed';
    if (this.forcedCapHit.has(keyid) || list.length >= this.capPerKeyid) {
      return 'rate_abuse';
    }
    list.push({ nonce, expiresAt: now + ttlSeconds });
    this.entries.set(keyid, list);
    return 'ok';
  }

  preload(keyid: string, nonce: string, ttlSeconds: number, now: number): void {
    const list = this.entries.get(keyid) ?? [];
    list.push({ nonce, expiresAt: now + ttlSeconds });
    this.entries.set(keyid, list);
  }

  private prune(keyid: string, now: number): void {
    const list = this.entries.get(keyid);
    if (!list) return;
    const alive = list.filter(e => e.expiresAt > now);
    if (alive.length === 0) this.entries.delete(keyid);
    else this.entries.set(keyid, alive);
  }
}
