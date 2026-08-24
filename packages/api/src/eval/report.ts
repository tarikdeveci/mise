import { ERROR_TAXONOMY, ownerOf, type ErrorCode } from '../domain/taxonomy.js';
import type { CaseResult } from './harness.js';

/* ─────────────────────────── statistics ──────────────────────────── */

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const median = (v: number[]): number => percentile(v, 0.5);
const pct = (n: number, d: number): number => (d === 0 ? 0 : Number(((100 * n) / d).toFixed(1)));

/**
 * Expected Calibration Error over 10 equal-width confidence bins.
 *
 * This is the metric that decides whether the confidence number means
 * anything. If items we score 0.9 are right 60% of the time, the score is not
 * a probability — it is a mood, and routing decisions built on it are
 * arbitrary. ECE is what turns "we have confidence scores" into a claim that
 * can be false.
 */
export function expectedCalibrationError(results: CaseResult[]): {
  ece: number;
  bins: Array<{ range: string; n: number; confidence: number; accuracy: number }>;
} {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10,
    hi: (i + 1) / 10,
    items: [] as CaseResult[],
  }));

  for (const r of results) {
    const idx = Math.min(9, Math.floor(r.confidence * 10));
    bins[idx]!.items.push(r);
  }

  let ece = 0;
  const rows = bins
    .filter((b) => b.items.length > 0)
    .map((b) => {
      const n = b.items.length;
      const confidence = b.items.reduce((s, r) => s + r.confidence, 0) / n;
      const accuracy = b.items.filter((r) => r.passed).length / n;
      ece += (n / results.length) * Math.abs(accuracy - confidence);
      return {
        range: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`,
        n,
        confidence: Number(confidence.toFixed(3)),
        accuracy: Number(accuracy.toFixed(3)),
      };
    });

  return { ece: Number(ece.toFixed(4)), bins: rows };
}

/* ──────────────────────────── summary ────────────────────────────── */

export interface EvalSummary {
  extractor: string;
  model: string;
  pipelineVersion: string;
  cases: number;

  /** Share of cases with no taxonomy error at all. The strictest number here. */
  exactPassRate: number;
  /** Share of expected foods matched to the right canonical id. */
  foodMatchAccuracy: number;

  kcalMedianApe: number;
  kcalWithin10Pct: number;
  kcalWithin25Pct: number;
  /** How often the true total fell inside the interval we displayed. */
  intervalCoverage: number;

  /** Share of logs that needed no user input. */
  autoLogRate: number;
  /** Accuracy restricted to auto-logged cases — the number users actually feel. */
  autoLogPrecision: number;

  ece: number;
  hallucinationRate: number;

  /** Share of resolutions that never touched a model. */
  deterministicShare: number;

  latencyP50: number;
  latencyP95: number;

  byStratum: Record<string, { n: number; pass: number; kcalMedianApe: number }>;
  taxonomy: Array<{ code: ErrorCode; label: string; owner: string; count: number }>;
  calibrationBins: ReturnType<typeof expectedCalibrationError>['bins'];
}

export function summarise(
  results: CaseResult[],
  meta: { extractor: string; model: string; pipelineVersion: string },
): EvalSummary {
  const n = results.length;

  const totalExpected = results.reduce((s, r) => s + r.outcomes.filter((o) => o.expectedFoodId).length, 0);
  const totalMatched = results.reduce(
    (s, r) => s + r.outcomes.filter((o) => o.expectedFoodId && o.expectedFoodId === o.predictedFoodId).length,
    0,
  );

  const apes = results.map((r) => r.kcalApe).filter((a): a is number => a !== null);
  const auto = results.filter((r) => r.autoLogged);

  const methods = results.flatMap((r) => r.resolutionMethods);
  const deterministic = methods.filter((m) => m !== 'llm_rerank' && m !== 'unresolved').length;

  const counts = new Map<ErrorCode, number>();
  for (const r of results) {
    for (const e of r.errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  }

  const strata = [...new Set(results.map((r) => r.stratum))];
  const byStratum = Object.fromEntries(
    strata.map((s) => {
      const subset = results.filter((r) => r.stratum === s);
      const subApes = subset.map((r) => r.kcalApe).filter((a): a is number => a !== null);
      return [
        s,
        {
          n: subset.length,
          pass: pct(subset.filter((r) => r.passed).length, subset.length),
          kcalMedianApe: Number((100 * median(subApes)).toFixed(1)),
        },
      ];
    }),
  );

  const calibration = expectedCalibrationError(results);

  return {
    extractor: meta.extractor,
    model: meta.model,
    pipelineVersion: meta.pipelineVersion,
    cases: n,
    exactPassRate: pct(results.filter((r) => r.passed).length, n),
    foodMatchAccuracy: pct(totalMatched, totalExpected),
    kcalMedianApe: Number((100 * median(apes)).toFixed(1)),
    kcalWithin10Pct: pct(apes.filter((a) => a <= 0.1).length, apes.length),
    kcalWithin25Pct: pct(apes.filter((a) => a <= 0.25).length, apes.length),
    intervalCoverage: pct(results.filter((r) => r.kcalInInterval).length, n),
    autoLogRate: pct(auto.length, n),
    autoLogPrecision: pct(auto.filter((r) => r.passed).length, auto.length),
    ece: calibration.ece,
    hallucinationRate: pct(counts.get('E11_HALLUCINATED_NUTRITION') ?? 0, n),
    deterministicShare: pct(deterministic, methods.length),
    latencyP50: percentile(results.map((r) => r.latencyMs), 0.5),
    latencyP95: percentile(results.map((r) => r.latencyMs), 0.95),
    byStratum,
    taxonomy: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({
        code,
        label: ERROR_TAXONOMY[code].label,
        owner: ownerOf(code),
        count,
      })),
    calibrationBins: calibration.bins,
  };
}

/* ──────────────────────────── rendering ──────────────────────────── */

const bar = (label: string) => `\n${label}\n${'─'.repeat(74)}`;
const row = (k: string, v: string | number, note = '') =>
  `  ${k.padEnd(26)} ${String(v).padStart(8)}  ${note}`;

export function renderSummary(s: EvalSummary): string {
  const out: string[] = [];

  out.push(bar(`EVAL  ${s.extractor}  (${s.model})  pipeline ${s.pipelineVersion}  ·  ${s.cases} cases`));

  out.push('\n  ACCURACY');
  out.push(row('exact pass rate', `${s.exactPassRate}%`, 'no taxonomy error of any kind'));
  out.push(row('food match accuracy', `${s.foodMatchAccuracy}%`, 'correct canonical id'));
  out.push(row('kcal median APE', `${s.kcalMedianApe}%`));
  out.push(row('kcal within ±10%', `${s.kcalWithin10Pct}%`));
  out.push(row('kcal within ±25%', `${s.kcalWithin25Pct}%`));

  out.push('\n  HONESTY');
  out.push(row('interval coverage', `${s.intervalCoverage}%`, 'truth inside the range we showed'));
  out.push(row('calibration error (ECE)', s.ece, 'lower is better; 0 = perfectly calibrated'));
  out.push(row('hallucination rate', `${s.hallucinationRate}%`, 'MUST be 0 — structural guarantee'));

  out.push('\n  COVERAGE / COST');
  out.push(row('auto-logged', `${s.autoLogRate}%`, 'needed no user input'));
  out.push(row('precision when auto-logged', `${s.autoLogPrecision}%`, 'what users actually feel'));
  out.push(row('deterministic resolutions', `${s.deterministicShare}%`, 'resolved with no model call'));
  out.push(row('latency p50 / p95', `${s.latencyP50} / ${s.latencyP95} ms`));

  out.push(bar('BY STRATUM'));
  for (const [name, v] of Object.entries(s.byStratum)) {
    out.push(row(name, `${v.pass}%`, `n=${v.n}  ·  kcal median APE ${v.kcalMedianApe}%`));
  }

  if (s.taxonomy.length > 0) {
    out.push(bar('ERROR TAXONOMY  (what to fix, and where)'));
    for (const t of s.taxonomy) {
      out.push(`  ${String(t.count).padStart(3)}x  ${t.code.padEnd(28)} ${t.label}  → ${t.owner}/`);
    }
  } else {
    out.push(bar('ERROR TAXONOMY'));
    out.push('  (clean)');
  }

  out.push(bar('CALIBRATION'));
  out.push(`  ${'bin'.padEnd(12)}${'n'.padStart(5)}${'said'.padStart(9)}${'actual'.padStart(9)}`);
  for (const b of s.calibrationBins) {
    const gap = b.accuracy - b.confidence;
    const flag = Math.abs(gap) > 0.15 ? (gap < 0 ? '  overconfident' : '  underconfident') : '';
    out.push(
      `  ${b.range.padEnd(12)}${String(b.n).padStart(5)}${b.confidence.toFixed(2).padStart(9)}${b.accuracy.toFixed(2).padStart(9)}${flag}`,
    );
  }

  // A benchmark with no failures left cannot calibrate anything, and a 100%
  // score is more likely to mean "saturated" than "solved". Say so here rather
  // than letting the reader draw the flattering conclusion — and refuse to fit
  // band thresholds against a set that has no negatives to fit against.
  if (s.exactPassRate >= 100) {
    out.push(bar('⚠  BENCHMARK SATURATED'));
    out.push('  Every case passes, so this set can no longer tell a better pipeline');
    out.push('  from a worse one, and the calibration figures above are unfittable:');
    out.push('  with no failures there is nothing for a threshold to separate.');
    out.push('');
    out.push(`  ECE is ${s.ece} and every bin is under-confident: the pipeline is right`);
    out.push(`  far more often than it claims, which is why only ${s.autoLogRate}% auto-logs.`);
    out.push('  Fixing that needs cases this set does not contain — photos, and inputs');
    out.push('  written by someone other than the author of the food database.');
  }

  return out.join('\n');
}

/** Per-case detail, for reading what actually broke. */
export function renderFailures(results: CaseResult[], limit = 20): string {
  const failed = results.filter((r) => !r.passed).slice(0, limit);
  if (failed.length === 0) return '\n  (no failures)\n';

  const out: string[] = [bar(`FAILURES  (${results.filter((r) => !r.passed).length} total, showing ${failed.length})`)];
  for (const f of failed) {
    out.push(`\n  ${f.caseId} [${f.stratum}]  ${f.errors.join(', ')}`);
    out.push(`    probes: ${f.probes}`);
    out.push(`    kcal: expected ${f.expectedKcal}, got ${f.predictedKcal}` +
      (f.kcalApe !== null ? ` (${(f.kcalApe * 100).toFixed(0)}% off)` : ''));
    for (const o of f.outcomes.filter((x) => x.errorCode)) {
      out.push(
        `    · ${o.errorCode}: expected ${o.expectedFoodId ?? '—'}` +
        `${o.expectedGrams ? ` @${o.expectedGrams}g` : ''}` +
        ` → got ${o.predictedFoodId ?? '—'}${o.predictedGrams ? ` @${o.predictedGrams}g` : ''}`,
      );
    }
  }
  return out.join('\n');
}
