import { createHash } from 'node:crypto';

/**
 * Idempotency for meal creation.
 *
 * Logging a meal is the one operation in this system a user genuinely must not
 * do twice, and the environment guarantees they will try: phones lose
 * connectivity mid-request, users tap Save again, and our own retry logic
 * replays requests after a timeout that may have actually succeeded. Without a
 * key, "the network dropped" and "the meal was logged twice" are the same
 * observable event.
 *
 * The stored body hash matters as much as the key: reusing a key with a
 * different payload is a client bug, and silently returning the old result
 * would hide it. We fail loudly instead.
 */

export interface IdempotencyRecord<T> {
  bodyHash: string;
  response: T;
  createdAt: number;
}

export class IdempotencyConflict extends Error {
  constructor(readonly key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request body.`);
    this.name = 'IdempotencyConflict';
  }
}

export interface IdempotencyStore<T> {
  /** Returns a stored response, or throws if the key was reused with new content. */
  get(key: string, body: unknown): T | undefined;
  put(key: string, body: unknown, response: T): void;
  size(): number;
}

export function hashBody(body: unknown): string {
  // Stable stringify: key order must not change the hash, or a client that
  // serialises differently on retry would look like a conflict.
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function createIdempotencyStore<T>(ttlMs = 24 * 60 * 60 * 1000): IdempotencyStore<T> {
  const records = new Map<string, IdempotencyRecord<T>>();

  const evictExpired = (): void => {
    const cutoff = Date.now() - ttlMs;
    for (const [key, rec] of records) {
      if (rec.createdAt < cutoff) records.delete(key);
    }
  };

  return {
    get(key, body) {
      evictExpired();
      const rec = records.get(key);
      if (!rec) return undefined;
      if (rec.bodyHash !== hashBody(body)) throw new IdempotencyConflict(key);
      return rec.response;
    },
    put(key, body, response) {
      records.set(key, { bodyHash: hashBody(body), response, createdAt: Date.now() });
    },
    size: () => records.size,
  };
}
