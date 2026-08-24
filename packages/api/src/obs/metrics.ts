import type { ResolutionMethod } from '../domain/log.js';

/**
 * Minimal in-process metrics.
 *
 * Deliberately not Prometheus/OTel-wired for a 3-day build: the point is to
 * prove the *shape* — which counters and histograms actually answer the
 * questions we care about — not to stand up a collector. Every field here maps
 * to a decision:
 *
 *   resolutionMethod  → what fraction of traffic avoided a model call entirely
 *   escalations       → what the LLM tier is actually costing us
 *   confidenceBand    → how much we are interrupting users
 *   stageLatency      → which stage to optimise
 *   llmCost           → cost per log, the number that breaks at scale
 */

export interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

class Samples {
  private values: number[] = [];
  add(v: number): void {
    this.values.push(v);
    // Bounded memory: a long-running process must not accumulate forever.
    if (this.values.length > 10_000) this.values.splice(0, 5_000);
  }
  snapshot(): Histogram {
    if (this.values.length === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0 };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return {
      count: sorted.length,
      sum: sorted.reduce((a, b) => a + b, 0),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      p50: at(0.5),
      p95: at(0.95),
    };
  }
}

class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, Samples>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    let h = this.histograms.get(key);
    if (!h) {
      h = new Samples();
      this.histograms.set(key, h);
    }
    h.add(value);
  }

  recordResolution(method: ResolutionMethod): void {
    this.inc('resolution_total', { method });
    // The headline efficiency number: everything except llm_rerank was free.
    this.inc('resolution_tier_total', {
      tier: method === 'llm_rerank' ? 'escalated' : 'deterministic',
    });
  }

  snapshot(): { counters: Record<string, number>; histograms: Record<string, Histogram> } {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms].map(([k, v]) => [k, v.snapshot()]),
      ),
    };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }

  private key(name: string, labels: Record<string, string>): string {
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }
}

export const metrics = new Metrics();

/** Times a pipeline stage and records it under `stage_latency_ms{stage=...}`. */
export async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    metrics.observe('stage_latency_ms', performance.now() - started, { stage });
  }
}
