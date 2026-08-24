import { logger } from '../obs/logger.js';
import { metrics } from '../obs/metrics.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
  /** Return false to fail fast — a 400 will not become a 200 on the third try. */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Per-attempt ceiling. Retrying is useless against a call that never returns,
   * and every provider SDK here will wait indefinitely by default.
   */
  timeoutMs?: number;
}

/** Raised when an attempt passed its ceiling. Retryable: a hang is transient. */
export class CallTimeout extends Error {
  readonly status = 408;
  constructor(label: string, ms: number) {
    super(`${label} did not return within ${ms} ms`);
    this.name = 'CallTimeout';
  }
}

/**
 * Bound one attempt.
 *
 * `Promise.race` does not cancel the loser, so the underlying request may still
 * be in flight when this resolves. That is acceptable here — the caller is
 * freed, and the orphan is bounded by the process — and it is the only option
 * that works uniformly across SDKs that do not all accept an AbortSignal.
 */
function withTimeout<T>(fn: () => Promise<T>, label: string, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new CallTimeout(label, ms)); }, ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/** HTTP statuses worth another attempt. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error && /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(err.message)) {
    return true;
  }
  const status = (err as { status?: number; statusCode?: number } | null)?.status
    ?? (err as { statusCode?: number } | null)?.statusCode;
  return typeof status === 'number' && RETRYABLE_STATUS.has(status);
}

/**
 * Retry with exponential backoff and full jitter.
 *
 * Jitter is not a detail. Meal logging traffic is extremely peaky — three
 * sharp spikes a day, at the same clock times for everyone — so a synchronised
 * retry storm is the realistic failure mode, not a theoretical one. Full
 * jitter spreads the second attempt across the whole window instead of
 * re-colliding every client at exactly `base * 2^n`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 4000;
  const retryable = opts.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = opts.timeoutMs === undefined
        ? await fn()
        : await withTimeout(fn, opts.label, opts.timeoutMs);
      if (attempt > 1) metrics.inc('retry_success_total', { label: opts.label });
      return result;
    } catch (err) {
      lastError = err;

      if (attempt === attempts || !retryable(err)) {
        metrics.inc('retry_exhausted_total', { label: opts.label });
        throw err;
      }

      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.random() * ceiling;
      metrics.inc('retry_attempt_total', { label: opts.label });
      logger.warn(
        { label: opts.label, attempt, delayMs: Math.round(delay), err: String(err).slice(0, 200) },
        'retrying after failure',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
