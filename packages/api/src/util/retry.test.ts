import { describe, it, expect, vi } from 'vitest';
import { withRetry, CallTimeout, defaultIsRetryable, retryableExceptHang } from './retry.js';

/**
 * The retry layer is where every outbound call in this system passes, so its
 * two rules are worth asserting directly rather than through a caller.
 *
 * The timeout exists because of a measurement, not a hypothesis: one photo case
 * spent 623 s inside a provider call while its four neighbours took 12-16 s.
 * Retrying is no defence against a call that never comes back — attempt two
 * hangs exactly as well as attempt one — so each attempt needs a ceiling.
 */
describe('per-attempt timeout', () => {
  it('gives up on a call that never settles', async () => {
    const hang = (): Promise<never> => new Promise(() => { /* never */ });

    await expect(
      withRetry(hang, { label: 'test.hang', attempts: 1, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(CallTimeout);
  });

  it('treats a hang as retryable, because a hang is usually transient', async () => {
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls++;
      if (calls === 1) return new Promise(() => { /* first attempt hangs */ });
      return 'recovered';
    };

    const result = await withRetry(flaky, {
      label: 'test.flaky', attempts: 2, timeoutMs: 20, baseDelayMs: 1,
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('leaves a fast call untouched', async () => {
    const quick = async (): Promise<string> => 'done';
    await expect(
      withRetry(quick, { label: 'test.quick', timeoutMs: 5_000 }),
    ).resolves.toBe('done');
  });

  it('does nothing at all when no ceiling is asked for', async () => {
    // Opt-in: existing callers that never set one keep their old behaviour.
    const slow = async (): Promise<string> => {
      await new Promise((r) => { setTimeout(r, 30); });
      return 'done';
    };
    await expect(withRetry(slow, { label: 'test.none' })).resolves.toBe('done');
  });
});

describe('what is worth retrying', () => {
  it('retries a 503 and gives up on a 400', async () => {
    expect(defaultIsRetryable({ status: 503 })).toBe(true);
    // A rejected body will not be accepted on the third attempt; retrying it
    // wastes the user's battery and hides the bug.
    expect(defaultIsRetryable({ status: 400 })).toBe(false);
  });

  it('stops immediately on a non-retryable failure', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });

    await expect(
      withRetry(fn, { label: 'test.fatal', attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/**
 * The opposite trade, for calls that are an improvement rather than the answer.
 *
 * The verifier is the case: it makes a match better, and when it cannot answer
 * the item goes to the user, which is a good outcome rather than a failure.
 * Retrying its hang spends a second full ceiling of wall-clock, and because
 * items resolve concurrently the slowest one is the whole meal's latency. This
 * was measured, not supposed — one exhausted retry turned a photo of six foods
 * into 25 s.
 */
describe('a hang, for a call whose fallback is already good', () => {
  it('is not retried, while a real transient fault still is', () => {
    expect(retryableExceptHang(new CallTimeout('verify', 10_000))).toBe(false);
    // The distinction is a server that said "not now" against one that said
    // nothing at all. The first is worth asking twice.
    expect(retryableExceptHang({ status: 429 })).toBe(true);
    expect(retryableExceptHang({ status: 503 })).toBe(true);
    expect(retryableExceptHang({ status: 400 })).toBe(false);
  });

  it('costs one ceiling rather than two', async () => {
    const hang = vi.fn((): Promise<never> => new Promise(() => { /* never */ }));

    await expect(withRetry(hang, {
      label: 'test.verify', attempts: 2, baseDelayMs: 1, timeoutMs: 20,
      isRetryable: retryableExceptHang,
    })).rejects.toBeInstanceOf(CallTimeout);

    expect(hang).toHaveBeenCalledTimes(1);
  });

  it('still gets its second attempt when the fault is transient', async () => {
    const flaky = vi.fn(async () => { throw Object.assign(new Error('busy'), { status: 429 }); });

    await expect(withRetry(flaky, {
      label: 'test.verify', attempts: 2, baseDelayMs: 1,
      isRetryable: retryableExceptHang,
    })).rejects.toThrow('busy');

    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
