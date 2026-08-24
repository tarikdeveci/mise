import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { FoodDb } from '../data/foodDb.js';
import { MealInput, type LoggedItem, type MealLog } from '../domain/log.js';
import type { ErrorCode } from '../domain/taxonomy.js';
import type { Pipeline } from '../pipeline/index.js';
import { computeNutrition } from '../pipeline/nutrition.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(HERE, '../../../../data/golden/cases.json');

export const GoldenCase = z.object({
  id: z.string(),
  stratum: z.enum(['easy', 'ambiguous', 'adversarial']),
  input: MealInput,
  expected: z.array(z.object({ foodId: z.string(), grams: z.number().positive() })),
  probes: z.string(),
  risks: z.array(z.string()),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

export function loadGoldenSet(path = GOLDEN_PATH): GoldenCase[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return z.array(GoldenCase).parse(raw);
}

/* ───────────────────────── expected values ───────────────────────── */

/**
 * The expected calorie total is COMPUTED from the labelled (foodId, grams)
 * pairs rather than written by hand.
 *
 * This is not a convenience. A hand-typed expected kcal can disagree with the
 * database it is supposed to describe, and then the benchmark measures the
 * labeller's arithmetic instead of the system. Deriving it means a label can
 * be wrong about *which food* or *how much* — real, reviewable claims — but
 * never wrong about what those two things imply.
 */
export function expectedKcal(db: FoodDb, expected: GoldenCase['expected']): number {
  return Number(
    expected
      .reduce((sum, e) => {
        const food = db.byId(e.foodId);
        if (!food) throw new Error(`golden set references unknown food ${e.foodId}`);
        return sum + (food.per100g.kcal * e.grams) / 100;
      }, 0)
      .toFixed(1),
  );
}

/* ─────────────────────────── classification ──────────────────────── */

export interface ItemOutcome {
  expectedFoodId: string | null;
  predictedFoodId: string | null;
  expectedGrams: number | null;
  predictedGrams: number | null;
  /** Absolute percentage error on mass, when both sides exist. */
  gramsApe: number | null;
  errorCode: ErrorCode | null;
}

export interface CaseResult {
  caseId: string;
  stratum: GoldenCase['stratum'];
  probes: string;
  /** Every expected food was matched with an acceptable portion. */
  passed: boolean;
  foodMatchRate: number;
  expectedKcal: number;
  predictedKcal: number;
  kcalApe: number | null;
  /** True when the true total falls inside the interval we showed the user. */
  kcalInInterval: boolean;
  confidence: number;
  band: MealLog['items'][number]['confidence']['band'] | 'none';
  status: MealLog['status'];
  autoLogged: boolean;
  latencyMs: number;
  resolutionMethods: string[];
  outcomes: ItemOutcome[];
  errors: ErrorCode[];
}

/** A portion within this relative error is treated as correct. */
const PORTION_TOLERANCE = 0.25;

/**
 * Assigns a taxonomy code to each mismatch.
 *
 * The classifier is intentionally conservative and its limits are stated
 * rather than hidden: it pairs leftover expected/predicted items by food group
 * and cooking state, which recovers E6/E8 reliably but cannot always separate
 * a genuine E1 from an E2+E3 pair. Cases that matter are re-read by hand — the
 * taxonomy's job is to point at the right subsystem, not to be a court.
 */
function classify(
  db: FoodDb,
  expected: GoldenCase['expected'],
  predicted: LoggedItem[],
): ItemOutcome[] {
  const outcomes: ItemOutcome[] = [];
  const remainingExpected = [...expected];
  const remainingPredicted = predicted.filter((p) => p.foodId !== null);
  const unresolved = predicted.filter((p) => p.foodId === null);

  /* Exact food-id matches first. */
  for (let i = remainingExpected.length - 1; i >= 0; i--) {
    const exp = remainingExpected[i]!;
    const hitIndex = remainingPredicted.findIndex((p) => p.foodId === exp.foodId);
    if (hitIndex === -1) continue;

    const hit = remainingPredicted[hitIndex]!;
    const grams = hit.portion?.gramsLikely ?? 0;
    const ape = Math.abs(grams - exp.grams) / exp.grams;

    outcomes.push({
      expectedFoodId: exp.foodId,
      predictedFoodId: hit.foodId,
      expectedGrams: exp.grams,
      predictedGrams: grams,
      gramsApe: Number(ape.toFixed(4)),
      errorCode: ape > PORTION_TOLERANCE ? portionErrorCode(db, exp, grams) : null,
    });

    remainingExpected.splice(i, 1);
    remainingPredicted.splice(hitIndex, 1);
  }

  /* Pair what is left: a wrong match, not a miss plus a phantom. */
  for (let i = remainingExpected.length - 1; i >= 0; i--) {
    const exp = remainingExpected[i]!;
    const expFood = db.byId(exp.foodId);
    if (!expFood || remainingPredicted.length === 0) continue;

    const pairIndex = remainingPredicted.findIndex((p) => {
      const pf = p.foodId ? db.byId(p.foodId) : undefined;
      return pf?.group === expFood.group;
    });
    const idx = pairIndex === -1 ? 0 : pairIndex;
    const pair = remainingPredicted[idx]!;
    const pairFood = pair.foodId ? db.byId(pair.foodId) : undefined;

    outcomes.push({
      expectedFoodId: exp.foodId,
      predictedFoodId: pair.foodId,
      expectedGrams: exp.grams,
      predictedGrams: pair.portion?.gramsLikely ?? null,
      gramsApe: null,
      errorCode: wrongFoodCode(expFood.group, expFood.state, pairFood?.group, pairFood?.state),
    });

    remainingExpected.splice(i, 1);
    remainingPredicted.splice(idx, 1);
  }

  /* Anything still expected was never produced. */
  for (const exp of remainingExpected) {
    outcomes.push({
      expectedFoodId: exp.foodId,
      predictedFoodId: null,
      expectedGrams: exp.grams,
      predictedGrams: null,
      gramsApe: null,
      errorCode: 'E2_MISSING_ITEM',
    });
  }

  /* Anything still predicted was invented. */
  for (const extra of remainingPredicted) {
    outcomes.push({
      expectedFoodId: null,
      predictedFoodId: extra.foodId,
      expectedGrams: null,
      predictedGrams: extra.portion?.gramsLikely ?? null,
      gramsApe: null,
      errorCode: expected.length === 0 ? 'E12_NOT_FOOD' : 'E3_PHANTOM_ITEM',
    });
  }

  /* Items the router honestly declined.
     An abstention is NOT an error class of its own: if it cost us a real food,
     that food is already recorded above as E2_MISSING_ITEM, and counting it
     twice would inflate the taxonomy and point at the wrong subsystem. It is
     tracked as coverage (auto-log rate), which is where the trade-off belongs. */
  void unresolved;

  return outcomes;
}

function portionErrorCode(db: FoodDb, exp: { foodId: string; grams: number }, got: number): ErrorCode {
  const food = db.byId(exp.foodId);
  const ratio = got / exp.grams;
  // A ratio near a density or a common unit factor points at a conversion bug
  // rather than a size misjudgement, and those live in different code.
  const unitFactors = [food?.densityGPerMl ?? 1, 1 / (food?.densityGPerMl ?? 1), 28.35, 1 / 28.35, 1000, 0.001];
  if (unitFactors.some((f) => Math.abs(ratio - f) < 0.03)) return 'E5_UNIT';
  return 'E4_PORTION';
}

function wrongFoodCode(
  expGroup: string, expState: string,
  gotGroup: string | undefined, gotState: string | undefined,
): ErrorCode {
  if (expGroup === 'composite' || gotGroup === 'composite') return 'E8_COMPOSITE';
  if (expGroup === gotGroup && expState !== gotState) return 'E6_PREPARATION';
  if (expGroup === 'beverage' && gotGroup === 'beverage') return 'E7_BRAND';
  return 'E1_WRONG_FOOD';
}

/* ───────────────────────────── runner ────────────────────────────── */

export async function runCase(
  db: FoodDb,
  pipeline: Pipeline,
  testCase: GoldenCase,
  userId = `eval-${testCase.id}`,
): Promise<CaseResult> {
  const started = performance.now();
  const log = await pipeline.process(testCase.input, { userId, traceId: `eval-${testCase.id}` });
  const latencyMs = Math.round(performance.now() - started);

  const outcomes = classify(db, testCase.expected, log.items);
  const errors = outcomes.map((o) => o.errorCode).filter((c): c is ErrorCode => c !== null);

  const expKcal = expectedKcal(db, testCase.expected);
  const gotKcal = log.totals.likely.kcal;
  const kcalApe = expKcal > 0 ? Number((Math.abs(gotKcal - expKcal) / expKcal).toFixed(4)) : null;

  const matched = outcomes.filter(
    (o) => o.expectedFoodId !== null && o.expectedFoodId === o.predictedFoodId,
  ).length;
  const foodMatchRate = testCase.expected.length === 0
    ? (log.items.length === 0 ? 1 : 0)
    : Number((matched / testCase.expected.length).toFixed(4));

  const worst = log.items.reduce<LoggedItem | null>(
    (lo, cur) => (lo === null || cur.confidence.overall < lo.confidence.overall ? cur : lo),
    null,
  );

  return {
    caseId: testCase.id,
    stratum: testCase.stratum,
    probes: testCase.probes,
    passed: errors.length === 0,
    foodMatchRate,
    expectedKcal: expKcal,
    predictedKcal: gotKcal,
    kcalApe,
    kcalInInterval: expKcal >= log.totals.min.kcal && expKcal <= log.totals.max.kcal,
    confidence: worst?.confidence.overall ?? (log.items.length === 0 ? 1 : 0),
    band: worst?.confidence.band ?? 'none',
    status: log.status,
    autoLogged: log.status === 'confirmed',
    latencyMs,
    resolutionMethods: log.items.map((i) => i.resolution.method),
    outcomes,
    errors,
  };
}

/** Recomputes an item's nutrition from its own food row — the E11 audit. */
export function auditTraceability(db: FoodDb, log: MealLog): string[] {
  const problems: string[] = [];
  for (const item of log.items) {
    if (!item.foodId || !item.portion || !item.nutrition) continue;
    const food = db.byId(item.foodId);
    if (!food) {
      problems.push(`${item.id}: foodId ${item.foodId} is not in the database`);
      continue;
    }
    const recomputed = computeNutrition(food, item.portion);
    if (Math.abs(recomputed.likely.kcal - item.nutrition.likely.kcal) > 0.05) {
      problems.push(
        `${item.id}: shown ${item.nutrition.likely.kcal} kcal, database implies ${recomputed.likely.kcal}`,
      );
    }
  }
  return problems;
}
